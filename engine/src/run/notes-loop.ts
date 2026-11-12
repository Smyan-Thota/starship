/**
 * Notes in the loop: how a note to the orchestrator reaches it. (PLAN.md "Chats, repos and stages" and edge rows B1 to B13)
 *
 * A note to the orchestrator is delivered at a task boundary, or at once when the build has started and no task is
 * in a turn. Before the build starts it waits for the start. All `queued` notes go in ONE turn, in number order:
 * the notes are written to a file in `run/inbox/` and the agent gets one line that points at it.
 * The turn ends, and each note the agent acked becomes `read`; each other note is `queued` again. After 3 deliveries
 * with no ack the engine stops and the note shows under "needs you".
 *
 * Every status change goes through `nextNote` in states.ts. `state.json` keeps, for each note, the number of
 * deliveries and whether it is being read, so that Undo can say "Being read".
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Note, NoteError, hold, markRead, parseNotes, queued, undo as undoNote } from "../folder/notes.ts";
import { writeRunFile } from "../folder/write.ts";
import { hhmm } from "../time.ts";
import type { AgentEvent, AgentPort, AgentSpec, Clock } from "./ports.ts";
import { MAX_DELIVERIES, isInvalid, nextNote } from "./states.ts";
import { readRunState, updateRunState } from "./state.ts";

export interface NoteDeliveryDeps {
  agents: AgentPort;
  clock: Clock;
  chat: (chatId: string) => { featureDir: string; halted: boolean };
  /** The build's status is not `notStarted`. */
  buildStarted: (chatId: string) => boolean;
  /** A worker of the chat has a task in a turn. */
  taskInTurn: (chatId: string) => boolean;
  orchestratorSpec: (chatId: string) => AgentSpec;
  publish: (chatId: string) => void;
  /** Optional: the orchestrator is in a turn for something else, such as an ask. A delivery waits for the next boundary. */
  busy?: (chatId: string) => boolean;
}

/** A delivery in this process: the orchestrator's turn that reads the notes. */
interface Turn {
  /** True after the line was pasted. A turn end that came earlier belongs to something else. */
  sent: boolean;
  acked: Set<number>;
}

const LATER_WINS = "A later note wins over an earlier one.";

export class NoteDelivery {
  private readonly turns = new Map<string, Turn>();
  private readonly work = new Set<Promise<unknown>>();
  private readonly off: () => void;

  constructor(private readonly deps: NoteDeliveryDeps) {
    this.off = deps.agents.on((e) => this.onEvent(e));
  }

  /** Ends the subscription to agent events. */
  close(): void {
    this.off();
  }

  /** Resolves when no delivery is in flight. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.all([...this.work]);
  }

  // ───────────────────────────── when to deliver ─────────────────────────────

  /** A new note was written to handoffs.md. B1: it goes at once only when the build runs and no task is in a turn. B2: before the build it waits. */
  async recorded(chatId: string, n: number): Promise<void> {
    const note = this.notes(chatId).find((x) => x.n === n);
    if (!note || note.to !== "orchestrator" || note.status !== "queued") return;
    if (!this.mayGoAtOnce(chatId)) return;
    await this.deliver(chatId, true);
  }

  /** A task boundary, or the start of the build: every queued note goes, including one that was pasted before and not acked. */
  async boundary(chatId: string): Promise<void> {
    await this.deliver(chatId, false);
  }

  /** The chat was resumed: the notes that wait for a first delivery go when the rule allows. */
  async resumed(chatId: string): Promise<void> {
    if (!this.mayGoAtOnce(chatId)) return;
    await this.deliver(chatId, true);
  }

  /** The orchestrator ran `starship note ack <n>...`. The acks count for the turn that is running. */
  ack(chatId: string, numbers: number[]): void {
    let turn = this.turns.get(chatId);
    if (!turn) {
      // No delivery of this process: a turn that began before a restart. Its notes are in state.json.
      turn = { sent: true, acked: new Set() };
      this.turns.set(chatId, turn);
    }
    for (const n of numbers) turn.acked.add(n);
  }

  /** B9: the notes that the engine stopped delivering. */
  needsYou(chatId: string): Note[] {
    const st = readRunState(this.deps.chat(chatId).featureDir);
    return queued(this.docOf(chatId), "orchestrator").filter((n) => {
      const run = st.notes[String(n.n)];
      return (run?.deliveries ?? 0) >= MAX_DELIVERIES && !run?.reading;
    });
  }

  /** null: undone. "Being read" (B13): the note was pasted and its turn has not ended. "Already read": the orchestrator confirmed it. */
  undo(chatId: string, n: number): null | "Being read" | "Already read" {
    const dir = this.deps.chat(chatId).featureDir;
    const note = this.notes(chatId).find((x) => x.n === n);
    if (!note) throw new NoteError(`no note ${n}`);
    const run = readRunState(dir).notes[String(n)];
    const r = nextNote(note.to, note.status, "undo", { deliveries: run?.deliveries ?? 0, beingRead: run?.reading ?? false, halted: false });
    if (isInvalid(r)) {
      if (r.invalid === "Being read" || r.invalid === "Already read") return r.invalid;
      throw new NoteError(r.invalid);
    }
    writeRunFile(this.file(chatId), (old) => undoNote(old, n));
    this.safePublish(chatId);
    return null;
  }

  // ───────────────────────────── delivery ─────────────────────────────

  private mayGoAtOnce(chatId: string): boolean {
    return this.deps.buildStarted(chatId) && !this.deps.taskInTurn(chatId);
  }

  private file(chatId: string): string {
    return join(this.deps.chat(chatId).featureDir, "run", "handoffs.md");
  }

  private docOf(chatId: string) {
    const f = this.file(chatId);
    return parseNotes(existsSync(f) ? readFileSync(f, "utf8") : "");
  }

  private notes(chatId: string): Note[] {
    return this.docOf(chatId).notes;
  }

  /** The notes that may be pasted now, in number order. `fresh`: only notes that were never pasted. */
  private due(chatId: string, fresh: boolean): Note[] {
    const st = readRunState(this.deps.chat(chatId).featureDir);
    const waiting = queued(this.docOf(chatId), "orchestrator");
    // One delivery at a time: while any note is being read, nothing else is pasted.
    if (waiting.some((n) => st.notes[String(n.n)]?.reading)) return [];
    return waiting
      .filter((n) => {
        const run = st.notes[String(n.n)];
        const r = nextNote("orchestrator", "queued", "pasted", { deliveries: run?.deliveries ?? 0, beingRead: false, halted: false });
        return !isInvalid(r) && (!fresh || (run?.deliveries ?? 0) === 0);
      })
      .sort((a, b) => a.n - b.n);
  }

  private async deliver(chatId: string, fresh: boolean): Promise<void> {
    const p = this.deliverNow(chatId, fresh).finally(() => this.work.delete(p));
    this.work.add(p);
    await p;
  }

  private async deliverNow(chatId: string, fresh: boolean): Promise<void> {
    let list: Note[];
    let dir: string;
    try {
      const info = this.deps.chat(chatId);
      dir = info.featureDir;
      if (info.halted || this.deps.busy?.(chatId) || !existsSync(dir)) return;
      list = this.due(chatId, fresh);
      if (list.length === 0) return;

      // From here to the end of the turn, Undo is refused. Nothing below waits before the flags are set,
      // so an Undo that came earlier has already won and its note is not in `list`.
      updateRunState(dir, (s) => {
        for (const n of list) {
          const key = String(n.n);
          const run = s.notes[key] ?? { deliveries: 0, reading: false };
          const r = nextNote("orchestrator", "queued", "pasted", { deliveries: run.deliveries, beingRead: run.reading, halted: false });
          if (!isInvalid(r)) s.notes[key] = { deliveries: r.deliveries, reading: r.beingRead };
        }
      });
    } catch (e) {
      this.log(chatId, `delivery failed before the paste: ${(e as Error).message}`);
      return;
    }
    const turn: Turn = { sent: false, acked: new Set() };
    this.turns.set(chatId, turn);
    this.safePublish(chatId);

    try {
      const file = this.writeInbox(dir, list);
      const spec = this.deps.orchestratorSpec(chatId);
      await this.deps.agents.ensure(chatId, spec);
      await this.deps.agents.send(chatId, spec.id, this.line(list, file));
      turn.sent = true;
    } catch (e) {
      // Nothing was pasted: the notes stay queued, and this try does not count.
      this.log(chatId, `notes ${list.map((n) => n.n).join(", ")} were not delivered: ${(e as Error).message}`);
      this.turns.delete(chatId);
      try {
        updateRunState(dir, (s) => {
          for (const n of list) s.notes[String(n.n)] = { deliveries: Math.max(0, (s.notes[String(n.n)]?.deliveries ?? 1) - 1), reading: false };
        });
      } catch (err) {
        this.log(chatId, `could not undo the delivery count: ${(err as Error).message}`);
      }
      this.safePublish(chatId);
    }
  }

  private writeInbox(dir: string, list: Note[]): string {
    const inbox = join(dir, "run", "inbox");
    mkdirSync(inbox, { recursive: true });
    const nums = list.map((n) => n.n);
    const first = readRunState(dir).notes[String(nums[0])]?.deliveries ?? 1;
    const file = join(inbox, `notes-${nums.join("-")}-delivery-${first}.md`);
    const out = [
      list.length === 1 ? "# A note from the owner" : "# Notes from the owner",
      "",
      LATER_WINS,
      "",
      ...list.flatMap((n) => [`## Note ${n.n}`, "", `The owner said: ${n.said}`, `Note: ${n.note}`, ""]),
      `Change the tasks that have not started. For a note about a running task, add a follow-up task. For a note about a verified task, add a redo task that names it.`,
      `When you have read a note, run \`starship note ack ${nums.join(" ")}\`. The engine marks a note read only after that.`,
      "",
    ];
    writeFileSync(file, out.join("\n"));
    return file;
  }

  private line(list: Note[], file: string): string {
    const nums = list.map((n) => n.n);
    const what = nums.length === 1 ? `Note ${nums[0]} from the owner` : `Notes ${nums.join(", ")} from the owner`;
    return `${what} arrived. Read ${file}, act on it, then run: starship note ack ${nums.join(" ")}`.replace(/\s+/g, " ");
  }

  // ───────────────────────────── the end of the turn ─────────────────────────────

  private onEvent(e: AgentEvent): void {
    if (e.type !== "turnEnd") return;
    try {
      if (this.deps.orchestratorSpec(e.chat).id !== e.agent) return;
      const turn = this.turns.get(e.chat);
      if (turn && !turn.sent) return; // a turn end from before the paste
      this.turnEnded(e.chat, turn?.acked ?? new Set());
    } catch (err) {
      this.log(e.chat, `turn end failed: ${(err as Error).message}`);
    }
  }

  private turnEnded(chatId: string, acked: Set<number>): void {
    const dir = this.deps.chat(chatId).featureDir;
    const reading = queued(this.docOf(chatId), "orchestrator").filter((n) => readRunState(dir).notes[String(n.n)]?.reading);
    this.turns.delete(chatId);
    if (reading.length === 0) return;

    const halted = this.deps.chat(chatId).halted;
    const at = hhmm(new Date(this.deps.clock.now()));
    const results = new Map<number, { deliveries: number; beingRead: boolean }>();
    writeRunFile(this.file(chatId), (old) => {
      let cur = old;
      for (const n of reading) {
        const run = readRunState(dir).notes[String(n.n)];
        const ctx = { deliveries: run?.deliveries ?? 0, beingRead: true, halted: false };
        const r = nextNote("orchestrator", "queued", acked.has(n.n) ? "ackedTurnEnd" : "unackedTurnEnd", ctx);
        if (isInvalid(r)) continue;
        results.set(n.n, { deliveries: r.deliveries, beingRead: r.beingRead });
        try {
          if (r.status === "read") cur = markRead(cur, n.n, at);
          else if (halted) {
            // The halt came while the note was read: it applies now.
            const h = nextNote("orchestrator", "queued", "chatHalted", { deliveries: r.deliveries, beingRead: false, halted: true });
            if (!isInvalid(h) && h.status === "held") cur = hold(cur, n.n);
          }
        } catch (err) {
          this.log(chatId, `note ${n.n} changed while it was read: ${(err as Error).message}`);
        }
      }
      return cur;
    });
    updateRunState(dir, (s) => {
      for (const [n, r] of results) s.notes[String(n)] = { deliveries: r.deliveries, reading: r.beingRead };
    });
    this.safePublish(chatId);

    // A note recorded during the turn waits for no boundary when the rule lets it go now.
    // A note that was pasted and not acked waits for the next boundary, so a lost ack does not loop.
    if (!halted && this.mayGoAtOnce(chatId)) void this.deliver(chatId, true);
  }

  private log(chatId: string, text: string): void {
    try {
      const dir = join(this.deps.chat(chatId).featureDir, "run", "logs");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "notes.log"), `${new Date(this.deps.clock.now()).toISOString()} ${text}\n`);
    } catch {
      // A log that cannot be written must not stop the loop.
    }
  }

  private safePublish(chatId: string): void {
    try {
      this.deps.publish(chatId);
    } catch {
      // The window reads the state again on its own.
    }
  }
}

/**
 * The orchestrator agent's side of the engine. (ADR engine-runs-the-loop, PLAN.md "Task loop")
 *
 * `Orchestrator` does two jobs.
 *  1. It asks the agent for judgment, one ask at a time for each chat: an escalated task, a failed checkpoint,
 *     changed plan files, a fix list. Each ask is a brief file in `run/inbox/`; the agent gets one line that points at it.
 *  2. It runs `starship task add|edit|split|block|drop|retry` (`taskCommand`). It is the one writer of new task lines
 *     in TASKS.md once the build has started, and it tells the loop.
 *
 * The four ask methods are exactly what `BuildLoop` calls through its `orchestrator` dep, and what the review code calls.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type Task, type TasksDoc, addTask, editTask, findTask, nextIdInPhase, parseTasks, serialize, taskLine } from "../folder/tasks.ts";
import { writeRunFile } from "../folder/write.ts";
import type { TaskState } from "../types.ts";
import type { AgentEvent, AgentPort, AgentSpec, Clock } from "./ports.ts";
import { isInvalid, nextTask } from "./states.ts";

/** What the orchestrator needs from `BuildLoop`. A method may return false when the loop refuses. */
export interface OrchestratorLoop {
  retry(chat: string, task: string, by: "orchestrator" | "owner"): void | boolean;
  block(chat: string, task: string, reason: string): void | boolean;
  drop(chat: string, task: string, reason: string, by: "orchestrator" | "owner"): void | boolean;
  taskAdded(chat: string): void;
  undecided(chat: string, task: string): void | boolean;
  checkpointUndecided(chat: string): void;
  /** Optional: the task's line was replaced by its parts, so the loop marks the old id `dropped`. */
  split?(chat: string, task: string): void;
}

export interface OrchestratorDeps {
  agents: AgentPort;
  clock: Clock;
  chat: (chatId: string) => { featureDir: string; halted: boolean };
  spec: (chatId: string) => AgentSpec;
  loop: OrchestratorLoop;
  /** The loop's state of a task, or null when it has no entry. */
  taskState: (chatId: string, taskId: string) => string | null;
  publish: (chatId: string) => void;
}

export type TaskCommand =
  | { cmd: "add"; phase: number; text: string; files: string[]; verify?: string | null; parallel?: boolean }
  | { cmd: "edit"; id: string; text?: string; files?: string[]; verify?: string }
  | { cmd: "split"; id: string; into: string[] }
  | { cmd: "block"; id: string; reason: string }
  | { cmd: "drop"; id: string; reason: string }
  | { cmd: "retry"; id: string };

export type TaskCommandResult = { ok: true; id?: string } | { ok: false; error: string };

export interface CommandBy {
  agent: string;
  role: "orchestrator" | "admin";
}

export const NO_VERIFY = "A task needs a verify command that the engine can run";

type Ask =
  | { kind: "escalated"; task: string; tail: string }
  | { kind: "checkpoint"; phase: number; tail: string }
  | { kind: "plan"; files: string[] }
  | { kind: "fixes"; phase: number; fixes: { n: number; text: string; from: string }[] };

interface Current {
  ask: Ask;
  /** The ids of the phase's tasks when a checkpoint ask began, to see whether the turn added one. */
  before: Set<string> | null;
  /** True after the line was pasted. A turn end that came earlier belongs to something else. */
  sent: boolean;
}

/** An error whose text goes back to the caller as it is. */
class Refused extends Error {}

const oneLine = (s: string) => s.replace(/\s+/g, " ").trim();

export class Orchestrator {
  private readonly queue = new Map<string, Ask[]>();
  private readonly current = new Map<string, Current>();
  private readonly work = new Set<Promise<unknown>>();
  private seq = 0;
  private readonly off: () => void;

  constructor(private readonly deps: OrchestratorDeps) {
    this.off = deps.agents.on((e) => this.onEvent(e));
  }

  /** Ends the subscription to agent events. */
  close(): void {
    this.off();
  }

  /** True while an ask is in a turn or waits in the queue. */
  busy(chatId: string): boolean {
    return this.current.has(chatId) || (this.queue.get(chatId)?.length ?? 0) > 0;
  }

  /** Resolves when no paste is in flight. */
  async idle(): Promise<void> {
    while (this.work.size > 0) await Promise.all([...this.work]);
  }

  // ───────────────────────────── asks ─────────────────────────────

  /** A task failed its check 3 times. */
  escalated(chatId: string, taskId: string, logTail: string): void {
    this.enqueue(chatId, { kind: "escalated", task: taskId, tail: logTail });
  }

  /** A phase's checkpoint failed. */
  checkpointFailed(chatId: string, phase: number, logTail: string): void {
    this.enqueue(chatId, { kind: "checkpoint", phase, tail: logTail });
  }

  /** Plan files changed during the build. */
  planChanged(chatId: string, files: string[]): void {
    this.enqueue(chatId, { kind: "plan", files });
  }

  /** A fix list was sent. `phase` is the "Fixes" phase in TASKS.md. */
  fixList(chatId: string, phase: number, fixes: { n: number; text: string; from: string }[]): void {
    this.enqueue(chatId, { kind: "fixes", phase, fixes });
  }

  /** Starts the asks that wait, after the chat was halted. */
  resumed(chatId: string): void {
    this.pump(chatId);
  }

  private enqueue(chatId: string, ask: Ask): void {
    this.queue.set(chatId, [...(this.queue.get(chatId) ?? []), ask]);
    this.pump(chatId);
  }

  private pump(chatId: string): void {
    if (this.current.has(chatId)) return;
    const queue = this.queue.get(chatId) ?? [];
    const ask = queue[0];
    if (!ask) return;
    try {
      if (this.deps.chat(chatId).halted) return;
    } catch {
      return;
    }
    this.queue.set(chatId, queue.slice(1));
    const cur: Current = { ask, before: ask.kind === "checkpoint" ? this.phaseIds(chatId, ask.phase) : null, sent: false };
    this.current.set(chatId, cur);
    const p = this.start(chatId, cur).finally(() => this.work.delete(p));
    this.work.add(p);
  }

  private async start(chatId: string, cur: Current): Promise<void> {
    try {
      const file = this.writeBrief(chatId, cur.ask);
      const spec = this.deps.spec(chatId);
      await this.deps.agents.ensure(chatId, spec);
      await this.deps.agents.send(chatId, spec.id, this.pasteLine(cur.ask, file));
      cur.sent = true;
    } catch (e) {
      // The paste failed: the ask ends with no decision, so a task or a build never waits for an answer that cannot come.
      this.log(chatId, `ask ${cur.ask.kind} was not delivered: ${(e as Error).message}`);
      this.end(chatId);
    }
  }

  private onEvent(e: AgentEvent): void {
    if (e.type !== "turnEnd") return;
    const cur = this.current.get(e.chat);
    if (!cur?.sent) return;
    try {
      if (this.deps.spec(e.chat).id !== e.agent) return;
    } catch {
      return;
    }
    this.end(e.chat);
  }

  /** The turn of the current ask ended, or its paste failed. */
  private end(chatId: string): void {
    const cur = this.current.get(chatId);
    if (!cur) return;
    this.current.delete(chatId);
    try {
      const { ask } = cur;
      if (ask.kind === "escalated" && this.deps.taskState(chatId, ask.task) === "escalated") {
        this.deps.loop.undecided(chatId, ask.task);
      } else if (ask.kind === "checkpoint" && cur.before) {
        const now = this.phaseIds(chatId, ask.phase);
        if (now && ![...now].some((id) => !cur.before?.has(id))) this.deps.loop.checkpointUndecided(chatId);
      }
    } catch (err) {
      this.log(chatId, `ask end failed: ${(err as Error).message}`);
    }
    this.safePublish(chatId);
    this.pump(chatId);
  }

  /** The ids of the tasks of one phase, or null when TASKS.md cannot be read. */
  private phaseIds(chatId: string, phase: number): Set<string> | null {
    try {
      const doc = this.readDoc(chatId);
      return new Set((doc.phases.find((p) => p.n === phase)?.tasks ?? []).map((t) => t.id));
    } catch {
      return null;
    }
  }

  // ───────────────────────────── briefs ─────────────────────────────

  private pasteLine(ask: Ask, file: string): string {
    const what =
      ask.kind === "escalated"
        ? `Task ${ask.task} failed its check 3 times.`
        : ask.kind === "checkpoint"
          ? `The checkpoint of phase ${ask.phase} failed.`
          : ask.kind === "plan"
            ? "Plan files changed."
            : `A fix list of ${ask.fixes.length} ${ask.fixes.length === 1 ? "fix" : "fixes"} arrived.`;
    return oneLine(`${what} Read ${file} and act on it.`);
  }

  private writeBrief(chatId: string, ask: Ask): string {
    const dir = join(this.deps.chat(chatId).featureDir, "run", "inbox");
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `orchestrator-${this.deps.clock.now()}-${++this.seq}-${ask.kind}.md`);
    writeFileSync(file, this.briefText(chatId, ask));
    return file;
  }

  private briefText(chatId: string, ask: Ask): string {
    const tools = [
      '`starship task add --phase <n> --text "<text>" --files <a,b> --verify "<command>" [--parallel]`',
      '`starship task edit <id> [--text "<text>"] [--files <a,b>] [--verify "<command>"]`',
      '`starship task split <id> --into "<text 1>" "<text 2>"`',
      '`starship task block <id> --reason "<why>"`',
      '`starship task drop <id> --reason "<why>"`',
      "`starship task retry <id>`",
    ];
    const rule = "Every task needs a verify command that the engine can run. You never type to a worker and you never write a file.";
    const out: string[] = [];
    if (ask.kind === "escalated") {
      const t = this.taskText(chatId, ask.task);
      out.push(
        `# Task ${ask.task} failed its check 3 times`,
        "",
        "What happened: the worker's check failed 3 times in a quiet worktree. The engine stopped the task and asks you to decide.",
        `Task: ${ask.task}${t ? `: ${t.text}` : ""}`,
        ...(t ? [`Files: ${t.files.join(", ")}`, `Verify: ${t.verify ?? t.verifyNote}`] : []),
        "",
        "What you may do, in one turn:",
        `- Change the task with \`starship task edit ${ask.task} ...\`, then send it back with \`starship task retry ${ask.task}\`. You may send one task back only once.`,
        `- Split it with \`starship task split ${ask.task} --into "<text 1>" "<text 2>"\`.`,
        `- Block it for the owner with \`starship task block ${ask.task} --reason "<why>"\`.`,
        `- Drop it with \`starship task drop ${ask.task} --reason "<why>"\`.`,
        "A task that is still escalated when your turn ends goes to blocked.",
        "",
        "Last lines of the log:",
        "",
        ...fenced(ask.tail),
      );
    } else if (ask.kind === "checkpoint") {
      out.push(
        `# The checkpoint of phase ${ask.phase} failed`,
        "",
        "What happened: every task of the phase is verified, and the phase's checkpoint command failed.",
        "",
        "What you may do, in one turn:",
        `- Add fix tasks to the phase: \`starship task add --phase ${ask.phase} --text "<text>" --files <a,b> --verify "<command>"\`.`,
        "- When you add no task to this phase, the build stops and the owner decides.",
        "",
        "Last lines of the log:",
        "",
        ...fenced(ask.tail),
      );
    } else if (ask.kind === "plan") {
      out.push(
        "# Plan files changed",
        "",
        "What happened: these plan files changed during the build.",
        "",
        ...ask.files.map((f) => `- ${f}`),
        "",
        "What you may do, in one turn:",
        "- Read the files in the feature folder and change the tasks that have not started.",
        "- Commands:",
        ...tools.map((c) => `  - ${c}`),
      );
    } else {
      out.push(
        "# A fix list arrived",
        "",
        `What happened: the owner sent a fix list. TASKS.md has a phase ${ask.phase} for it.`,
        "",
        "Fixes:",
        "",
        ...ask.fixes.map((f) => `- Fix ${f.n} (${f.from}): ${oneLine(f.text)}`),
        "",
        "What you may do, in one turn:",
        `- Write one task for each fix: \`starship task add --phase ${ask.phase} --text "<text>" --files <a,b> --verify "<command>"\`.`,
      );
    }
    out.push("", rule, "");
    return out.join("\n");
  }

  private taskText(chatId: string, id: string): Task | undefined {
    try {
      return findTask(this.readDoc(chatId), id);
    } catch {
      return undefined;
    }
  }

  private log(chatId: string, text: string): void {
    try {
      const dir = join(this.deps.chat(chatId).featureDir, "run", "logs");
      mkdirSync(dir, { recursive: true });
      appendFileSync(join(dir, "orchestrator.log"), `${new Date(this.deps.clock.now()).toISOString()} ${text}\n`);
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

  // ───────────────────────────── task commands ─────────────────────────────

  private tasksFile(chatId: string): string {
    return join(this.deps.chat(chatId).featureDir, "TASKS.md");
  }

  private readDoc(chatId: string): TasksDoc {
    const file = this.tasksFile(chatId);
    if (!existsSync(file)) throw new Refused("TASKS.md does not exist");
    try {
      return parseTasks(readFileSync(file, "utf8"), "TASKS.md");
    } catch (e) {
      throw new Refused(`TASKS.md cannot be read: ${(e as Error).message}`);
    }
  }

  /**
   * One `starship task` command. It never throws: a refusal is `{ ok: false, error }` with one plain line.
   * The orchestrator may run all six. The admin agent may run `retry` on a blocked task and `drop`, on the owner's word.
   */
  taskCommand(chatId: string, by: CommandBy, c: TaskCommand): TaskCommandResult {
    try {
      return this.run(chatId, by, c);
    } catch (e) {
      const msg = oneLine(e instanceof Error ? e.message : String(e));
      return { ok: false, error: msg || "the command failed" };
    }
  }

  private run(chatId: string, by: CommandBy, c: TaskCommand): TaskCommandResult {
    const role: string = by.role;
    if (role !== "orchestrator" && role !== "admin") throw new Refused(`the ${role} role does not run task commands`);
    if (role === "admin" && c.cmd !== "retry" && c.cmd !== "drop") throw new Refused(`the admin agent may run only task retry and task drop, not task ${c.cmd}`);

    switch (c.cmd) {
      case "add":
        return this.add(chatId, c);
      case "edit":
        return this.edit(chatId, c);
      case "split":
        return this.split(chatId, c);
      case "block":
        return this.block(chatId, c);
      case "drop":
        return this.dropTask(chatId, role === "admin" ? "owner" : "orchestrator", c);
      case "retry":
        return this.retry(chatId, role === "admin" ? "owner" : "orchestrator", c);
      default:
        throw new Refused("unknown task command");
    }
  }

  /** The task and its state. A task with no entry in the loop is `queued`, or `verified` when its box is checked. */
  private lookup(chatId: string, id: string): { task: Task; state: TaskState } {
    const task = findTask(this.readDoc(chatId), id);
    if (!task) throw new Refused(`there is no task ${id} in TASKS.md`);
    const known = this.deps.taskState(chatId, id);
    const state = (known ?? (task.done ? "verified" : "queued")) as TaskState;
    return { task, state };
  }

  private need(text: string, what: string): string {
    const t = text.trim();
    if (!t) throw new Refused(`${what} is empty`);
    return t;
  }

  private changed(chatId: string): void {
    this.safePublish(chatId);
  }

  private add(chatId: string, c: Extract<TaskCommand, { cmd: "add" }>): TaskCommandResult {
    const verify = (c.verify ?? "").trim();
    if (!verify) throw new Refused(NO_VERIFY);
    this.need(c.text ?? "", "the task text");
    if (!c.files?.length) throw new Refused("a task must name its files");
    let id = "";
    writeRunFile(this.tasksFile(chatId), (old) => {
      const doc = parse(old);
      id = nextIdInPhase(doc, c.phase);
      return serialize(addTask(doc, c.phase, { text: c.text, files: c.files, verify, parallel: c.parallel === true, id }));
    });
    this.deps.loop.taskAdded(chatId);
    this.changed(chatId);
    return { ok: true, id };
  }

  private edit(chatId: string, c: Extract<TaskCommand, { cmd: "edit" }>): TaskCommandResult {
    const { state } = this.lookup(chatId, c.id);
    if (state !== "queued" && state !== "escalated") throw new Refused(`task ${c.id} is ${state}: only a task that has not started, or is escalated, can change`);
    const patch: { text?: string; files?: string[]; verify?: string } = {};
    if (c.text !== undefined) patch.text = this.need(c.text, "the new text");
    if (c.files !== undefined) {
      if (!c.files.length) throw new Refused("a task must name its files");
      patch.files = c.files;
    }
    if (c.verify !== undefined) {
      if (!c.verify.trim()) throw new Refused(NO_VERIFY);
      patch.verify = c.verify.trim();
    }
    if (Object.keys(patch).length === 0) throw new Refused("nothing to change: give a new text, files or verify command");
    writeRunFile(this.tasksFile(chatId), (old) => edit1(parse(old), c.id, patch));
    this.changed(chatId);
    return { ok: true };
  }

  private split(chatId: string, c: Extract<TaskCommand, { cmd: "split" }>): TaskCommandResult {
    const { state } = this.lookup(chatId, c.id);
    if (state !== "queued" && state !== "escalated") throw new Refused(`task ${c.id} is ${state}: only a task that has not started, or is escalated, can split`);
    if (!Array.isArray(c.into) || c.into.length < 2) throw new Refused("a split needs two parts or more");
    const parts = c.into.map((t) => this.need(t, "a part's text"));
    let first = "";
    writeRunFile(this.tasksFile(chatId), (old) => {
      const doc = parse(old);
      const at = findTask(doc, c.id);
      if (!at) throw new Refused(`there is no task ${c.id} in TASKS.md`);
      // The ids come from a copy that holds every part, so none repeats an id of the file.
      let probe = doc;
      const ids: string[] = [];
      for (const text of parts) {
        const id = nextIdInPhase(probe, at.phase);
        ids.push(id);
        probe = addTask(probe, at.phase, { text, files: at.files, verify: at.verify, verifyNote: partNote(at), trace: at.trace, id });
      }
      first = ids[0] ?? "";
      const lines = parts.map((text, i) =>
        taskLine(ids[i] ?? "", { text, files: at.files, verify: at.verify, verifyNote: partNote(at), trace: at.trace, parallel: i === 0 && at.parallel }),
      );
      const out = doc.lines.slice();
      out.splice(at.line - 1, 1, ...lines);
      const text = out.join("\n");
      parseTasks(text, "TASKS.md"); // a written file always parses
      return text;
    });
    this.deps.loop.split?.(chatId, c.id);
    this.deps.loop.taskAdded(chatId);
    this.changed(chatId);
    return { ok: true, id: first };
  }

  private block(chatId: string, c: Extract<TaskCommand, { cmd: "block" }>): TaskCommandResult {
    const { state } = this.lookup(chatId, c.id);
    const reason = this.need(c.reason ?? "", "the reason");
    this.mustAllow(c.id, state, "orchestratorBlock", "block");
    if (this.deps.loop.block(chatId, c.id, reason) === false) throw new Refused(`the loop refused to block task ${c.id}`);
    return { ok: true };
  }

  private dropTask(chatId: string, by: "orchestrator" | "owner", c: Extract<TaskCommand, { cmd: "drop" }>): TaskCommandResult {
    const { state } = this.lookup(chatId, c.id);
    const reason = this.need(c.reason ?? "", "the reason");
    this.mustAllow(c.id, state, by === "owner" ? "ownerDrop" : "orchestratorDrop", "drop");
    if (this.deps.loop.drop(chatId, c.id, reason, by) === false) throw new Refused(`the loop refused to drop task ${c.id}`);
    return { ok: true };
  }

  private retry(chatId: string, by: "orchestrator" | "owner", c: Extract<TaskCommand, { cmd: "retry" }>): TaskCommandResult {
    const { state } = this.lookup(chatId, c.id);
    this.mustAllow(c.id, state, by === "owner" ? "ownerRetry" : "orchestratorRetry", "retry");
    if (this.deps.loop.retry(chatId, c.id, by) === false) {
      throw new Refused(by === "owner" ? `the loop refused to retry task ${c.id}` : `task ${c.id} was sent back once already, so the orchestrator cannot send it back again`);
    }
    return { ok: true };
  }

  /** The table in states.ts says whether the command applies to the task's state. */
  private mustAllow(id: string, state: TaskState, event: "orchestratorBlock" | "orchestratorDrop" | "ownerDrop" | "orchestratorRetry" | "ownerRetry", word: string): void {
    const r = nextTask(state, event, { attempts: 0, escalations: 0 });
    if (!isInvalid(r)) return;
    const need =
      event === "ownerRetry"
        ? "a blocked task"
        : event === "orchestratorRetry" || event === "orchestratorBlock"
          ? "an escalated task"
          : event === "ownerDrop"
            ? "a queued or a blocked task"
            : "a queued or an escalated task";
    throw new Refused(`task ${id} is ${state}: task ${word} applies to ${need}`);
  }
}

function parse(text: string): TasksDoc {
  try {
    return parseTasks(text, "TASKS.md");
  } catch (e) {
    throw new Refused(`TASKS.md cannot be read: ${(e as Error).message}`);
  }
}

function edit1(doc: TasksDoc, id: string, patch: Parameters<typeof editTask>[2]): string {
  return serialize(editTask(doc, id, patch));
}

function partNote(t: Task): string {
  return t.verify !== null && t.verifyNote === "same" ? "" : t.verifyNote;
}

/** A fence longer than any run of tildes in the text, so the text cannot close it. */
function fenced(text: string): string[] {
  const longest = Math.max(2, ...[...text.matchAll(/~+/g)].map((m) => m[0].length));
  const bar = "~".repeat(longest + 1);
  return [bar, text.replace(/\n+$/, ""), bar];
}

/**
 * The conversation between the owner and the admin agent (PLAN.md, edge rows A1 to A15).
 *
 * `ChatService` takes the owner's messages, keeps them in `messages.jsonl` and `outbox.json`, and pastes them
 * into the admin agent's terminal one at a time, only when the admin agent is idle. It reads the agent's events
 * to turn a reply into a chat line. It talks to the agent only through `AgentPort` and to time only through `Clock`.
 *
 * Turn accounting: every line the service pastes starts one turn that the agent will end with one `turnEnd`.
 * `turns` holds those pastes in order, so a pickup line (A3) never answers the owner's message by mistake.
 */
import { randomUUID } from "node:crypto";
import { existsSync, mkdirSync, readFileSync, renameSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendMessage, ChatError, getChat, listChats, readMessages } from "./chats.ts";
import { paths } from "./config.ts";
import type { AgentEvent, AgentPort, AgentSpec, Clock } from "./run/ports.ts";
import { SendError } from "./run/ports.ts";
import { hhmm } from "./time.ts";
import type { EngineEvent, MessageState, MessageView } from "./types.ts";

export interface ChatServiceDeps {
  agents: AgentPort;
  publish: (e: EngineEvent) => void;
  clock: Clock;
  /** What the admin agent of a chat is started with. Its `cwd` is `adminCwd(chatId)` unless the caller decides otherwise. */
  adminSpec: (chatId: string) => AgentSpec;
  /** The files that changed in the admin agent's last turn. Used for a turn with no reply text (A9). */
  changedFiles?: (chatId: string) => string[];
}

/** A text longer than this, or with a line break, goes to a file (A5). */
const MAX_LINE = 400;
const ADMIN = "admin";

type EntryState = "queued" | "sent" | "notSent" | "interrupted";

/** One line of `outbox.json`. An owner entry stays there until its reply arrives; an engine entry until its turn ends. */
interface Entry {
  id: string;
  kind: "owner" | "engine";
  text: string;
  state: EntryState;
}

type Turn = { kind: "pickup" } | { kind: "entry"; id: string; entryKind: Entry["kind"] };

interface Runtime {
  /** Pasted lines whose turn has not ended, oldest first. */
  turns: Turn[];
  /** The owner typed in the admin's terminal and that turn has not ended. */
  terminal: boolean;
  pumping: Promise<void> | null;
  again: boolean;
  /** A new admin session got no resume: it needs the pickup line before the next message. */
  pickupDue: boolean;
}

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function writeAtomic(file: string, text: string): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, text);
  renameSync(tmp, file);
}

function outboxFile(chatId: string): string {
  return join(paths.chat(chatId), "outbox.json");
}

function isEntry(v: unknown): v is Entry {
  return (
    isObject(v) &&
    typeof v.id === "string" &&
    typeof v.text === "string" &&
    (v.kind === "owner" || v.kind === "engine") &&
    (v.state === "queued" || v.state === "sent" || v.state === "notSent" || v.state === "interrupted")
  );
}

function readOutbox(chatId: string): Entry[] {
  const file = outboxFile(chatId);
  if (!existsSync(file)) return [];
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    // A file that is not JSON is set aside, not overwritten: the owner's words may be in it.
    try {
      renameSync(file, join(paths.chat(chatId), `outbox.bad-${Date.now()}.json`));
    } catch {
      // Nothing more to do.
    }
    return [];
  }
  return Array.isArray(raw) ? raw.filter(isEntry) : [];
}

function writeOutbox(chatId: string, entries: Entry[]): void {
  writeAtomic(outboxFile(chatId), JSON.stringify(entries, null, 2) + "\n");
}

/** Changes fields of one owner message in messages.jsonl. Other lines, readable or not, stay as they are. */
function patchMessage(chatId: string, id: string, patch: Partial<MessageView>): MessageView | null {
  const file = join(paths.chat(chatId), "messages.jsonl");
  if (!existsSync(file)) return null;
  let found: MessageView | null = null;
  const out = readFileSync(file, "utf8")
    .split("\n")
    .map((line) => {
      if (found || !line.trim()) return line;
      try {
        const m: unknown = JSON.parse(line);
        if (isObject(m) && m.id === id && m.who === "you") {
          // The line has the shape of MessageView: readMessages checks the same fields.
          found = { ...(m as unknown as MessageView), ...patch };
          return JSON.stringify(found);
        }
      } catch {
        // A line that is not JSON is kept as it is.
      }
      return line;
    });
  if (found) writeAtomic(file, out.join("\n"));
  return found;
}

/** The folder the admin agent runs in: the chat's worktree, or the chat's own folder when there is none (A11). */
export function adminCwd(chatId: string): string {
  const chat = getChat(chatId);
  if (chat.worktree && existsSync(chat.worktree)) return chat.worktree;
  return paths.chat(chatId);
}

/** The folder for long messages (A5): `<featureDir>/run/inbox`, or `<home>/chats/<id>/inbox` for a chat with no feature folder. */
function inboxDir(chatId: string): string {
  const chat = getChat(chatId);
  if (chat.featureDir && existsSync(chat.featureDir) && statSync(chat.featureDir).isDirectory()) return join(chat.featureDir, "run", "inbox");
  return join(paths.chat(chatId), "inbox");
}

export class ChatService {
  private readonly runtimes = new Map<string, Runtime>();
  /** Ids of lines the engine already told the admin agent. A line is pasted once. */
  private readonly told = new Set<string>();
  private readonly off: () => void;

  constructor(private readonly deps: ChatServiceDeps) {
    this.off = deps.agents.on((e) => this.onEvent(e));
  }

  /** Ends the subscription to the agents' events. */
  dispose(): void {
    this.off();
  }

  // ---- the owner's side -------------------------------------------------------------------------------------

  /** The owner's message. It is stored before anything is pasted. The same id twice gives the first message (A6). */
  send(chatId: string, m: { id: string; text: string }): MessageView {
    const chat = getChat(chatId);
    if (typeof m.id !== "string" || !m.id.trim()) throw new ChatError("a message needs an id");
    if (typeof m.text !== "string" || !m.text.trim()) throw new ChatError("a message needs text");

    const existing = this.owned(chatId, m.id);
    if (existing) return existing;

    const entries = readOutbox(chatId);
    if (!entries.some((e) => e.id === m.id)) entries.push({ id: m.id, kind: "owner", text: m.text, state: "queued" });
    writeOutbox(chatId, entries);

    const message: MessageView = { id: m.id, who: "you", at: this.at(), stage: chat.stage, text: m.text, state: "queued" };
    appendMessage(chatId, message);
    this.deps.publish({ type: "chat", id: chatId });
    this.kick(chatId);
    return message;
  }

  /** Sends a message again. Only a `notSent` or `interrupted` message can be retried. */
  retry(chatId: string, messageId: string): MessageView {
    getChat(chatId);
    const m = this.owned(chatId, messageId);
    if (!m) throw new ChatError(`no message "${messageId}" in chat "${chatId}"`, 404);
    if (m.state !== "notSent" && m.state !== "interrupted") {
      throw new ChatError(`message "${messageId}" is ${m.state ?? "not waiting"}: only a notSent or interrupted message can be retried`);
    }
    const entries = readOutbox(chatId);
    const entry = entries.find((e) => e.id === messageId);
    if (entry) entry.state = "queued";
    else entries.push({ id: messageId, kind: "owner", text: m.text, state: "queued" });
    writeOutbox(chatId, entries);
    const next = patchMessage(chatId, messageId, { state: "queued" }) ?? { ...m, state: "queued" as MessageState };
    this.deps.publish({ type: "chat", id: chatId });
    this.kick(chatId);
    return next;
  }

  // ---- the engine's side ------------------------------------------------------------------------------------

  /**
   * A line from the engine to the admin agent, such as "Worker A asks Q3: ...". It is pasted once, when the admin agent
   * is idle and the chat is not halted. It does not show as an owner message (A15).
   */
  tellAdmin(chatId: string, id: string, line: string): void {
    getChat(chatId);
    if (typeof id !== "string" || !id.trim() || typeof line !== "string" || !line.trim()) throw new ChatError("tellAdmin needs an id and a line");
    const key = `${chatId}/${id}`;
    if (this.told.has(key)) return;
    this.told.add(key);
    const entries = readOutbox(chatId);
    if (!entries.some((e) => e.id === id)) entries.push({ id, kind: "engine", text: line, state: "queued" });
    writeOutbox(chatId, entries);
    this.kick(chatId);
  }

  /** Looks at the queue of one chat again. The engine calls it when a halt or a pause ends (A15). */
  pump(chatId: string): Promise<void> {
    const rt = this.rt(chatId);
    if (rt.pumping) {
      rt.again = true;
      return rt.pumping;
    }
    const run = (async () => {
      // The first await comes before any state change is read, so `rt.pumping` is set before this body finishes.
      await Promise.resolve();
      try {
        do {
          rt.again = false;
          for (let entry = this.next(chatId, rt); entry; entry = this.next(chatId, rt)) await this.deliver(chatId, entry, rt);
        } while (rt.again);
      } finally {
        rt.pumping = null;
      }
    })();
    rt.pumping = run;
    return run;
  }

  /** Resolves when no chat has a paste in progress. For tests and for the engine's shutdown. */
  async whenIdle(): Promise<void> {
    for (let i = 0; i < 50; i++) {
      const running = [...this.runtimes.values()].map((r) => r.pumping).filter((p): p is Promise<void> => p !== null);
      if (running.length === 0) return;
      await Promise.all(running);
    }
  }

  /**
   * At engine start (A7): a message still `queued` goes out, in order. A message that was `sent` and had no reply is
   * `interrupted`. A line from the engine that was `sent` is dropped: its question is already in questions.md.
   */
  async recover(): Promise<void> {
    // One chat whose files cannot be read or written is reported. It must not keep the other chats' messages from going out.
    for (const chat of listChats()) {
      try {
        this.recoverOne(chat);
      } catch (e) {
        console.error(`chat ${chat.id}: not recovered: ${(e as Error).message}`);
      }
    }
    await Promise.all(listChats().map((c) => this.pump(c.id).catch((e: unknown) => console.error(`chat ${c.id}: ${(e as Error).message}`))));
  }

  private recoverOne(chat: ReturnType<typeof listChats>[number]): void {
    let entries = readOutbox(chat.id);
    if (entries.length === 0) return;
    const known = new Set(readMessages(chat.id).map((m) => m.id));
    for (const e of entries) {
      if (e.kind !== "owner" || known.has(e.id)) continue;
      // The engine stopped between the outbox and the log: write the line the owner should see.
      appendMessage(chat.id, { id: e.id, who: "you", at: this.at(), stage: chat.stage, text: e.text, state: e.state });
    }
    for (const e of entries) {
      if (e.kind === "owner" && e.state === "sent") {
        e.state = "interrupted";
        patchMessage(chat.id, e.id, { state: "interrupted" });
      }
    }
    entries = entries.filter((e) => !(e.kind === "engine" && e.state !== "queued"));
    writeOutbox(chat.id, entries);
    this.deps.publish({ type: "chat", id: chat.id });
  }

  // ---- delivery ---------------------------------------------------------------------------------------------

  private rt(chatId: string): Runtime {
    let r = this.runtimes.get(chatId);
    if (!r) {
      r = { turns: [], terminal: false, pumping: null, again: false, pickupDue: false };
      this.runtimes.set(chatId, r);
    }
    return r;
  }

  /** Starts a pump in the background. A failure is logged: nothing may reject without a listener. */
  private kick(chatId: string): void {
    this.pump(chatId).catch((e) => console.error(`chat ${chatId}: ${(e as Error).message}`));
  }

  private at(): string {
    return hhmm(new Date(this.deps.clock.now()));
  }

  private owned(chatId: string, id: string): MessageView | undefined {
    return readMessages(chatId).find((m) => m.who === "you" && m.id === id);
  }

  /** The next entry to paste: nothing while the admin agent is in a turn or waits for the owner. */
  private next(chatId: string, rt: Runtime): Entry | null {
    if (rt.turns.length > 0 || rt.terminal) return null;
    const status = this.deps.agents.status(chatId, ADMIN);
    if (status === "needsYou" || status === "paused") return null;
    const halted = getChat(chatId).halted !== null;
    return readOutbox(chatId).find((e) => e.state === "queued" && (e.kind === "owner" || !halted)) ?? null;
  }

  /** One system or admin line in the chat. */
  private line(chatId: string, who: MessageView["who"], text: string, extra: Partial<MessageView> = {}): MessageView {
    const m: MessageView = { id: randomUUID(), who, at: this.at(), stage: getChat(chatId).stage, text, ...extra };
    appendMessage(chatId, m);
    this.deps.publish({ type: "chat", id: chatId });
    return m;
  }

  /** One line for `agents.send`: the text itself, or a pointer to the file that holds it (A5). */
  private toLine(chatId: string, entry: Entry): string {
    const flat = entry.text.trim();
    if (!/[\r\n]/.test(flat) && flat.length <= MAX_LINE) return flat;
    const dir = inboxDir(chatId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `${entry.id.replace(/[^A-Za-z0-9._-]/g, "_")}.md`);
    writeFileSync(file, entry.text.endsWith("\n") ? entry.text : entry.text + "\n");
    return entry.kind === "owner"
      ? `The owner sent a long message ${entry.id}. Read ${file} and answer it.`
      : `The engine sent a long note ${entry.id}. Read ${file} and act on it.`;
  }

  /** The line a new session gets when its conversation could not be resumed (A3). */
  private pickupLine(chatId: string): string {
    const chat = getChat(chatId);
    const log = join(paths.chat(chatId), "messages.jsonl");
    const where = chat.featureDir ? `the feature folder ${chat.featureDir}` : `the chat folder ${paths.chat(chatId)}`;
    return `You are a new admin agent for the chat "${chat.title}". Your earlier conversation was lost. Read ${where} and the chat log ${log} to pick up where it stands.`;
  }

  private async deliver(chatId: string, entry: Entry, rt: Runtime): Promise<void> {
    const agents = this.deps.agents;
    try {
      const status = agents.status(chatId, ADMIN);
      if (status === null || status === "starting") {
        await agents.ensure(chatId, this.deps.adminSpec(chatId));
      } else if (status === "stopped") {
        const r = await agents.restart(chatId, ADMIN);
        if (r.resumed) this.line(chatId, "system", "Admin restarted");
        else rt.pickupDue = true;
      }
      // The session waits at a question of the owner's (trust). Nothing is pasted: the entry stays queued, and the `started` event pumps again.
      if (agents.status(chatId, ADMIN) === "needsYou") return;

      if (rt.pickupDue) {
        rt.pickupDue = false;
        rt.turns.push({ kind: "pickup" });
        try {
          await agents.send(chatId, ADMIN, this.pickupLine(chatId));
        } catch (e) {
          rt.turns.pop();
          throw e;
        }
      }

      const text = this.toLine(chatId, entry);
      rt.turns.push({ kind: "entry", id: entry.id, entryKind: entry.kind });
      try {
        await agents.send(chatId, ADMIN, text);
      } catch (e) {
        const i = rt.turns.findIndex((t) => t.kind === "entry" && t.id === entry.id);
        if (i >= 0) rt.turns.splice(i, 1);
        throw e;
      }
    } catch (e) {
      this.fail(chatId, entry, e);
      return;
    }
    // A reply may have come while the paste was still being confirmed. Then the entry is gone and stays so.
    const entries = readOutbox(chatId);
    const mine = entries.find((x) => x.id === entry.id);
    if (mine && mine.state === "queued") {
      mine.state = "sent";
      writeOutbox(chatId, entries);
      if (entry.kind === "owner") patchMessage(chatId, entry.id, { state: "sent" });
      this.deps.publish({ type: "chat", id: chatId });
    }
  }

  /** The paste or the start of the session failed (A4). */
  private fail(chatId: string, entry: Entry, e: unknown): void {
    const why = e instanceof SendError ? e.message : `the admin session could not start: ${(e as Error).message}`;
    const entries = readOutbox(chatId);
    if (entry.kind === "owner") {
      const mine = entries.find((x) => x.id === entry.id);
      if (mine) mine.state = "notSent";
      writeOutbox(chatId, entries);
      patchMessage(chatId, entry.id, { state: "notSent" });
      this.deps.publish({ type: "chat", id: chatId });
      return;
    }
    // A line from the engine is not a message the owner sent. It would loop on a broken session, so it is dropped, visibly.
    writeOutbox(chatId, entries.filter((x) => x.id !== entry.id));
    this.line(chatId, "system", `The admin agent did not get: ${entry.text.slice(0, 200)} (${why})`);
  }

  // ---- the agent's events -----------------------------------------------------------------------------------

  private onEvent(e: AgentEvent): void {
    if (e.type === "usage" || e.agent !== ADMIN) return;
    try {
      switch (e.type) {
        case "turnStart":
          if (e.fromTerminal) {
            this.rt(e.chat).terminal = true;
            // The owner typed it in the terminal. The engine did not paste it, so the log gets it here (A8).
            this.line(e.chat, "you", e.prompt, { fromTerminal: true });
          }
          return;
        case "turnEnd":
          this.turnEnd(e.chat, e.reply, e.fromTerminal);
          return;
        case "needsYou":
          this.line(e.chat, "system", "Admin needs you");
          return;
        case "ended":
          this.ended(e.chat);
          return;
        case "started":
        case "signal":
          this.kick(e.chat);
          return;
        case "stalled":
          return;
      }
    } catch (err) {
      // An event for a chat that does not exist, or a file that cannot be written, must not stop the agents' listener.
      if (err instanceof ChatError && err.status === 404) return;
      console.error(`chat ${e.chat}: ${(err as Error).message}`);
    }
  }

  /** The text of a turn's reply. An empty reply is "Done" with the files that changed (A9). */
  private reply(chatId: string, text: string, extra: Partial<MessageView> = {}): void {
    if (text.trim()) {
      this.line(chatId, "admin", text, extra);
      return;
    }
    const files = this.deps.changedFiles?.(chatId);
    this.line(chatId, "admin", "Done", files ? { ...extra, files } : extra);
  }

  private turnEnd(chatId: string, reply: string, fromTerminal: boolean): void {
    const rt = this.rt(chatId);
    if (fromTerminal) {
      rt.terminal = false;
      this.reply(chatId, reply, { fromTerminal: true });
      this.kick(chatId);
      return;
    }
    const turn = rt.turns.shift();
    if (turn?.kind === "pickup") return;
    if (turn?.kind === "entry") {
      const entries = readOutbox(chatId);
      writeOutbox(chatId, entries.filter((x) => x.id !== turn.id));
      if (turn.entryKind === "owner") {
        patchMessage(chatId, turn.id, { state: "answered" });
        this.reply(chatId, reply);
      } else if (reply.trim()) {
        // The admin agent's answer to a line from the engine is worth reading. Its silence is not worth a "Done".
        this.line(chatId, "admin", reply);
      }
    } else if (reply.trim()) {
      this.line(chatId, "admin", reply);
    }
    this.deps.publish({ type: "chat", id: chatId });
    this.kick(chatId);
  }

  /** The admin session died (A13). A message that was pasted and has no reply is `interrupted`. Nothing is pasted again. */
  private ended(chatId: string): void {
    const rt = this.rt(chatId);
    const lost = rt.turns.flatMap((t) => (t.kind === "entry" ? [t] : []));
    rt.turns = [];
    rt.terminal = false;
    if (lost.length > 0) {
      let entries = readOutbox(chatId);
      for (const t of lost) {
        if (t.entryKind === "owner") {
          const mine = entries.find((x) => x.id === t.id);
          if (mine) mine.state = "interrupted";
          patchMessage(chatId, t.id, { state: "interrupted" });
        } else {
          entries = entries.filter((x) => x.id !== t.id);
        }
      }
      writeOutbox(chatId, entries);
    }
    this.deps.publish({ type: "chat", id: chatId });
    this.kick(chatId);
  }
}

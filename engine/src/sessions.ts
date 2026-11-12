/**
 * Sessions: `AgentPort` on real tmux sessions. Each agent is an unchanged Claude Code or Codex terminal.
 *
 * The engine sends a session only the start command, pasted text followed by Enter, and Escape. It never
 * presses Enter on a screen that asks something: Claude Code's trust question defaults to "No, exit", Codex's trust
 * question quits on Escape, Codex's update question defaults to an installer, and a Claude Code dialog defaults to "Yes".
 * State comes from the tools' own hooks (events.jsonl, see hooks.ts); the screen is read for readiness, for the
 * questions above, for the usage-limit message, for the stall watchdog, and for the end of a Claude Code turn: one turn
 * can give several Stop events, so a turn ends when a Stop has come and the screen is not busy in two polls in a row.
 *
 * Ready: a tool is ready only when its own classifier (claudeScreen, codexScreen) says `ready` in two polls in a row, at least
 * 500 ms apart. A question on the screen at any poll wins over everything. A bare prompt glyph is not ready: on 2026-11-11 real
 * Codex showed one between its update question and its trust question.
 * Delivery: after every paste the tool must show within about 3 seconds that it took the text. When a question is on the screen
 * instead, the paste was not delivered: the status goes back, the agent is `needsYou`, and `send` throws SendError.
 *
 * The start command is wrapped in a small shell. When the tool exits, the shell prints a marker line and waits,
 * so the last screen (the tool's own error text) can still be read. The marker is how the poll loop and
 * `ensure` see that a process ended.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";
import { claudeScreen, claudeStart, writeClaudeSettings, parseClaudeHook } from "./agents/claude.ts";
import { codexScreen, codexShows, codexStart, findCodexRollout, parseCodexNotify } from "./agents/codex.ts";
import { capture, escape, hasSession, kill, newSession, paste, shellQuote } from "./agents/tmux.ts";
import { home, paths } from "./config.ts";
import { markApplied, readNewEvents, toAgentEvents } from "./hooks.ts";
import type { NewEvent } from "./hooks.ts";
import { systemClock } from "./run/ports.ts";
import type { AgentEvent, AgentPort, AgentSpec, Clock } from "./run/ports.ts";
import { SendError } from "./run/ports.ts";
import { isInvalid, nextAgent } from "./run/states.ts";
import type { AgentEvent as StateEvent } from "./run/states.ts";
import type { AgentStatus, AgentView, Role, Tool } from "./types.ts";
import { claudeUsage, codexUsage, limitText, mergeUsage } from "./usage/read.ts";
import type { ToolUsage } from "./usage/read.ts";

export interface SessionsOptions {
  /** The argv prefix of each tool. Production: ["claude"] and ["codex"]. Tests: the fake agent. */
  bins: { claude: string[]; codex: string[] };
  /** The argv that runs hook-entry.ts, for example ["bun", "/path/to/hook-entry.ts"]. */
  hookEntry: string[];
  /** The tmux session name prefix. Default `ss-`. */
  prefix?: string;
  /** Extra environment for every session. */
  env?: Record<string, string>;
  clock?: Clock;
  /** How often the poll loop runs, and how often `ensure` looks at the screen. Default 1000. */
  pollMs?: number;
  /** D2: no hook and no screen change for this long while `working` makes the agent `stalled`. Default 10 minutes. */
  stallMs?: number;
  /** The longest `ensure` waits for the tool to be ready. Default 60000. */
  readyMs?: number;
  /** The flags that every Codex agent starts with, such as Codex's sandbox. Default: none. */
  codexArgs?: string[];
  /** The flags that every Claude Code agent starts with, after the engine's own. Default: none. */
  claudeArgs?: string[];
  /** Where Codex keeps its rollout files. Default: the `sessions` folder in the Codex home. */
  codexSessionsDir?: string;
}

/** What is kept in `<home>/chats/<chat>/agents/<agent>.json`. */
interface AgentFile {
  id: string;
  role: Role;
  tool: Tool;
  model: string;
  cwd: string;
  promptFile: string | null;
  tmux: string;
  sessionId: string | null;
  status: AgentStatus;
  lastPasted: string | null;
  error: string | null;
  need: Need | null;
}

/** Why an agent is `needsYou`: a trust question, a permission prompt, or something else (a dialog over the prompt). */
export type Need = "trust" | "permission" | "other";

/** A Claude Code Stop that waits for the screen to calm down before it counts as the end of the turn. */
interface PendingEnd {
  event: Extract<AgentEvent, { type: "turnEnd" }>;
  ev: NewEvent;
  /** Claude Code's id of the turn's prompt, when the Stop input names one. */
  promptId: string | null;
  /** How many polls in a row showed a screen that is not busy. */
  calm: number;
  /** The replies of the Stop events of this turn, oldest first: a reply that repeats the one before it, and an empty one, are left out. */
  replies: string[];
  /** Escape came while the Stop was held: the turn is cut, and the line the engine sends after Resume goes on with it. */
  interrupted: boolean;
}

interface Rec {
  chat: string;
  spec: AgentSpec;
  session: string;
  status: AgentStatus;
  sessionId: string | null;
  /** The text the engine pasted last. A prompt that differs was typed by the owner. */
  lastPasted: string | null;
  /** Whether the turn in progress began in the terminal. */
  turnFromTerminal: boolean;
  /** The line of a turn that Escape cut, until the next turn starts (see EventContext.cutLine). */
  cutLine: string | null;
  /** An automatic restart happened and no turn of the agent has ended since (D1). */
  autoRestarted: boolean;
  /** Set while a start is running, so the poll loop leaves the agent alone. */
  launching: Promise<void> | null;
  /** A start screen the owner has to answer: the trust question, or a dialog that came up at the start. The engine sends nothing there. */
  waitingStart: "trust" | "dialog" | null;
  /** The screen said so after the start: a question covers the prompt (a dialog that Escape did not close, an update question, a permission prompt). */
  waitingDialog: boolean;
  /** Polls in a row that showed `ready`, and the time of the first of them (null when the last poll was not `ready`). */
  readyPolls: number;
  readyAt: number | null;
  /** `started` went out for this start. */
  announced: boolean;
  /** The prompts of the turns that began since the last paste, from the tool's hook: what shows that the tool took a line. */
  taken: string[];
  /** Why the agent is `needsYou`. Only meaningful while it is. */
  need: Need | null;
  /** A Stop has come and the turn may go on (see the top of this file). */
  pendingEnd: PendingEnd | null;
  /** How `started` went out for this start: by the screen (the owner answered the trust question), or by the tool's hook. */
  startVia: "screen" | "hook" | null;
  /** The start question `update` got its Escape already. */
  escapedUpdate: boolean;
  /** Whether the start in progress resumes a conversation. */
  resumedStart: boolean;
  endedSeen: boolean;
  lastSignalAt: number;
  lastScreen: string;
  stalledBy: "quiet" | "limit" | null;
  limitSeen: boolean;
  error: string | null;
}

type Screen = "trust" | "dialog" | "update" | "permission" | "ready" | "busy" | "unknown";
/** The screens that ask the owner something. The engine sends nothing to them, and Enter on them would answer. */
type Question = "trust" | "dialog" | "update" | "permission";
const QUESTIONS: readonly Screen[] = ["trust", "dialog", "update", "permission"];
const isQuestion = (k: Screen): k is Question => QUESTIONS.includes(k);

/** The line the start wrapper prints when the tool's process ends. */
const MARKER = /^\[starship\] process ended \(code (-?\d+)\)\s*$/m;
const MARKER_LINES = /^\[starship\] process ended \(code -?\d+\)\s*$/;
const WRAPPER = `"$@"; code=$?; printf '\\n[starship] process ended (code %s)\\n' "$code"; sleep 30`;
const SCREEN_LINES = 60;
/** How long `send` waits after the Escape that should close a dialog, before it looks again. */
const DIALOG_WAIT_MS = 300;
/** Polls in a row with a screen that is not busy, after a Stop, before the turn ends. */
const CALM_POLLS = 2;
/** A tool is ready after this many `ready` polls in a row, the first and the last at least READY_GAP_MS apart. */
const READY_POLLS = 2;
const READY_GAP_MS = 500;
/** How long after a paste the tool may take to show that it took the text, and how often `send` looks. */
const DELIVERY_MS = 3000;
const DELIVERY_POLL_MS = 50;

const keyOf = (chat: string, agent: string) => `${chat}\n${agent}`;
const cmd = (argv: string[]) => argv.map(shellQuote).join(" ");
/** tmux changes "." and ":" in a session name, so a name that has them would never be found again. */
const safe = (s: string) => s.replace(/[.:]/g, "_");

const nonEmptyLines = (text: string) =>
  text
    .split("\n")
    .map((l) => l.trimEnd())
    .filter((l) => l !== "");

/** The tool's last words: the screen without the marker line, its last few lines. */
function errorText(screen: string): string {
  return nonEmptyLines(screen)
    .filter((l) => !MARKER_LINES.test(l))
    .slice(-8)
    .join("\n");
}

/** What a capture shows, by the tool's own classifier. There is no shortcut for a bare prompt glyph: it is not `ready`. */
function classify(tool: Tool, text: string): Screen {
  return tool === "claude" ? claudeScreen(text) : codexScreen(text);
}

const sameLine = (a: string, b: string): boolean => a.trim() === b.trim();

function writeAtomic(file: string, text: string): void {
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, text);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

const agentFile = (chat: string, agent: string) => join(paths.chat(chat), "agents", `${agent}.json`);
/** The last status line input of a Claude Code agent. `starship status` writes it (hook-entry.ts). */
const statusFile = (chat: string, agent: string) => join(paths.chat(chat), "agents", `${agent}.status.json`);

function errMessage(e: unknown): string {
  return e instanceof Error ? e.message : String(e);
}

/** The session id and whether the line shows the tool at work again, read from a hook line. */
/** The `prompt_id` of a Claude Code hook input, when it has one. */
function promptIdOf(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const id = (v as Record<string, unknown>).prompt_id; // checked just above: an object
      return typeof id === "string" && id !== "" ? id : null;
    }
  } catch {
    // an input that is not JSON has no prompt id
  }
  return null;
}

function hookFacts(ev: NewEvent): { sessionId: string; progress: boolean } | null {
  try {
    if (ev.tool === "codex") return { sessionId: parseCodexNotify(ev.raw).threadId, progress: true };
    const h = parseClaudeHook(ev.raw);
    return { sessionId: h.sessionId, progress: h.kind !== "notification" && h.kind !== "sessionEnd" };
  } catch {
    return null;
  }
}

export class Sessions implements AgentPort {
  private readonly bins: SessionsOptions["bins"];
  private readonly hookEntry: string[];
  private readonly prefix: string;
  private readonly env: Record<string, string>;
  private readonly clock: Clock;
  private readonly pollMs: number;
  private readonly stallMs: number;
  private readonly readyMs: number;
  private readonly codexArgs: string[];
  private readonly claudeArgs: string[];
  private readonly codexDir: string;

  private readonly recs = new Map<string, Rec>();
  private readonly listeners = new Set<(e: AgentEvent) => void>();
  private timer: ReturnType<typeof setInterval> | null = null;
  private readonly usage: Partial<Record<Tool, ToolUsage>> = {};
  private statusKey = "";
  private statusText = "";

  constructor(o: SessionsOptions) {
    this.bins = o.bins;
    this.hookEntry = o.hookEntry;
    this.prefix = o.prefix ?? "ss-";
    this.env = o.env ?? {};
    this.clock = o.clock ?? systemClock;
    this.pollMs = o.pollMs ?? 1000;
    this.stallMs = o.stallMs ?? 10 * 60 * 1000;
    this.readyMs = o.readyMs ?? 60_000;
    this.codexArgs = o.codexArgs ?? [];
    this.claudeArgs = o.claudeArgs ?? [];
    this.codexDir = o.codexSessionsDir ?? join(homedir(), ".codex", "sessions");
  }

  /** How long a working agent may stay quiet before it is `stalled`. */
  get stallLimitMs(): number {
    return this.stallMs;
  }

  // ---------- the port ----------

  async ensure(chat: string, spec: AgentSpec): Promise<void> {
    let rec = this.recs.get(keyOf(chat, spec.id));
    if (rec?.launching) return rec.launching;
    const name = this.sessionName(chat, spec.id);
    if (hasSession(name) && !this.hasEnded(name)) {
      // Running already: keep it. After an engine restart this is the session that `rebuild` finds.
      if (!rec) this.recs.set(keyOf(chat, spec.id), this.recFor(chat, spec, name, "idle"));
      return;
    }
    if (!rec) {
      rec = this.recFor(chat, spec, name, "starting");
      this.recs.set(keyOf(chat, spec.id), rec);
    } else {
      rec.spec = spec;
      rec.autoRestarted = false;
    }
    return this.launch(rec, null);
  }

  async send(chat: string, agent: string, line: string): Promise<void> {
    const rec = this.recs.get(keyOf(chat, agent));
    if (!rec) throw new SendError(`no agent ${agent} in chat ${chat}`);
    if (/[\r\n]/.test(line)) throw new SendError("send takes one line: the text has a line break");
    if (rec.status === "stopped") throw new SendError(`agent ${agent} is stopped`);
    // Halt holds the agent until Resume. A line pasted now would start a turn that the status never shows, and its end would turn `halted` into `idle`.
    if (rec.status === "halted") throw new SendError(`agent ${agent} is halted`);
    // A question on the screen is for the owner. Pasted text plus Enter would answer it.
    let screen = this.look(rec);
    if (screen === "dialog") {
      // Escape closes a dialog, and cancels nothing the engine started. Enter would confirm it.
      escape(rec.session);
      await Bun.sleep(DIALOG_WAIT_MS);
      screen = this.look(rec);
      if (screen === "dialog") {
        this.dialogOpen(rec);
        throw new SendError(`agent ${agent} has a dialog open that Escape does not close`);
      }
    }
    if (screen === "trust" || screen === "update") {
      this.questionSeen(rec, screen);
      throw new SendError(`agent ${agent} waits at its start screen`);
    }
    if (screen === "permission") {
      this.questionSeen(rec, screen);
      throw new SendError(`agent ${agent} shows a permission prompt`);
    }
    if (rec.waitingDialog) {
      rec.waitingDialog = false;
      if (rec.status === "needsYou") this.setStatus(rec, "idle");
    }
    const before = rec.lastPasted;
    const statusBefore = rec.status;
    rec.lastPasted = line;
    rec.taken = [];
    try {
      paste(rec.session, line);
    } catch (e) {
      rec.lastPasted = before;
      throw new SendError(errMessage(e));
    }
    rec.lastSignalAt = this.clock.now();
    this.setStatus(rec, "working");
    // The tool must show that it took the text. A question on the screen instead means it did not: Enter went to the question.
    const asked = await this.waitTaken(rec, line);
    if (asked !== null) {
      rec.lastPasted = before;
      this.setStatus(rec, statusBefore);
      this.questionSeen(rec, asked);
      throw new SendError(`agent ${agent} shows a ${asked === "trust" ? "trust question" : asked === "update" ? "update question" : asked === "permission" ? "permission prompt" : "dialog"}: the text was not taken`);
    }
  }

  /**
   * Looks for up to DELIVERY_MS for a sign that the tool took the pasted line. Claude Code: a UserPromptSubmit hook event whose
   * prompt is the line, or a busy screen. Codex: a busy screen, or the line shown above its prompt. Returns the question that
   * showed instead, or null when the tool took the line, or when neither a sign nor a question came in time (the stall watch then
   * has the agent: a line that was taken late must not be pasted twice).
   */
  private async waitTaken(rec: Rec, line: string): Promise<Question | null> {
    const end = this.clock.now() + DELIVERY_MS;
    for (;;) {
      this.guard(() => this.applyEvents(rec.chat));
      if (rec.taken.some((p) => sameLine(p, line))) return null;
      const screen = this.safeCapture(rec.session);
      if (screen === null || MARKER.test(screen)) return null; // the session ended: the poll loop sees to that
      const kind = classify(rec.spec.tool, screen);
      if (kind === "busy") return null;
      if (isQuestion(kind)) return kind;
      if (rec.spec.tool === "codex" && codexShows(screen, line)) return null;
      if (this.clock.now() >= end) return null;
      await Bun.sleep(DELIVERY_POLL_MS);
    }
  }

  async interrupt(chat: string, agent: string): Promise<void> {
    const rec = this.recs.get(keyOf(chat, agent));
    if (!rec) return;
    // Escape leaves both trust questions (Claude Code: "Esc to cancel", Codex: "esc quit"). Pause and Halt must not quit a tool that waits at one.
    if (rec.waitingStart === "trust" || this.look(rec) === "trust") return;
    // A Stop that is held belongs to a turn that Escape just cut. The turn is not over: Resume pastes a line that goes on with it.
    if (rec.pendingEnd) rec.pendingEnd.interrupted = true;
    if (rec.status === "working" || rec.pendingEnd) rec.cutLine = rec.lastPasted;
    escape(rec.session);
  }

  async restart(chat: string, agent: string, change?: { tool?: Tool; model?: string }): Promise<{ resumed: boolean }> {
    const rec = this.recs.get(keyOf(chat, agent));
    if (!rec) throw new Error(`no agent ${agent} in chat ${chat}`);
    if (rec.launching) await rec.launching.catch(() => undefined);
    const toolChanged = change?.tool !== undefined && change.tool !== rec.spec.tool;
    rec.spec = { ...rec.spec, tool: change?.tool ?? rec.spec.tool, model: change?.model ?? rec.spec.model };
    const resume = !toolChanged && rec.sessionId ? rec.sessionId : null;
    rec.autoRestarted = false;
    await this.launch(rec, resume);
    return { resumed: resume !== null };
  }

  async stop(chat: string, agent: string): Promise<void> {
    const rec = this.recs.get(keyOf(chat, agent));
    if (!rec) return;
    rec.pendingEnd = null;
    this.setStatus(rec, "stopped");
    kill(rec.session);
  }

  status(chat: string, agent: string): AgentStatus | null {
    return this.recs.get(keyOf(chat, agent))?.status ?? null;
  }

  /** Why the agent is `needsYou`: null when it is not. A `needsYou` that nothing explains is a permission. */
  need(chat: string, agent: string): Need | null {
    const rec = this.recs.get(keyOf(chat, agent));
    if (!rec || rec.status !== "needsYou") return null;
    return rec.need ?? "permission";
  }

  mark(chat: string, agent: string, status: AgentStatus): void {
    const rec = this.recs.get(keyOf(chat, agent));
    if (rec) this.setStatus(rec, status);
  }

  agents(chat: string): AgentView[] {
    const out: AgentView[] = [];
    for (const r of this.recs.values()) {
      if (r.chat !== chat) continue;
      out.push({
        id: r.spec.id,
        name: r.spec.id,
        role: r.spec.role,
        tool: r.spec.tool,
        model: r.spec.model,
        tmux: r.session,
        status: r.status,
        task: null,
        prompts: [],
        history: [],
      });
    }
    return out;
  }

  on(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => void this.listeners.delete(listener);
  }

  /**
   * G6: how full the agent's conversation is, in percent, or null when that is not known (no turn yet, no file, a file that
   * does not read). A Claude Code agent: `context_window.used_percentage` of its last status line input. A Codex agent: the
   * newest `token_count` record of its rollout.
   */
  contextPct(chat: string, agent: string): number | null {
    const rec = this.recs.get(keyOf(chat, agent));
    if (!rec) return null;
    try {
      // The time argument of the readers only stamps their result: it does not matter for the context use.
      if (rec.spec.tool === "claude") return claudeUsage(readFileSync(statusFile(chat, agent), "utf8"), 0).contextPct;
      if (!rec.sessionId) return null;
      const file = findCodexRollout(this.codexDir, rec.sessionId);
      return file ? codexUsage(readFileSync(file, "utf8"), 0).contextPct : null;
    } catch {
      return null;
    }
  }

  /** The tool's last words when the agent is `stopped`, else null. */
  error(chat: string, agent: string): string | null {
    return this.recs.get(keyOf(chat, agent))?.error ?? null;
  }

  // ---------- the loop ----------

  /** Reads the agent files and the event log (D15), then polls every `pollMs`. */
  start(): void {
    if (this.timer) return;
    this.rebuild();
    this.timer = setInterval(() => this.tick(), this.pollMs);
  }

  /** Stops the poll loop. The agents' tmux sessions keep running. */
  dispose(): void {
    if (this.timer) clearInterval(this.timer);
    this.timer = null;
    this.listeners.clear();
  }

  /**
   * D15: at engine start, or after the Mac wakes. Reads every agent file, keeps the agents whose tmux session
   * lives, marks the others `stopped`, and applies the hook events that arrived meanwhile. It sends nothing.
   */
  rebuild(): { kept: number; stopped: number } {
    for (const rec of this.loadFiles()) {
      if (!this.recs.has(keyOf(rec.chat, rec.spec.id))) this.recs.set(keyOf(rec.chat, rec.spec.id), rec);
    }
    let kept = 0;
    let stopped = 0;
    const now = this.clock.now();
    for (const rec of this.recs.values()) {
      if (rec.launching) {
        kept++;
        continue;
      }
      const alive = hasSession(rec.session);
      const screen = alive ? this.safeCapture(rec.session) : null;
      if (!alive || (screen !== null && MARKER.test(screen))) {
        if (rec.status !== "stopped") rec.error = errorText(screen ?? rec.lastScreen) || rec.error;
        if (alive) kill(rec.session);
        this.setStatus(rec, "stopped");
        stopped++;
        continue;
      }
      kept++;
      // The clock may have jumped while the Mac slept: the quiet time starts again.
      rec.lastSignalAt = now;
      if (screen !== null) rec.lastScreen = screen;
      if (rec.status === "stopped" || rec.status === "starting") this.setStatus(rec, "idle");
      // A question that waited for the owner before the engine went down still waits, or was answered meanwhile: the poll loop finds out.
      if ((screen !== null && classify(rec.spec.tool, screen) === "trust") || (rec.status === "needsYou" && rec.need === "trust")) {
        rec.waitingStart = "trust";
        this.setNeed(rec, "trust");
      } else if (rec.status === "needsYou" && rec.need === "other") {
        rec.waitingDialog = true; // the poll loop finds out whether the dialog is still open
      }
    }
    for (const chat of this.chatIds()) this.applyEvents(chat);
    return { kept, stopped };
  }

  /** Applies the hook events of one chat that are not applied yet, now. The poll loop does the same every `pollMs`. */
  applyNow(chat: string): void {
    this.guard(() => this.applyEvents(chat));
  }

  private tick(): void {
    for (const chat of this.chatIds()) this.guard(() => this.applyEvents(chat));
    for (const rec of [...this.recs.values()]) this.guard(() => this.watch(rec));
    this.guard(() => this.readClaudeStatus());
  }

  private guard(fn: () => void): void {
    try {
      fn();
    } catch (e) {
      console.error(`sessions: ${errMessage(e)}`);
    }
  }

  private chatIds(): string[] {
    return [...new Set([...this.recs.values()].map((r) => r.chat))];
  }

  /** One look at one agent: did its process end, did the screen change, is the limit message up. */
  private watch(rec: Rec): void {
    if (rec.launching || rec.status === "stopped") return;
    const screen = this.safeCapture(rec.session);
    if (screen === null) {
      if (!hasSession(rec.session)) this.died(rec, "");
      return; // tmux did not answer, but the session lives: look again next time
    }
    if (MARKER.test(screen)) {
      this.died(rec, screen);
      return;
    }
    const now = this.clock.now();
    const changed = screen !== rec.lastScreen;
    rec.lastScreen = screen;

    if (rec.pendingEnd) this.settleEnd(rec, screen);

    if (rec.waitingStart) {
      // The owner answers the trust question in the terminal. Then the agent is ready, and the engine says so.
      const kind = classify(rec.spec.tool, screen);
      if (this.readyStable(rec, kind, now)) {
        rec.waitingStart = null;
        rec.lastSignalAt = now;
        this.setStatus(rec, "idle");
        // `started` goes out once for a start. A question that came up after it was sent only holds the agent back: the loop looks again.
        if (rec.announced) this.emit({ type: "signal", chat: rec.chat, agent: rec.spec.id });
        else this.announceStart(rec, rec.resumedStart, "screen");
      } else if (kind === "update" && !rec.escapedUpdate) {
        // After the trust question Codex may ask for an update. Escape skips it. Enter would run an installer.
        rec.escapedUpdate = true;
        escape(rec.session);
      }
      return;
    }

    if (rec.waitingDialog) {
      // The owner closed the question. The agent takes text again.
      if (!isQuestion(classify(rec.spec.tool, screen))) {
        rec.waitingDialog = false;
        rec.lastSignalAt = now;
        if (rec.status === "needsYou") {
          this.setStatus(rec, "idle");
          this.emit({ type: "signal", chat: rec.chat, agent: rec.spec.id });
        }
      }
      return;
    }

    if (rec.status === "working" || rec.status === "stalled") {
      if (changed) {
        rec.lastSignalAt = now;
        if (rec.status === "stalled" && rec.stalledBy === "quiet") this.revive(rec);
      } else if (rec.status === "working" && now - rec.lastSignalAt >= this.stallMs) {
        this.step(rec, "noSignal10min");
        rec.stalledBy = "quiet";
        this.emit({ type: "stalled", chat: rec.chat, agent: rec.spec.id, reason: "quiet" });
      }
    }

    // The usage-limit message is read from the bottom of the screen only: older lines may just talk about limits.
    if (limitText(nonEmptyLines(screen).slice(-12).join("\n"))) {
      if (!rec.limitSeen) {
        rec.limitSeen = true;
        const before = rec.status;
        this.step(rec, "limitReported");
        if (rec.status === "stalled" && before !== "stalled") rec.stalledBy = "limit";
        this.emit({ type: "stalled", chat: rec.chat, agent: rec.spec.id, reason: "limit" });
      }
    } else {
      rec.limitSeen = false;
    }
  }

  private revive(rec: Rec): void {
    rec.stalledBy = null;
    this.step(rec, "signal");
    this.emit({ type: "signal", chat: rec.chat, agent: rec.spec.id });
  }

  /** D1, D5: the process ended. One automatic restart. A second end before a turn ends stays `stopped`. */
  private died(rec: Rec, screen: string): void {
    // A Stop that came before the process ended is the end of its turn.
    this.guard(() => this.flushEnd(rec));
    const text = errorText(screen !== "" ? screen : rec.lastScreen);
    try {
      kill(rec.session);
    } catch {
      // the session is gone or going: nothing to end
    }
    rec.error = text || null;
    this.setStatus(rec, "stopped");
    this.emitEnded(rec);
    if (rec.autoRestarted) {
      this.emit({
        type: "needsYou",
        chat: rec.chat,
        agent: rec.spec.id,
        reason: "other",
        message: `${rec.spec.id} ended again before a turn of it ended${text ? `: ${text}` : ""}`,
      });
      return;
    }
    rec.autoRestarted = true;
    this.launch(rec, rec.sessionId).catch((e: unknown) => {
      this.emit({ type: "needsYou", chat: rec.chat, agent: rec.spec.id, reason: "other", message: `${rec.spec.id} did not restart: ${errMessage(e)}` });
    });
  }

  private emitEnded(rec: Rec): void {
    if (rec.endedSeen) return;
    rec.endedSeen = true;
    this.emit({ type: "ended", chat: rec.chat, agent: rec.spec.id });
  }

  // ---------- hook events ----------

  private applyEvents(chat: string): void {
    for (const ev of readNewEvents(chat)) {
      try {
        this.applyOne(chat, ev);
      } catch (e) {
        console.error(`sessions: event ${ev.line} of ${chat}: ${errMessage(e)}`);
      } finally {
        markApplied(chat, ev.line); // each line is applied once, also when it failed
      }
    }
  }

  private applyOne(chat: string, ev: NewEvent): void {
    const rec = this.recs.get(keyOf(chat, ev.agent));
    // A line of the tool that this agent had before a change of tool: its hook ran late. It says nothing about the new session.
    if (rec && ev.tool !== rec.spec.tool) return;
    const facts = hookFacts(ev);
    const events = toAgentEvents(ev, { chat, lastPasted: rec?.lastPasted ?? null, fromTerminal: rec?.turnFromTerminal ?? false, cutLine: rec?.cutLine ?? null });
    if (rec && events.some((e) => e.type === "turnStart")) rec.cutLine = null; // the next turn has begun: it was the one after Escape
    if (rec) {
      rec.lastSignalAt = this.clock.now();
      if (facts?.sessionId && facts.sessionId !== rec.sessionId) {
        rec.sessionId = facts.sessionId;
        this.save(rec);
      }
      if (rec.status === "stalled") this.revive(rec);
      // A permission is answered in the terminal. The next sign of work after the question means it was answered.
      else if (rec.status === "needsYou" && !rec.waitingStart && facts?.progress) this.step(rec, "permissionGiven");
    }
    for (const e of events) {
      if (rec && e.type === "turnStart") rec.taken = [...rec.taken, e.prompt].slice(-20);
      if (rec && e.type === "started" && rec.startVia === "screen") {
        // The owner's answer to the trust question already gave `started`. The tool's own hook is the same start.
        rec.startVia = "hook";
        continue;
      }
      if (rec && e.type === "turnEnd" && ev.tool === "claude") {
        this.holdEnd(rec, e, ev);
        continue;
      }
      if (rec && e.type === "turnStart" && rec.pendingEnd) {
        const same = promptIdOf(ev.raw) !== null && promptIdOf(ev.raw) === rec.pendingEnd.promptId;
        if (same) continue; // a prompt of the turn that has not ended: not a new turn
        // The line that the engine pasted after Pause or Halt goes on with the turn that Escape cut. A line the owner typed is a new turn.
        if (!(rec.pendingEnd.interrupted && !e.fromTerminal)) this.flushEnd(rec); // a new prompt: the turn before it is over
      }
      if (rec) this.track(rec, e, ev);
      this.emit(e);
    }
  }

  // ---------- the end of a Claude Code turn ----------

  /**
   * A Stop: the turn ends when the screen is not busy in two polls in a row. A later Stop of the same turn adds its reply to
   * this one: the turn's reply is every distinct reply, in order.
   */
  private holdEnd(rec: Rec, e: Extract<AgentEvent, { type: "turnEnd" }>, ev: NewEvent): void {
    const promptId = promptIdOf(ev.raw);
    let old = rec.pendingEnd;
    // A Stop of another prompt: the turn before it ended on its own, unless Escape cut that turn and this is the line after Resume.
    if (old && !old.interrupted && old.promptId !== null && promptId !== null && old.promptId !== promptId) {
      this.flushEnd(rec);
      old = null;
    }
    const replies = old ? [...old.replies] : [];
    const text = e.reply.trim() === "" ? "" : e.reply;
    if (text !== "" && replies[replies.length - 1] !== text) replies.push(text);
    rec.pendingEnd = { event: e, ev, promptId, calm: 0, replies, interrupted: old?.interrupted ?? false };
  }

  private settleEnd(rec: Rec, screen: string): void {
    const pend = rec.pendingEnd;
    if (!pend) return;
    // A paused or halted agent has a cut turn, not a finished one: it ends after Resume.
    if (pend.interrupted && (rec.status === "paused" || rec.status === "halted")) {
      pend.calm = 0;
      return;
    }
    pend.calm = classify(rec.spec.tool, screen) === "busy" ? 0 : pend.calm + 1;
    if (pend.calm >= CALM_POLLS) this.flushEnd(rec);
  }

  /** The held Stop is the end of the turn now: ONE `turnEnd`, with the replies of all the Stops of the turn. */
  private flushEnd(rec: Rec): void {
    const pend = rec.pendingEnd;
    if (!pend) return;
    rec.pendingEnd = null;
    const end = { ...pend.event, reply: pend.replies.join("\n\n") };
    this.track(rec, end, pend.ev);
    this.emit(end);
  }

  /** What an event does to the agent's status and bookkeeping. */
  private track(rec: Rec, e: AgentEvent, ev: NewEvent): void {
    switch (e.type) {
      case "started": {
        rec.announced = true;
        const waiting = rec.waitingStart !== null;
        rec.waitingStart = null;
        rec.endedSeen = false;
        if (waiting) this.setStatus(rec, "idle");
        else this.step(rec, "started");
        return;
      }
      case "turnStart":
        rec.turnFromTerminal = e.fromTerminal;
        this.step(rec, "turnStart");
        return;
      case "turnEnd":
        rec.autoRestarted = false;
        this.step(rec, "turnEnd");
        if (ev.tool === "codex") this.guard(() => this.readCodexUsage(rec));
        return;
      case "needsYou":
        this.step(rec, "needsPermission");
        if (rec.status === "needsYou") this.setNeed(rec, "permission");
        return;
      case "ended":
        rec.endedSeen = true;
        return;
      default:
        return;
    }
  }

  // ---------- usage ----------

  private readClaudeStatus(): void {
    const file = join(home(), "usage", "claude-status.json");
    let key: string;
    try {
      const st = statSync(file);
      key = `${st.mtimeMs}:${st.size}`;
    } catch {
      return;
    }
    if (key === this.statusKey) return;
    this.statusKey = key;
    const text = readFileSync(file, "utf8");
    if (text === this.statusText) return;
    this.statusText = text;
    this.emitUsage(claudeUsage(text, Math.floor(this.clock.now() / 1000)));
  }

  private readCodexUsage(rec: Rec): void {
    if (!rec.sessionId) return;
    const file = findCodexRollout(this.codexDir, rec.sessionId);
    if (!file) return;
    this.emitUsage(codexUsage(readFileSync(file, "utf8"), Math.floor(this.clock.now() / 1000)));
  }

  private emitUsage(u: ToolUsage): void {
    const merged = mergeUsage(this.usage[u.tool] ?? null, u);
    this.usage[u.tool] = merged;
    this.emit({ type: "usage", tool: u.tool, usage: merged });
  }

  // ---------- starting ----------

  private sessionName(chat: string, agent: string): string {
    return safe(`${this.prefix}${chat}-${agent}`);
  }

  private recFor(chat: string, spec: AgentSpec, session: string, status: AgentStatus): Rec {
    return {
      chat,
      spec,
      session,
      status,
      sessionId: null,
      lastPasted: null,
      turnFromTerminal: false,
      cutLine: null,
      autoRestarted: false,
      launching: null,
      waitingStart: null,
      waitingDialog: false,
      readyPolls: 0,
      readyAt: null,
      announced: false,
      taken: [],
      need: null,
      pendingEnd: null,
      startVia: null,
      escapedUpdate: false,
      resumedStart: false,
      endedSeen: false,
      lastSignalAt: this.clock.now(),
      lastScreen: "",
      stalledBy: null,
      limitSeen: false,
      error: null,
    };
  }

  /** Starts the session, and waits until the tool is ready. `resume` is the tool's own session id, or null for a new session. */
  private launch(rec: Rec, resume: string | null): Promise<void> {
    const p: Promise<void> = this.doLaunch(rec, resume).finally(() => {
      if (rec.launching === p) rec.launching = null;
    });
    rec.launching = p;
    return p;
  }

  private async doLaunch(rec: Rec, resume: string | null): Promise<void> {
    kill(rec.session); // a session that is left over, such as the wrapper after the tool ended
    this.setStatus(rec, "starting");
    rec.error = null;
    rec.waitingStart = null;
    rec.waitingDialog = false;
    rec.readyPolls = 0;
    rec.readyAt = null;
    rec.announced = false;
    rec.taken = [];
    rec.need = null;
    rec.pendingEnd = null;
    rec.startVia = null;
    rec.escapedUpdate = false;
    rec.resumedStart = resume !== null;
    rec.endedSeen = false;
    rec.stalledBy = null;
    rec.limitSeen = false;
    rec.turnFromTerminal = false;
    rec.cutLine = null;
    rec.lastScreen = "";
    rec.lastSignalAt = this.clock.now();
    if (resume === null) {
      rec.sessionId = null;
      // A new conversation is empty: the context use of the old one must not count for it.
      rmSync(statusFile(rec.chat, rec.spec.id), { force: true });
    }
    try {
      newSession({
        name: rec.session,
        cwd: rec.spec.cwd,
        command: ["sh", "-c", WRAPPER, "sh", ...this.argvFor(rec, resume)],
        env: { ...this.env, STARSHIP_CHAT: rec.chat, STARSHIP_AGENT: rec.spec.id, STARSHIP_HOME: home() },
      });
    } catch (e) {
      rec.error = errMessage(e);
      this.setStatus(rec, "stopped");
      throw e;
    }
    this.save(rec);
    await this.waitReady(rec, resume !== null);
  }

  /** The tool's argv. For Claude Code it also writes the per-session settings file. */
  private argvFor(rec: Rec, resume: string | null): string[] {
    const { spec } = rec;
    if (spec.tool === "claude") {
      const settingsPath = join(paths.chat(rec.chat), "agents", `${spec.id}.settings.json`);
      writeClaudeSettings(settingsPath, {
        hookCommand: cmd([...this.hookEntry, "hook", "claude"]),
        statusCommand: cmd([...this.hookEntry, "status"]),
      });
      const a = claudeStart({ settingsPath, promptFile: spec.promptFile ?? undefined, model: spec.model || undefined, resume: resume ?? undefined, extra: this.claudeArgs });
      return [...this.bins.claude, ...a.slice(1)];
    }
    const a = codexStart({ cwd: spec.cwd, notify: [...this.hookEntry, "hook", "codex"], model: spec.model || undefined, resume: resume ?? undefined, extra: this.codexArgs });
    return [...this.bins.codex, ...a.slice(1)];
  }

  /** Watches the screen until the tool is ready. On the trust question it stops and sends nothing. */
  private async waitReady(rec: Rec, resumed: boolean): Promise<void> {
    const deadline = this.clock.now() + this.readyMs;
    let escaped = false;
    for (;;) {
      // Claude Code's SessionStart hook may have said so already.
      if (rec.status !== "starting") return;
      const screen = this.safeCapture(rec.session);
      if (screen === null) {
        if (!hasSession(rec.session)) throw this.failStart(rec, "", "the session ended");
      } else {
        if (MARKER.test(screen)) throw this.failStart(rec, screen, "the tool ended");
        rec.lastScreen = screen;
        const kind = classify(rec.spec.tool, screen);
        const stable = this.readyStable(rec, kind, this.clock.now());
        if (kind === "trust") {
          // Claude Code's question defaults to "No, exit" and Codex's quits on Escape: the owner answers, the engine sends nothing.
          rec.waitingStart = "trust";
          this.setNeed(rec, "trust");
          this.emit({ type: "needsYou", chat: rec.chat, agent: rec.spec.id, reason: "trust", message: `${rec.spec.id} asks whether to trust this folder` });
          return;
        }
        if (kind === "dialog") {
          // A dialog at the start (for example Claude Code's question about the folder's MCP servers). Its default answer is "Yes", and
          // Escape may answer it too: the owner does. The tool is not dead, so it must not be ended after readyMs.
          rec.waitingStart = "dialog";
          this.setNeed(rec, "other");
          this.emit({ type: "needsYou", chat: rec.chat, agent: rec.spec.id, reason: "other", message: `${rec.spec.id} has a dialog open at its start` });
          return;
        }
        if (kind === "update") {
          // Escape skips the update question. Enter would run an installer.
          if (!escaped) {
            escape(rec.session);
            escaped = true;
          }
        } else if (stable) {
          this.setStatus(rec, "idle");
          // Claude Code reports its start by hook. Codex has no start hook.
          if (rec.spec.tool === "codex") this.announceStart(rec, resumed, "screen");
          return;
        }
      }
      if (this.clock.now() >= deadline) throw this.failStart(rec, screen ?? "", `not ready after ${this.readyMs} ms`);
      await Bun.sleep(this.pollMs);
    }
  }

  /** D13: the tool did not start. The status is `stopped` and the tool's own text is kept. */
  private failStart(rec: Rec, screen: string, why: string): Error {
    const text = errorText(screen !== "" ? screen : rec.lastScreen);
    try {
      kill(rec.session);
    } catch {
      // already gone
    }
    rec.error = text || why;
    this.setStatus(rec, "stopped");
    this.emitEnded(rec);
    return new Error(`${rec.spec.tool} did not start (${why})${text ? `:\n${text}` : ""}`);
  }

  // ---------- small helpers ----------

  /** `started` goes out once for a start that the screen saw. */
  private announceStart(rec: Rec, resumed: boolean, via: "screen" | "hook"): void {
    rec.startVia = via;
    rec.announced = true;
    this.emit({ type: "started", chat: rec.chat, agent: rec.spec.id, resumed });
  }

  /** One poll's `ready`: true when the screen was `ready` in READY_POLLS polls in a row, the first and this one READY_GAP_MS apart. */
  private readyStable(rec: Rec, kind: Screen, now: number): boolean {
    if (kind !== "ready") {
      rec.readyPolls = 0;
      rec.readyAt = null;
      return false;
    }
    rec.readyAt ??= now;
    rec.readyPolls++;
    return rec.readyPolls >= READY_POLLS && now - rec.readyAt >= READY_GAP_MS;
  }

  /**
   * A question is on the screen. The agent is `needsYou` with the matching reason, and the owner is told once. The engine sends
   * nothing more: the owner answers in the terminal, and the poll loop sees the question go.
   */
  private questionSeen(rec: Rec, q: Question): void {
    const id = rec.spec.id;
    if (q === "dialog") {
      this.dialogOpen(rec);
      return;
    }
    if (q === "trust") {
      const again = rec.waitingStart === "trust" && rec.status === "needsYou";
      rec.waitingStart = "trust";
      this.setNeed(rec, "trust");
      if (!again) this.emit({ type: "needsYou", chat: rec.chat, agent: id, reason: "trust", message: `${id} asks whether to trust this folder` });
      return;
    }
    const reason = q === "permission" ? "permission" : "other";
    const again = rec.waitingDialog && rec.status === "needsYou" && rec.need === reason;
    rec.waitingDialog = true;
    this.setNeed(rec, reason);
    if (!again) this.emit({ type: "needsYou", chat: rec.chat, agent: id, reason, message: q === "permission" ? `${id} asks for a permission` : `${id} shows an update question` });
  }

  /** The agent waits for the owner, and this is why. */
  private setNeed(rec: Rec, need: Need): void {
    rec.need = need;
    this.setStatus(rec, "needsYou");
    this.save(rec); // the status may not have changed, but the reason did
  }

  /** A dialog covers the prompt and Escape did not close it: nothing is sent, and the owner is told once. */
  private dialogOpen(rec: Rec): void {
    const first = !rec.waitingDialog;
    rec.waitingDialog = true;
    this.setNeed(rec, "other");
    if (first) this.emit({ type: "needsYou", chat: rec.chat, agent: rec.spec.id, reason: "other", message: `${rec.spec.id} has a dialog open` });
  }

  private look(rec: Rec): Screen {
    const screen = this.safeCapture(rec.session);
    return screen === null ? "unknown" : classify(rec.spec.tool, screen);
  }

  private hasEnded(name: string): boolean {
    const screen = this.safeCapture(name);
    return screen !== null && MARKER.test(screen);
  }

  private safeCapture(name: string): string | null {
    try {
      return capture(name, SCREEN_LINES);
    } catch {
      return null;
    }
  }

  /** A status change by the agent table. A pair the table does not allow changes nothing. */
  private step(rec: Rec, event: StateEvent): void {
    const r = nextAgent(rec.status, event);
    if (!isInvalid(r)) this.setStatus(rec, r.state);
  }

  private setStatus(rec: Rec, status: AgentStatus): void {
    if (rec.status === status) return;
    rec.status = status;
    if (status !== "stalled") rec.stalledBy = null;
    if (status !== "needsYou") rec.need = null;
    this.save(rec);
  }

  private emit(e: AgentEvent): void {
    for (const l of [...this.listeners]) {
      try {
        l(e);
      } catch (err) {
        console.error(`sessions: a listener threw: ${errMessage(err)}`);
      }
    }
  }

  private save(rec: Rec): void {
    const f: AgentFile = {
      id: rec.spec.id,
      role: rec.spec.role,
      tool: rec.spec.tool,
      model: rec.spec.model,
      cwd: rec.spec.cwd,
      promptFile: rec.spec.promptFile,
      tmux: rec.session,
      sessionId: rec.sessionId,
      status: rec.status,
      lastPasted: rec.lastPasted,
      error: rec.error,
      need: rec.need,
    };
    writeAtomic(agentFile(rec.chat, rec.spec.id), `${JSON.stringify(f, null, 2)}\n`);
  }

  /** Every agent file under `<home>/chats/*\/agents`. A file that cannot be read is skipped. */
  private loadFiles(): Rec[] {
    const out: Rec[] = [];
    let chats: string[];
    try {
      chats = readdirSync(paths.chats()).sort();
    } catch {
      return out;
    }
    for (const chat of chats) {
      const dir = join(paths.chat(chat), "agents");
      if (!existsSync(dir)) continue;
      for (const name of readdirSync(dir).sort()) {
        if (!name.endsWith(".json") || name.endsWith(".settings.json") || name.endsWith(".status.json")) continue;
        try {
          const f = JSON.parse(readFileSync(join(dir, name), "utf8")) as Partial<AgentFile>; // fields are checked below
          if (typeof f.id !== "string" || typeof f.tmux !== "string" || typeof f.cwd !== "string" || typeof f.model !== "string") continue;
          if (f.tool !== "claude" && f.tool !== "codex") continue;
          if (typeof f.role !== "string") continue;
          const spec: AgentSpec = { id: f.id, role: f.role, tool: f.tool, model: f.model, cwd: f.cwd, promptFile: typeof f.promptFile === "string" ? f.promptFile : null };
          const rec = this.recFor(chat, spec, f.tmux, typeof f.status === "string" ? f.status : "stopped");
          rec.sessionId = typeof f.sessionId === "string" ? f.sessionId : null;
          rec.lastPasted = typeof f.lastPasted === "string" ? f.lastPasted : null;
          rec.error = typeof f.error === "string" ? f.error : null;
          rec.need = f.need === "trust" || f.need === "permission" || f.need === "other" ? f.need : null;
          out.push(rec);
        } catch {
          // a broken agent file: the agent is not rebuilt
        }
      }
    }
    return out;
  }
}

/**
 * The hook receiver and the event log.
 *
 * A tool runs `hook-entry.ts` as its hook. That program calls `appendHookEvent`, which adds one line to
 * `<home>/chats/<chat>/events.jsonl` and needs no running engine (D18). The engine reads the lines it has
 * not applied yet with `readNewEvents`, and records how far it got with `markApplied`. The count lives in
 * `events.applied`, so a line is applied once, also after an engine restart.
 *
 * `toAgentEvents` turns one logged line into the engine's own events.
 */
import { appendFileSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "./config.ts";
import { parseClaudeHook } from "./agents/claude.ts";
import { parseCodexNotify } from "./agents/codex.ts";
import type { AgentEvent } from "./run/ports.ts";

export type HookTool = "claude" | "codex";

export interface HookInput {
  agent: string;
  tool: HookTool;
  /** The tool's own text, as it came in: the hook JSON on stdin (Claude Code) or the notify argument (Codex). */
  raw: string;
}

export interface LoggedEvent extends HookInput {
  /** Epoch milliseconds, when the hook ran. */
  at: number;
}

export interface NewEvent extends LoggedEvent {
  /** The 1-based number of this line in events.jsonl. Pass it to `markApplied`. */
  line: number;
}

const eventsFile = (chatId: string) => join(paths.chat(chatId), "events.jsonl");
const appliedFile = (chatId: string) => join(paths.chat(chatId), "events.applied");

/** Appends ONE line to the chat's event log. One write in append mode, so lines of two hooks never mix. */
export function appendHookEvent(chatId: string, e: HookInput): void {
  mkdirSync(paths.chat(chatId), { recursive: true });
  const row: LoggedEvent = { at: Date.now(), agent: e.agent, tool: e.tool, raw: e.raw };
  appendFileSync(eventsFile(chatId), `${JSON.stringify(row)}\n`, { flag: "a" });
}

/** How many lines of events.jsonl the engine has applied. A missing or unreadable file counts as 0. */
export function appliedCount(chatId: string): number {
  try {
    const n = Number.parseInt(readFileSync(appliedFile(chatId), "utf8").trim(), 10);
    return Number.isInteger(n) && n > 0 ? n : 0;
  } catch {
    return 0;
  }
}

function asEvent(text: string): LoggedEvent | null {
  let v: unknown;
  try {
    v = JSON.parse(text);
  } catch {
    return null;
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) return null;
  const o = v as Record<string, unknown>; // checked just above: a non-null, non-array object
  if (typeof o.at !== "number" || typeof o.agent !== "string" || typeof o.raw !== "string") return null;
  if (o.tool !== "claude" && o.tool !== "codex") return null;
  return { at: o.at, agent: o.agent, tool: o.tool, raw: o.raw };
}

/**
 * The lines after the applied count. A line that is not a valid event is skipped, and it counts as a line,
 * so the numbers stay true. A last line with no newline is a write in progress: it waits for the next read.
 */
export function readNewEvents(chatId: string): NewEvent[] {
  let text: string;
  try {
    text = readFileSync(eventsFile(chatId), "utf8");
  } catch {
    return [];
  }
  const lines = text.split("\n");
  lines.pop(); // text after the last newline: "" when the file ends with one, else an unfinished line
  const out: NewEvent[] = [];
  for (let i = appliedCount(chatId); i < lines.length; i++) {
    const e = asEvent(lines[i] ?? "");
    if (e) out.push({ ...e, line: i + 1 });
  }
  return out;
}

/** Records that lines 1..`line` are applied. The count never goes down. */
export function markApplied(chatId: string, line: number): void {
  if (line <= appliedCount(chatId)) return;
  const file = appliedFile(chatId);
  mkdirSync(paths.chat(chatId), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${line}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

export interface EventContext {
  chat: string;
  /** The text the engine pasted last into this agent. A prompt that differs was typed by the owner. */
  lastPasted: string | null;
  /** For a Claude Code Stop: whether the turn that ends began in the terminal. The Stop input does not say. */
  fromTerminal?: boolean;
  /**
   * The line of a turn that Escape cut (Pause, Halt), until the next turn starts. The tool may keep that line in its input box, so
   * the line that the engine pastes after Resume joins it: the prompt then holds the cut line, and it is still the engine's.
   */
  cutLine?: string | null;
}

/** Claude Code notification types that do not ask the owner for anything. */
const QUIET_NOTIFICATIONS = new Set(["idle_prompt", "auth_success"]);

const sameText = (a: string, b: string | null): boolean => b !== null && a.trim() === b.trim();

/** Whether the prompt is a line that the engine pasted: exactly the last one, or one that joined the line Escape cut. */
const pastedByEngine = (prompt: string, ctx: EventContext): boolean => {
  if (sameText(prompt, ctx.lastPasted)) return true;
  const cut = ctx.cutLine?.trim() ?? "";
  return cut !== "" && prompt.includes(cut);
};

function notificationType(raw: string): string | null {
  try {
    const v: unknown = JSON.parse(raw);
    if (typeof v === "object" && v !== null && !Array.isArray(v)) {
      const t = (v as Record<string, unknown>).notification_type; // checked just above: an object
      return typeof t === "string" ? t : null;
    }
  } catch {
    // parseClaudeHook reports a broken input
  }
  return null;
}

/**
 * One logged line as the engine's events. An input the tool adapter cannot read gives no events.
 * Claude Code: SessionStart is `started`, UserPromptSubmit `turnStart`, Stop `turnEnd`, Notification `needsYou`
 * (permission), SessionEnd `ended`. PreToolUse gives nothing: it is only a sign of life.
 * Codex notify gives a `turnStart` and then a `turnEnd`, because Codex reports a turn only when it ends.
 */
export function toAgentEvents(e: HookInput, ctx: EventContext): AgentEvent[] {
  const { chat } = ctx;
  const agent = e.agent;
  try {
    if (e.tool === "claude") {
      const h = parseClaudeHook(e.raw);
      switch (h.kind) {
        case "sessionStart":
          return [{ type: "started", chat, agent, resumed: h.source === "resume" }];
        case "promptSubmit": {
          const prompt = h.prompt ?? "";
          return [{ type: "turnStart", chat, agent, prompt, fromTerminal: !pastedByEngine(prompt, ctx) }];
        }
        case "turnEnd":
          return [{ type: "turnEnd", chat, agent, reply: h.reply ?? "", fromTerminal: ctx.fromTerminal ?? false }];
        case "notification": {
          const kind = notificationType(e.raw);
          if (kind !== null && QUIET_NOTIFICATIONS.has(kind)) return [];
          return [{ type: "needsYou", chat, agent, reason: "permission", message: h.message ?? "" }];
        }
        case "sessionEnd":
          return [{ type: "ended", chat, agent }];
        case "toolUse":
          return [];
      }
    }
    const n = parseCodexNotify(e.raw);
    const prompt = n.inputs[n.inputs.length - 1] ?? "";
    const fromTerminal = !pastedByEngine(prompt, ctx);
    return [
      { type: "turnStart", chat, agent, prompt, fromTerminal },
      { type: "turnEnd", chat, agent, reply: n.reply, fromTerminal },
    ];
  } catch {
    return [];
  }
}

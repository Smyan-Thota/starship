/**
 * Claude Code adapter: pure functions. The start argv, the per-session settings, and readers for what the
 * tool sends back (hook input, status line input, transcript, screen). Nothing here starts a process or
 * writes outside the path the caller passes in.
 */
import { mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";

export interface ClaudeStartOptions {
  bin?: string;
  settingsPath: string;
  promptFile?: string;
  model?: string;
  permissionMode?: string;
  sessionId?: string;
  resume?: string;
  /** More flags, from the config (`claudeArgs`). They come last. */
  extra?: string[];
}

export function claudeStart(o: ClaudeStartOptions): string[] {
  if (o.sessionId && o.resume) throw new Error("claudeStart: give a session id or resume, not both");
  const argv = [o.bin ?? "claude", "--settings", o.settingsPath];
  if (o.promptFile) argv.push("--append-system-prompt-file", o.promptFile);
  if (o.model) argv.push("--model", o.model);
  if (o.permissionMode) argv.push("--permission-mode", o.permissionMode);
  if (o.sessionId) argv.push("--session-id", o.sessionId);
  if (o.resume) argv.push("--resume", o.resume);
  if (o.extra) argv.push(...o.extra);
  return argv;
}

export interface ClaudeSettingsOptions {
  hookCommand: string;
  statusCommand: string;
}

const HOOK_EVENTS = ["SessionStart", "UserPromptSubmit", "Stop", "Notification", "SessionEnd", "PreToolUse"] as const;

export function claudeSettings(o: ClaudeSettingsOptions): object {
  const hooks: Record<string, object[]> = {};
  for (const event of HOOK_EVENTS) {
    const entry: { matcher?: string; hooks: { type: "command"; command: string }[] } = {
      hooks: [{ type: "command", command: o.hookCommand }],
    };
    if (event === "PreToolUse") entry.matcher = "*";
    hooks[event] = [entry];
  }
  return { hooks, statusLine: { type: "command", command: o.statusCommand } };
}

/** Writes the settings file atomically (temp file in the same folder, then rename) with mode 0600. */
export function writeClaudeSettings(path: string, o: ClaudeSettingsOptions): void {
  const dir = dirname(path);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.settings-${process.pid}-${Date.now()}.tmp`);
  try {
    writeFileSync(tmp, JSON.stringify(claudeSettings(o), null, 2) + "\n", { mode: 0o600 });
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
}

// ---------- hooks ----------

export type ClaudeHookKind = "sessionStart" | "promptSubmit" | "turnEnd" | "notification" | "toolUse" | "sessionEnd";

export interface ClaudeHook {
  kind: ClaudeHookKind;
  sessionId: string;
  transcriptPath: string;
  cwd: string;
  source?: "startup" | "resume" | string;
  prompt?: string;
  reply?: string;
  permissionMode?: string;
  tool?: { name: string; input: unknown; id?: string };
  backgroundTasks: number;
  message?: string;
}

const KINDS: Record<string, ClaudeHookKind> = {
  SessionStart: "sessionStart",
  UserPromptSubmit: "promptSubmit",
  Stop: "turnEnd",
  Notification: "notification",
  SessionEnd: "sessionEnd",
  PreToolUse: "toolUse",
};

type Json = Record<string, unknown>;

function parseObject(raw: string, what: string): Json {
  let v: unknown;
  try {
    v = JSON.parse(raw);
  } catch {
    throw new Error(`${what}: the text is not JSON (${JSON.stringify(raw.slice(0, 40))})`);
  }
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error(`${what}: expected a JSON object`);
  return v as Json; // checked just above: a non-null, non-array object
}

const str = (v: unknown): string | undefined => (typeof v === "string" ? v : undefined);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

export function parseClaudeHook(raw: string): ClaudeHook {
  const j = parseObject(raw, "Claude hook input");
  const name = str(j.hook_event_name);
  if (name === undefined) throw new Error("Claude hook input: no hook_event_name");
  const kind = KINDS[name];
  if (!kind) throw new Error(`Claude hook input: unknown hook_event_name ${JSON.stringify(name)}`);
  const bg = j.background_tasks;
  const hook: ClaudeHook = {
    kind,
    sessionId: str(j.session_id) ?? "",
    transcriptPath: str(j.transcript_path) ?? "",
    cwd: str(j.cwd) ?? "",
    backgroundTasks: Array.isArray(bg) ? bg.length : (num(bg) ?? 0),
  };
  const source = str(j.source);
  if (source !== undefined) hook.source = source;
  const prompt = str(j.prompt);
  if (prompt !== undefined) hook.prompt = prompt;
  const reply = str(j.last_assistant_message);
  if (reply !== undefined) hook.reply = reply;
  const mode = str(j.permission_mode);
  if (mode !== undefined) hook.permissionMode = mode;
  const message = str(j.message);
  if (message !== undefined) hook.message = message;
  const toolName = str(j.tool_name);
  if (toolName !== undefined) {
    hook.tool = { name: toolName, input: j.tool_input };
    const id = str(j.tool_use_id);
    if (id !== undefined) hook.tool.id = id;
  }
  return hook;
}

// ---------- status line ----------

export interface ClaudeStatusLine {
  sessionId: string;
  model: string | null;
  contextPct: number | null;
  windows: { name: string; usedPct: number; resetsAt: number }[];
  costUsd: number | null;
}

const obj = (v: unknown): Json | undefined => (typeof v === "object" && v !== null && !Array.isArray(v) ? (v as Json) : undefined); // narrowed by the checks

export function parseClaudeStatusLine(raw: string): ClaudeStatusLine {
  const j = parseObject(raw, "Claude status line input");
  const m = j.model;
  const model = str(m) ?? str(obj(m)?.id) ?? null;
  const windows: ClaudeStatusLine["windows"] = [];
  const limits = obj(j.rate_limits);
  if (limits) {
    for (const [name, w] of Object.entries(limits)) {
      const usedPct = num(obj(w)?.used_percentage);
      const resetsAt = num(obj(w)?.resets_at);
      if (usedPct !== null && resetsAt !== null) windows.push({ name, usedPct, resetsAt });
    }
  }
  return {
    sessionId: str(j.session_id) ?? "",
    model,
    contextPct: num(obj(j.context_window)?.used_percentage),
    windows,
    costUsd: num(obj(j.cost)?.total_cost_usd),
  };
}

// ---------- transcript ----------

export interface TranscriptTurn {
  role: "user" | "assistant";
  text: string;
  at: string | null;
}

/**
 * Reads the transcript .jsonl from line `fromLine` (0-based). `lines` is how many lines are done, so the
 * next call passes it back as `fromLine`. A broken last line (the tool is still writing) is skipped and
 * not counted, so the next read picks it up whole.
 */
export function readClaudeTranscript(path: string, fromLine = 0): { lines: number; turns: TranscriptTurn[] } {
  const all = readFileSync(path, "utf8").split("\n");
  if (all.length > 0 && all[all.length - 1] === "") all.pop(); // the file ends with a newline
  const turns: TranscriptTurn[] = [];
  let lines = all.length;
  for (let i = Math.max(0, fromLine); i < all.length; i++) {
    const line = (all[i] ?? "").trim();
    if (!line) continue;
    let v: unknown;
    try {
      v = JSON.parse(line);
    } catch {
      if (i === all.length - 1) lines = i; // unfinished write: read it again next time
      continue;
    }
    const turn = turnOf(obj(v));
    if (turn) turns.push(turn);
  }
  return { lines: Math.max(lines, Math.min(fromLine, all.length)), turns };
}

function turnOf(entry: Json | undefined): TranscriptTurn | undefined {
  if (!entry) return undefined;
  const role = entry.type;
  if (role !== "user" && role !== "assistant") return undefined;
  const content = obj(entry.message)?.content;
  let text: string;
  if (typeof content === "string") text = content;
  else if (Array.isArray(content)) {
    text = content
      .map((b) => {
        const block = obj(b);
        return block?.type === "text" ? (str(block.text) ?? "") : "";
      })
      .filter((t) => t !== "")
      .join("\n");
  } else return undefined;
  if (!text) return undefined;
  return { role, text, at: str(entry.timestamp) ?? null };
}

// ---------- screen ----------

const DIALOG_FOOTER = /Enter to confirm · Esc to cancel/;
/** A permission prompt: the first choice is "Yes", and the footer says Esc cancels (usually "Esc to cancel · Tab to amend"). */
const PERMISSION_CHOICE = /^\s*❯\s*1\.\s*Yes/m;
const PERMISSION_FOOTER = /Esc to cancel/;

const lastLines = (text: string, n: number): string =>
  text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-n)
    .join("\n");

/**
 * What the tool shows, from a tmux capture.
 * `trust`: the folder trust question, whose default answer is "No, exit". The engine must never press Enter there.
 * `dialog`: a dialog over the prompt (fixtures/claude/screens/dialog.txt), whose default answer is "Yes". A paste plus Enter
 * would confirm it. The footer counts only near the bottom: older output may still show one.
 * `permission`: a permission prompt ("❯ 1. Yes", the footer "Esc to cancel · Tab to amend"): its default answer is "Yes", so a
 * paste plus Enter would grant it. fixtures/claude/screens/permission.txt is NOT a capture: it was made from that description.
 * `busy`: a turn runs. Only the bottom of the screen counts: a finished turn's spinner line may still be in older output.
 * `ready`: the prompt between its rules. A bare prompt glyph alone is not enough.
 */
export function claudeScreen(text: string): "trust" | "dialog" | "permission" | "ready" | "busy" | "unknown" {
  if (/Is this a project you created or one you trust/.test(text) || (/No, exit/.test(text) && /Yes, I trust this folder/.test(text))) return "trust";
  if (DIALOG_FOOTER.test(lastLines(text, 8))) return "dialog";
  const lower = lastLines(text, 10);
  if (PERMISSION_CHOICE.test(lower) && PERMISSION_FOOTER.test(lower)) return "permission";
  // A spinner line: "<word>… (<time> · <tokens>…)", or the interrupt hint.
  const bottom = lastLines(text, 12);
  if (/…\s*\([^)\n]*(\d+s\b|tokens)/.test(bottom) || /esc to interrupt/i.test(bottom)) return "busy";
  if (/^\s*❯/m.test(text) && /^\s*─{5,}/m.test(text)) return "ready";
  return "unknown";
}

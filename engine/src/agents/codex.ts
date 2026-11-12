/**
 * Codex adapter: pure functions. The caller passes every folder and runs every process.
 * Facts come from fixtures/real-tools.json (Codex 0.166.0).
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";

export interface CodexStartOptions {
  bin?: string;
  cwd: string;
  notify: string[];
  model?: string;
  effort?: string;
  /** A session id. The argv then starts `resume <id>`. */
  resume?: string;
  extra?: string[];
}

/** The argv that starts Codex in a terminal. Flags: -C (working folder), -c (config override), -m (model). */
export function codexStart(o: CodexStartOptions): string[] {
  const argv = [o.bin ?? "codex"];
  if (o.resume) argv.push("resume", o.resume);
  argv.push("-C", o.cwd, "-c", `notify=${JSON.stringify(o.notify)}`);
  if (o.model) argv.push("-m", o.model);
  if (o.effort) argv.push("-c", `model_reasoning_effort=${o.effort}`);
  if (o.extra) argv.push(...o.extra);
  return argv;
}

export interface CodexTurnEnd {
  kind: "turnEnd";
  threadId: string;
  turnId: string;
  cwd: string;
  reply: string;
  inputs: string[];
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
const str = (v: unknown): string | null => (typeof v === "string" ? v : null);
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Reads the one JSON argument that Codex passes to the notify program at the end of a turn. */
export function parseCodexNotify(arg: string): CodexTurnEnd {
  let raw: unknown;
  try {
    raw = JSON.parse(arg);
  } catch {
    throw new Error(`Codex notify argument is not JSON: ${arg.slice(0, 80)}`);
  }
  const j = obj(raw);
  if (!j) throw new Error("Codex notify argument is not a JSON object");
  if (j.type !== "agent-turn-complete") throw new Error(`Codex notify type ${JSON.stringify(j.type)} is not agent-turn-complete`);
  const threadId = str(j["thread-id"]);
  if (!threadId) throw new Error("Codex notify payload has no thread-id");
  const inputs = Array.isArray(j["input-messages"]) ? j["input-messages"].filter((x): x is string => typeof x === "string") : [];
  return {
    kind: "turnEnd",
    threadId,
    turnId: str(j["turn-id"]) ?? "",
    cwd: str(j.cwd) ?? "",
    reply: str(j["last-assistant-message"]) ?? "",
    inputs,
  };
}

export interface CodexTurn {
  turnId: string;
  complete: boolean;
  reply: string | null;
}

export interface CodexWindow {
  name: string;
  usedPct: number;
  windowMinutes: number;
  resetsAt: number;
}

export interface CodexRollout {
  /** Complete lines read, counting from the start of the file. Pass it as `fromLine` next time. */
  lines: number;
  sessionId: string | null;
  cwd: string | null;
  turns: CodexTurn[];
  contextWindow: number | null;
  totalTokens: number | null;
  windows: CodexWindow[];
}

function windowOf(name: string, v: unknown): CodexWindow | null {
  const w = obj(v);
  if (!w) return null;
  const usedPct = num(w.used_percent);
  const windowMinutes = num(w.window_minutes);
  const resetsAt = num(w.resets_at);
  if (usedPct === null || windowMinutes === null || resetsAt === null) return null;
  return { name, usedPct, windowMinutes, resetsAt };
}

/**
 * Reads a rollout file from line `fromLine` (0-based count of lines to skip).
 * A record of a kind it does not know is skipped. So is a line that is not JSON.
 * A last line that is not finished is left out of `lines`, so the next read starts at it.
 */
export function readCodexRollout(path: string, fromLine = 0): CodexRollout {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    throw new Error(`cannot read Codex rollout ${path}: ${e instanceof Error ? e.message : String(e)}`);
  }
  const all = text.split("\n");
  const last = all.pop() ?? ""; // text after the final newline; "" when the file ends with one
  let lastOk = false;
  if (last.trim()) {
    try {
      JSON.parse(last);
      lastOk = true;
    } catch {
      lastOk = false;
    }
  }
  if (lastOk) all.push(last);

  const out: CodexRollout = { lines: all.length, sessionId: null, cwd: null, turns: [], contextWindow: null, totalTokens: null, windows: [] };
  const turns = new Map<string, CodexTurn>();
  for (let i = Math.max(0, fromLine); i < all.length; i++) {
    const s = (all[i] ?? "").trim();
    if (!s) continue;
    let rec: Json | null;
    try {
      rec = obj(JSON.parse(s));
    } catch {
      continue;
    }
    if (!rec) continue;
    const p = obj(rec.payload);
    if (!p) continue;
    if (rec.type === "session_meta") {
      out.sessionId = str(p.id) ?? str(p.session_id) ?? out.sessionId;
      out.cwd = str(p.cwd) ?? out.cwd;
      continue;
    }
    if (rec.type !== "event_msg") continue;
    if (p.type === "task_started") {
      const id = str(p.turn_id);
      if (!id) continue;
      const known = turns.get(id);
      if (!known) turns.set(id, { turnId: id, complete: false, reply: null });
      out.contextWindow = num(p.model_context_window) ?? out.contextWindow;
    } else if (p.type === "task_complete") {
      const id = str(p.turn_id);
      if (!id) continue;
      turns.set(id, { turnId: id, complete: true, reply: str(p.last_agent_message) });
    } else if (p.type === "token_count") {
      const info = obj(p.info);
      const usage = info ? obj(info.total_token_usage) : null;
      out.totalTokens = usage ? num(usage.total_tokens) : null;
      out.contextWindow = (info ? num(info.model_context_window) : null) ?? out.contextWindow;
      const limits = obj(p.rate_limits);
      const ws: CodexWindow[] = [];
      if (limits) {
        const a = windowOf("primary", limits.primary);
        const b = windowOf("secondary", limits.secondary);
        if (a) ws.push(a);
        if (b) ws.push(b);
      }
      out.windows = ws;
    }
  }
  out.turns = [...turns.values()];
  return out;
}

/** Walks `sessionsDir/YYYY/MM/DD` for `rollout-*-<sessionId>.jsonl`. Gives the newest match, or null. */
export function findCodexRollout(sessionsDir: string, sessionId: string): string | null {
  if (!/^[A-Za-z0-9_-]+$/.test(sessionId)) return null;
  const suffix = `-${sessionId}.jsonl`;
  const list = (dir: string, pattern: RegExp): string[] => {
    if (!existsSync(dir)) return [];
    try {
      return readdirSync(dir)
        .filter((n) => pattern.test(n))
        .sort()
        .reverse();
    } catch {
      return [];
    }
  };
  for (const y of list(sessionsDir, /^\d{4}$/)) {
    for (const m of list(join(sessionsDir, y), /^\d{2}$/)) {
      for (const d of list(join(sessionsDir, y, m), /^\d{2}$/)) {
        const day = join(sessionsDir, y, m, d);
        for (const f of list(day, /^rollout-.*\.jsonl$/)) {
          if (f.endsWith(suffix)) return join(day, f);
        }
      }
    }
  }
  return null;
}

/**
 * Classifies a capture of the Codex screen.
 * `trust`: the folder trust question ("Trust this folder?", "enter continue · esc quit"). Escape QUITS Codex there and Enter
 * trusts the folder, so the engine sends nothing: the owner answers. It is checked before `update`.
 * `update`: the update question. The engine sends Escape there and never Enter, because Enter runs an installer.
 * `busy`: a turn is running. The pattern "esc to interrupt" is Codex's working line; no real busy screen was captured. Only the
 * bottom of the screen counts: a finished turn's working line may still be in older output.
 * `ready`: the tool's own first screen (its placeholder or its footer). A bare prompt glyph alone is not enough.
 */
export function codexScreen(text: string): "trust" | "update" | "ready" | "busy" | "unknown" {
  if (/Trust this folder\?/i.test(text) && /Trust and continue|esc quit/i.test(text)) return "trust";
  if (/Update available/i.test(text) && /Update now/i.test(text)) return "update";
  const bottom = text
    .split("\n")
    .filter((l) => l.trim() !== "")
    .slice(-12)
    .join("\n");
  if (/esc to interrupt/i.test(bottom)) return "busy";
  if (/Ask Codex to do anything|\? for shortcuts/.test(text)) return "ready";
  return "unknown";
}

/**
 * Whether the screen shows that Codex took a pasted line: the line (its first 60 characters) is shown above the last prompt line
 * (`›`). A line that was only pasted sits in the prompt line itself, not above it.
 */
export function codexShows(text: string, line: string): boolean {
  const lines = text.split("\n").filter((l) => l.trim() !== "");
  let prompt = -1;
  lines.forEach((l, i) => {
    if (/^\s*›/.test(l)) prompt = i;
  });
  const probe = line.trim().slice(0, 60);
  return prompt > 0 && probe !== "" && lines.slice(0, prompt).some((l) => l.includes(probe));
}

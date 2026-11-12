/**
 * Usage numbers of the two tools. Pure functions: the caller reads the files and passes the text.
 * Every time (`now`, `at`, `resetsAt`) is in epoch seconds. A `now` in milliseconds is read as milliseconds.
 */

export interface UsageWindow {
  name: string;
  usedPct: number | null;
  resetsAt: number | null;
}

export interface ToolUsage {
  tool: "claude" | "codex";
  windows: UsageWindow[];
  contextPct: number | null;
  at: number;
}

type Json = Record<string, unknown>;

function obj(v: unknown): Json | null {
  return v !== null && typeof v === "object" && !Array.isArray(v) ? (v as Json) : null;
}
const num = (v: unknown): number | null => (typeof v === "number" && Number.isFinite(v) ? v : null);

/** Claude Code status line input: `rate_limits.five_hour` and `.seven_day`, `context_window.used_percentage`. */
export function claudeUsage(statusLineJson: string, now: number): ToolUsage {
  let raw: unknown;
  try {
    raw = JSON.parse(statusLineJson);
  } catch {
    throw new Error(`Claude status line input is not JSON: ${statusLineJson.slice(0, 80)}`);
  }
  const j = obj(raw);
  if (!j) throw new Error("Claude status line input is not a JSON object");
  const windows: UsageWindow[] = [];
  const limits = obj(j.rate_limits);
  if (limits) {
    for (const name of ["five_hour", "seven_day"]) {
      const w = obj(limits[name]);
      if (w) windows.push({ name, usedPct: num(w.used_percentage), resetsAt: num(w.resets_at) });
    }
  }
  const ctx = obj(j.context_window);
  return { tool: "claude", windows, contextPct: ctx ? num(ctx.used_percentage) : null, at: now };
}

/** Codex rollout text: the newest `token_count` record gives the windows and the tokens. Unknown records and broken lines are skipped. */
export function codexUsage(rolloutText: string, now: number): ToolUsage {
  let windows: UsageWindow[] = [];
  let contextPct: number | null = null;
  let window: number | null = null; // model_context_window from task_started, in case token_count has none
  for (const line of rolloutText.split("\n")) {
    const s = line.trim();
    if (!s) continue;
    let rec: Json | null;
    try {
      rec = obj(JSON.parse(s));
    } catch {
      continue;
    }
    const p = rec ? obj(rec.payload) : null;
    if (!rec || !p || rec.type !== "event_msg") continue;
    if (p.type === "task_started") {
      window = num(p.model_context_window) ?? window;
    } else if (p.type === "token_count") {
      const info = obj(p.info);
      const usage = info ? obj(info.total_token_usage) : null;
      const total = usage ? num(usage.total_tokens) : null;
      const size = (info ? num(info.model_context_window) : null) ?? window;
      contextPct = total !== null && size !== null && size > 0 ? (total / size) * 100 : null;
      windows = [];
      const limits = obj(p.rate_limits);
      if (limits) {
        for (const name of ["primary", "secondary"]) {
          const w = obj(limits[name]);
          if (w) windows.push({ name, usedPct: num(w.used_percent), resetsAt: num(w.resets_at) });
        }
      }
    }
  }
  return { tool: "codex", windows, contextPct, at: now };
}

const toSeconds = (t: number): number => (t > 1e11 ? t / 1000 : t);

/** G3: a window whose reset time has passed counts as 0. An unknown number stays null. */
export function effectivePct(w: UsageWindow, now: number): number | null {
  if (w.usedPct === null) return null;
  if (w.resetsAt !== null && w.resetsAt <= toSeconds(now)) return 0;
  return w.usedPct;
}

/** `over` when any window is at or over the threshold. `unknown` when no window has a number (G5). */
export function overThreshold(u: ToolUsage, thresholdPct: number, now: number): "over" | "under" | "unknown" {
  let known = false;
  for (const w of u.windows) {
    const pct = effectivePct(w, now);
    if (pct === null) continue;
    known = true;
    if (pct >= thresholdPct) return "over";
  }
  return known ? "under" : "unknown";
}

/** The newer input wins, but its windows only when it carries some: the Claude status line does not always have rate_limits. */
export function mergeUsage(older: ToolUsage | null, newer: ToolUsage): ToolUsage {
  if (!older || older.tool !== newer.tool || newer.windows.length > 0) return newer;
  return { ...newer, windows: older.windows };
}

/**
 * D12: patterns for a tool's own "usage limit reached" message.
 * No real sample of that message was captured (fixtures/real-tools.json), so these are assumed wordings.
 * Each needs a reached/hit/exceeded verb, so a screen that only mentions a limit does not match.
 */
export const LIMIT_PATTERNS: readonly RegExp[] = [
  /usage limit (?:has been )?(?:reached|hit|exceeded)/i,
  /(?:5-hour|five-hour|weekly|daily|session|hourly)\s+(?:usage\s+)?limit (?:reached|hit|exceeded)/i,
  /you(?:'|’)?(?:ve| have) (?:hit|reached|exceeded) your (?:\w+[- ]){0,3}limit/i,
  /(?:limit|quota) (?:reached|exceeded)\b.*\b(?:resets?|try again)/i,
];

export function limitText(screen: string): boolean {
  return LIMIT_PATTERNS.some((re) => re.test(screen));
}

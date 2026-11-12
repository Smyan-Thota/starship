/**
 * A stand-in for Claude Code or Codex, so engine tests need no tokens.
 *
 *   bun engine/test/fake-agent.ts --as claude --settings <file> [--session-id <id>] [--resume <id>]
 *                                 [--model <m>] [--append-system-prompt-file <f>]
 *   bun engine/test/fake-agent.ts --as codex [resume <id>] [-C <cwd>] -c 'notify=["<script>", ...]' [-m <model>]
 *
 * It runs inside a terminal (tmux), reads stdin in raw mode, and does what the real tool does at
 * the edges the engine can see: hooks, the status line command, notify, and the session file.
 *
 * Input. tmux sends pasted text inside bracketed-paste markers (ESC [ 200 ~ ... ESC [ 201 ~) and
 * then a carriage return. A lone ESC byte interrupts the turn: no turn-end event fires.
 *
 * A pasted line does one of these:
 *   say <text>            reply with the text
 *   slow <ms> <text>      wait, then reply with the text
 *   stall                 never end the turn
 *   crash                 exit with code 1 in the middle of the turn
 *   permission            fire Notification, wait for a line `y`, then reply "done"
 *   write <relpath> <text> write the file under cwd, then reply "done"
 *   claim                 reply "done" and write nothing
 *   empty                 end the turn with an empty reply
 *   block <ms> <text>     fire Stop with the reply "first", keep a busy line on the screen for <ms>, then fire Stop
 *                         again with stop_hook_active true and the reply <text> (a blocking Stop hook of the owner's own setup)
 *   anything else         reply "ok: <line>"
 * A line that arrives during a turn waits its turn, except the `y` that `permission` waits for.
 * The ready screen is the real tool's (the lines of fixtures/<tool>/screens/ready.txt around its prompt), and a turn shows its busy
 * line at the bottom and erases it at the end, as the real tools redraw. Every key that arrives is logged to
 * <FAKE_SESSIONS_DIR>/fake-input.log: `<epoch ms>\t<flavor>\t<phase>\t<kind>\t<text>`, kind being paste, text, enter, esc or down.
 *
 * Environment.
 *   FAKE_SESSIONS_DIR  required. Where the transcript or rollout file goes. Never the real home.
 *   FAKE_SCREEN        `trust` (both flavors: Claude Code's trust question, or Codex's) or `update` (Codex): show that start
 *                      screen first. In the Codex trust question Enter continues and Escape exits.
 *                      A comma list is a sequence: `update,trust` shows the update question, and after Escape about 400 ms of a
 *                      screen whose last line is the bare prompt (as real Codex did on 2026-11-11), and then the trust question.
 *                      `update,ready,trust` shows the real ready screen for 400 ms instead of the bare prompt. Codex flavor: a line
 *                      pasted and sent while one of those 400 ms screens is up is kept, and runs after the trust question is answered.
 *                      `dialog` (Claude Code): after the first turn, show a dialog until Escape arrives. Enter on it prints
 *                      `DIALOG: confirmed`, so a test can catch a forbidden Enter.
 *   FAKE_TURN_MS      A turn of an ordinary line (`ok: ...`, `say`, `write`, ...) takes that many ms before its reply.
 *   FAKE_BLOCK_MS     Claude Code flavor: a line that matches no command above is a turn with a blocking Stop hook of that many ms.
 *   FAKE_DIALOG_STICKY With `dialog`: Escape does not close it. Only the key `n` does.
 *   FAKE_FIVE_HOUR, FAKE_SEVEN_DAY  used percentages the status line and the rollout report (10, 5).
 *   FAKE_CONTEXT_PCT   the context use the status line (Claude) and the rollout (Codex) report. Default: grows with the turns.
 */

import { randomUUID } from "node:crypto";
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";

type Flavor = "claude" | "codex";

interface Options {
  as: Flavor;
  settings?: string;
  sessionId?: string;
  resume?: string;
  model?: string;
  cwd: string;
  notify: string[];
}

interface HookGroup {
  matcher?: string;
  hooks?: { type?: string; command?: string }[];
}

interface Settings {
  hooks?: Record<string, HookGroup[]>;
  statusLine?: { command?: string };
}

const CLAUDE_VERSION = "2.1.322";
const CODEX_VERSION = "0.166.0";
const PASTE_START = "\x1b[200~";
const PASTE_END = "\x1b[201~";

// ---- arguments ----

/** Flags that take one value. Others are ignored on their own. */
const WITH_VALUE = new Set([
  "--as",
  "--settings",
  "--session-id",
  "--resume",
  "--model",
  "--append-system-prompt-file",
  "--permission-mode",
  "--add-dir",
  "-m",
  "-C",
  "-c",
  "-a",
  "-s",
]);

/** The value of `notify=[...]`. The brief's form is a JSON array, which TOML shares for plain strings. */
function parseNotify(value: string): string[] {
  const body = value.slice("notify=".length).trim();
  try {
    const parsed: unknown = JSON.parse(body);
    if (Array.isArray(parsed) && parsed.every((x) => typeof x === "string")) return parsed as string[];
  } catch {
    // fall through to the lenient reader
  }
  return [...body.matchAll(/"([^"]*)"|'([^']*)'/g)].map((m) => m[1] ?? m[2] ?? "");
}

function parseArgs(argv: string[]): Options {
  const o: Options = { as: "claude", cwd: process.cwd(), notify: [] };
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    const v = WITH_VALUE.has(a) ? (argv[++i] ?? "") : "";
    switch (a) {
      case "--as":
        if (v !== "claude" && v !== "codex") fail(`--as takes claude or codex, not ${JSON.stringify(v)}`);
        o.as = v as Flavor;
        break;
      case "--settings":
        o.settings = v;
        break;
      case "--session-id":
        o.sessionId = v;
        break;
      case "--resume":
        o.resume = v;
        break;
      case "--model":
      case "-m":
        o.model = v;
        break;
      case "-C":
        o.cwd = resolve(v);
        break;
      case "-c":
        if (v.startsWith("notify=")) o.notify = parseNotify(v);
        break;
      case "resume":
        // Codex: `resume <id>` is a subcommand, not a flag.
        o.resume = argv[++i] ?? "";
        break;
      default:
        break;
    }
  }
  return o;
}

function fail(message: string): never {
  process.stderr.write(`fake-agent: ${message}\n`);
  process.exit(2);
}

const opts = parseArgs(process.argv.slice(2));
const sessionsDir: string =
  process.env.FAKE_SESSIONS_DIR || fail("FAKE_SESSIONS_DIR is required (the folder for the transcript or rollout file)");
if (existsSync(opts.cwd)) process.chdir(opts.cwd);
const cwd = process.cwd();
const isClaude = opts.as === "claude";

const settings: Settings = (() => {
  if (!isClaude || !opts.settings) return {};
  try {
    return JSON.parse(readFileSync(opts.settings, "utf8")) as Settings;
  } catch (e) {
    return fail(`cannot read settings ${opts.settings}: ${e instanceof Error ? e.message : String(e)}`);
  }
})();

const sessionId = (isClaude ? (opts.resume ?? opts.sessionId) : opts.resume) || randomUUID();
const model = opts.model || (isClaude ? "claude-haiku-5-5" : "gpt-fake");
const percent = (name: string, fallback: number) => {
  const n = Number(process.env[name]);
  return Number.isFinite(n) && process.env[name] !== undefined && process.env[name] !== "" ? n : fallback;
};

// ---- screen ----

const out = (s: string) => void process.stdout.write(s);
const PROMPT = isClaude ? "❯ " : "› ";
const here = import.meta.dir;
const screenFile = (...p: string[]) => readFileSync(join(here, "..", "..", "fixtures", ...p), "utf8");

/** The lines of the real ready screen around its prompt: the rule above it (Claude Code) and the footer below it. */
function readyParts(): { above: string[]; below: string[] } {
  const lines = screenFile(isClaude ? "claude" : "codex", "screens", "ready.txt").split("\n");
  const at = lines.findIndex((l) => l.trimStart().startsWith(isClaude ? "❯" : "›"));
  const above = isClaude && at > 0 ? [lines[at - 1] ?? ""] : [];
  const below = lines.slice(at + 1).filter((l) => l.trim() !== "").map((l) => l.replaceAll("/work/demo", process.cwd()));
  return { above, below };
}

/**
 * The ready screen: the rule, the prompt and the footer of the real tool. The cursor ends on the prompt line, after the prompt, so
 * that pasted text shows there. Relative cursor moves, so that a screen that scrolled does not break them.
 */
function promptBlock(): string {
  const { above, below } = readyParts();
  const up = below.length > 0 ? `\x1b[${below.length}A` : "";
  return `${above.map((l) => `${l}\n`).join("")}${PROMPT}${below.map((l) => `\n${l}`).join("")}${up}\x1b[${PROMPT.length + 1}G`;
}

/** True while a busy line is on the screen. */
let busyActive = false;
/** How many lines the cursor is below the busy line: the rule, then the prompt line, and one more for each Enter typed meanwhile. */
let busyRows = 0;
/** The busy line above the real prompt block, as in fixtures/claude/screens/busy.txt: the end of the turn erases it, as the real tools redraw. */
function busyOn(text: string): void {
  if (busyActive) busyOff();
  busyActive = true;
  busyRows = readyParts().above.length + 1;
  out(`\r\x1b[J${text}\n${promptBlock()}`);
}
/** Erases the busy line and the prompt block under it. The cursor is at the start of a clean line. */
function busyOff(): void {
  if (busyActive) out(`\x1b[${busyRows}A`);
  busyActive = false;
  out("\r\x1b[J");
}

const LOG_FILE = join(sessionsDir, "fake-input.log");
function logInput(phaseNow: string, kind: string, text = ""): void {
  try {
    appendFileSync(LOG_FILE, `${Date.now()}\t${opts.as}\t${phaseNow}\t${kind}\t${text}\n`);
  } catch {
    // the log is for tests: a failure to write it must not stop the fake
  }
}

function header(): string {
  return isClaude
    ? ` ▐▛███▛█   Claude Code v${CLAUDE_VERSION} (fake)\n▝▜██████▀  ${model}\n ▝▝   ▝▝   ${cwd}\n\n`
    : `  >_ OpenAI Codex (v${CODEX_VERSION}) (fake)\n     ${cwd}\n\n`;
}

// ---- hooks and status line ----

function runCommand(command: string, input: unknown): void {
  Bun.spawnSync(["sh", "-c", command], {
    cwd,
    stdin: Buffer.from(JSON.stringify(input)),
    stdout: "ignore",
    stderr: "ignore",
    env: process.env,
  });
}

/** Runs each command of one event with the event's JSON on stdin, as Claude Code does. */
function fire(event: string, input: Record<string, unknown>): void {
  if (!isClaude) return;
  for (const group of settings.hooks?.[event] ?? []) {
    if (event === "PreToolUse" && group.matcher && group.matcher !== "*") {
      if (!new RegExp(`^(?:${group.matcher})$`).test(String(input.tool_name))) continue;
    }
    for (const h of group.hooks ?? []) {
      if ((h.type === undefined || h.type === "command") && h.command) runCommand(h.command, input);
    }
  }
}

// ---- session files ----

const now = () => new Date().toISOString();

/** Claude Code keeps one transcript per session under projects/<cwd with dashes>/<id>.jsonl. */
const transcriptPath = join(sessionsDir, "projects", cwd.replace(/[^A-Za-z0-9]/g, "-"), `${sessionId}.jsonl`);

function appendLine(file: string, row: unknown): void {
  mkdirSync(dirname(file), { recursive: true });
  appendFileSync(file, `${JSON.stringify(row)}\n`);
}

/** Codex keeps sessions/YYYY/MM/DD/rollout-<time>-<id>.jsonl. A resume finds the file it wrote before. */
function findRollout(id: string): string | undefined {
  const walk = (dir: string): string | undefined => {
    if (!existsSync(dir)) return undefined;
    for (const e of readdirSync(dir)) {
      const p = join(dir, e);
      if (statSync(p).isDirectory()) {
        const hit = walk(p);
        if (hit) return hit;
      } else if (e.startsWith("rollout-") && e.endsWith(`-${id}.jsonl`)) return p;
    }
    return undefined;
  };
  return walk(join(sessionsDir, "sessions"));
}

function newRolloutPath(id: string): string {
  const d = new Date();
  const p2 = (n: number) => String(n).padStart(2, "0");
  const day = [String(d.getFullYear()), p2(d.getMonth() + 1), p2(d.getDate())];
  const stamp = `${day.join("-")}T${p2(d.getHours())}-${p2(d.getMinutes())}-${p2(d.getSeconds())}`;
  return join(sessionsDir, "sessions", ...day, `rollout-${stamp}-${id}.jsonl`);
}

let rolloutPath = "";
let ordinal = 0;
let rolloutFresh = false;

function rollout(type: string, payload: Record<string, unknown>): void {
  appendLine(rolloutPath, { timestamp: now(), ordinal: ordinal++, type, payload });
}

// ---- turns ----

let turns = 0;
let parentUuid: string | null = null;
let tokensIn = 0;
let tokensOut = 0;

const common = () => ({
  session_id: sessionId,
  transcript_path: transcriptPath,
  cwd,
  scratchpad_dir: join(tmpdir(), "fake-scratch"),
});

class Interrupted extends Error {}

function sleep(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise((resolveSleep, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    const timer = setTimeout(() => {
      signal.removeEventListener("abort", onAbort);
      resolveSleep();
    }, ms);
    const onAbort = () => {
      clearTimeout(timer);
      reject(new Interrupted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
  });
}

function forever(signal: AbortSignal): Promise<never> {
  return new Promise((_, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    signal.addEventListener("abort", () => reject(new Interrupted()), { once: true });
  });
}

/** A line that the running turn waits for, such as the `y` after `permission`. */
let waiter: ((line: string) => void) | null = null;

function nextLine(signal: AbortSignal): Promise<string> {
  return new Promise((resolveLine, reject) => {
    if (signal.aborted) return reject(new Interrupted());
    const onAbort = () => {
      waiter = null;
      reject(new Interrupted());
    };
    signal.addEventListener("abort", onAbort, { once: true });
    waiter = (line) => {
      signal.removeEventListener("abort", onAbort);
      resolveLine(line);
    };
  });
}

interface Turn {
  line: string;
  promptId: string;
  turnId: string;
  startedAt: number;
  /** Set by `block`: the Stop that ends the turn comes after a first one, with stop_hook_active true. */
  hookActive?: boolean;
}

function turnStart(t: Turn): void {
  turns++;
  if (isClaude) {
    fire("UserPromptSubmit", {
      ...common(),
      prompt_id: t.promptId,
      permission_mode: "auto",
      hook_event_name: "UserPromptSubmit",
      prompt: t.line,
    });
    const uuid = randomUUID();
    appendLine(transcriptPath, {
      parentUuid,
      isSidechain: false,
      promptId: t.promptId,
      type: "user",
      message: { role: "user", content: t.line },
      uuid,
      timestamp: now(),
      permissionMode: "auto",
      origin: { kind: "human" },
      promptSource: "typed",
      turnOrigin: "human",
      userType: "external",
      entrypoint: "cli",
      cwd,
      sessionId,
      version: CLAUDE_VERSION,
    });
    parentUuid = uuid;
  } else {
    rollout("event_msg", {
      type: "task_started",
      turn_id: t.turnId,
      root_turn_id: t.turnId,
      started_at: Math.floor(t.startedAt / 1000),
      model_context_window: 475000,
      collaboration_mode_kind: "default",
    });
    rollout("response_item", { type: "message", role: "user", content: [{ type: "text", text: t.line }] });
  }
}

function turnEnd(t: Turn, reply: string): void {
  tokensIn += 1000 * turns;
  tokensOut += 10 + reply.length;
  if (isClaude) {
    const uuid = randomUUID();
    appendLine(transcriptPath, {
      parentUuid,
      isSidechain: false,
      message: {
        model,
        type: "message",
        role: "assistant",
        content: [{ type: "text", text: reply }],
        stop_reason: "end_turn",
      },
      type: "assistant",
      uuid,
      timestamp: now(),
      userType: "external",
      entrypoint: "cli",
      cwd,
      sessionId,
      version: CLAUDE_VERSION,
    });
    parentUuid = uuid;
    fire("Stop", {
      ...common(),
      prompt_id: t.promptId,
      permission_mode: "auto",
      effort: { level: "medium" },
      hook_event_name: "Stop",
      stop_hook_active: t.hookActive === true,
      last_assistant_message: reply,
      background_tasks: [],
      session_crons: [],
    });
    statusLine(t);
  } else {
    rollout("response_item", { type: "message", role: "assistant", content: [{ type: "text", text: reply }] });
    // FAKE_CONTEXT_PCT makes the total a share of the context window that the rollout names below.
    const windowSize = 475000;
    const total = process.env.FAKE_CONTEXT_PCT ? Math.round((percent("FAKE_CONTEXT_PCT", 0) / 100) * windowSize) : tokensIn + tokensOut;
    const usage = {
      input_tokens: tokensIn,
      cached_input_tokens: 0,
      cache_write_input_tokens: 0,
      output_tokens: tokensOut,
      reasoning_output_tokens: 0,
      total_tokens: total,
    };
    rollout("event_msg", {
      type: "token_count",
      info: {
        total_token_usage: usage,
        last_token_usage: usage,
        last_usage_includes_reasoning: true,
        model_context_window: windowSize,
      },
      rate_limits: {
        limit_id: "codex",
        limit_name: null,
        primary: {
          used_percent: percent("FAKE_SEVEN_DAY", 5),
          window_minutes: 10080,
          resets_at: Math.floor(Date.now() / 1000) + 3 * 24 * 3600,
        },
        secondary: null,
      },
    });
    const done = Date.now();
    rollout("event_msg", {
      type: "task_complete",
      root_turn_id: t.turnId,
      turn_id: t.turnId,
      last_agent_message: reply,
      started_at: Math.floor(t.startedAt / 1000),
      completed_at: Math.floor(done / 1000),
      duration_ms: done - t.startedAt,
    });
    if (opts.notify.length > 0) {
      const [program, ...args] = opts.notify;
      Bun.spawnSync([program ?? "", ...args, JSON.stringify({
        type: "agent-turn-complete",
        "thread-id": sessionId,
        "turn-id": t.turnId,
        cwd,
        client: "codex-tui",
        "input-messages": [t.line],
        "last-assistant-message": reply,
      })], { cwd, stdin: "ignore", stdout: "ignore", stderr: "ignore", env: process.env });
    }
  }
}

/** Runs the status line command with the JSON Claude Code sends it. */
function statusLine(t: Turn): void {
  const command = settings.statusLine?.command;
  if (!command) return;
  const used = percent("FAKE_CONTEXT_PCT", Math.min(100, Math.round((tokensIn / 1_000_000) * 100)));
  const nowSec = Math.floor(Date.now() / 1000);
  runCommand(command, {
    ...common(),
    effort: { level: "medium" },
    model: { id: model, display_name: model },
    workspace: { current_dir: cwd, project_dir: cwd, added_dirs: [] },
    version: CLAUDE_VERSION,
    output_style: { name: "default" },
    cost: {
      total_cost_usd: 0,
      total_duration_ms: Date.now() - t.startedAt,
      total_api_duration_ms: 0,
      total_lines_added: 0,
      total_lines_removed: 0,
    },
    context_window: {
      total_input_tokens: tokensIn,
      total_output_tokens: tokensOut,
      context_window_size: 1_000_000,
      current_usage: {
        input_tokens: 2,
        output_tokens: tokensOut,
        cache_creation_input_tokens: 0,
        cache_read_input_tokens: tokensIn,
      },
      used_percentage: used,
      remaining_percentage: 100 - used,
    },
    exceeds_200k_tokens: false,
    fast_mode: false,
    thinking: { enabled: true },
    prompt_id: t.promptId,
    rate_limits: {
      five_hour: { used_percentage: percent("FAKE_FIVE_HOUR", 10), resets_at: nowSec + 3 * 3600 },
      seven_day: { used_percentage: percent("FAKE_SEVEN_DAY", 5), resets_at: nowSec + 3 * 24 * 3600 },
    },
  });
}

/** A blocking Stop hook of the owner's own setup: the first Stop says "first", the screen stays busy, the second Stop carries the reply. */
async function blockedStop(t: Turn, wait: number, reply: string, signal: AbortSignal): Promise<string> {
  fire("Stop", {
    ...common(),
    prompt_id: t.promptId,
    permission_mode: "auto",
    effort: { level: "medium" },
    hook_event_name: "Stop",
    stop_hook_active: false,
    last_assistant_message: "first",
    background_tasks: [],
    session_crons: [],
  });
  busyOn("· Smooshing… (running Stop hooks… 3/4 · 2s · ↓ 25 tokens · thinking)");
  await sleep(Number.isFinite(wait) ? wait : 0, signal);
  t.hookActive = true;
  return reply;
}

/** What the pasted line makes the fake do. Returns the reply. */
async function act(t: Turn, signal: AbortSignal): Promise<string> {
  const [word = "", ...rest] = t.line.split(" ");
  const turnMs = Number(process.env.FAKE_TURN_MS);
  if (Number.isFinite(turnMs) && turnMs > 0 && !["stall", "crash", "permission", "block"].includes(word)) await sleep(turnMs, signal);
  switch (word) {
    case "say":
      return rest.join(" ");
    case "slow": {
      const wait = Number.parseInt(rest[0] ?? "", 10);
      await sleep(Number.isFinite(wait) ? wait : 0, signal);
      return rest.slice(1).join(" ");
    }
    case "stall":
      return forever(signal);
    case "crash":
      busyOff();
      out("fake-agent: crashed\n");
      cleanup();
      return process.exit(1);
    case "permission":
      fire("Notification", {
        ...common(),
        hook_event_name: "Notification",
        message: "The agent needs your permission to use Bash",
        notification_type: "permission_prompt",
      });
      busyOff();
      out("Allow this command? Answer y\n");
      while ((await nextLine(signal)).trim() !== "y") out("Answer y\n");
      return "done";
    case "write": {
      const rel = rest[0] ?? "";
      const text = rest.slice(1).join(" ");
      if (rel === "") return "error: write needs a path";
      const abs = resolve(cwd, rel);
      const back = relative(cwd, abs);
      if (back.startsWith("..") || isAbsolute(back)) return "error: path outside cwd";
      fire("PreToolUse", {
        ...common(),
        prompt_id: t.promptId,
        permission_mode: "auto",
        effort: { level: "medium" },
        hook_event_name: "PreToolUse",
        tool_name: "Write",
        tool_input: { file_path: abs, content: text },
        tool_use_id: `toolu_${randomUUID().replaceAll("-", "").slice(0, 24)}`,
      });
      mkdirSync(dirname(abs), { recursive: true });
      writeFileSync(abs, text);
      return "done";
    }
    case "block":
      return blockedStop(t, Number.parseInt(rest[0] ?? "", 10), rest.slice(1).join(" "), signal);
    case "claim":
      return "done";
    case "empty":
      return "";
    default: {
      // FAKE_BLOCK_MS: every other line is a turn with a blocking Stop hook.
      const blockMs = Number(process.env.FAKE_BLOCK_MS);
      if (isClaude && Number.isFinite(blockMs) && blockMs > 0) return blockedStop(t, blockMs, `ok: ${t.line}`, signal);
      return `ok: ${t.line}`;
    }
  }
}

async function runTurn(line: string, signal: AbortSignal): Promise<void> {
  const t: Turn = { line, promptId: randomUUID(), turnId: randomUUID(), startedAt: Date.now() };
  turnStart(t);
  busyOn(isClaude ? "· Working… (esc to interrupt)" : "• Working (esc to interrupt)");
  const reply = await act(t, signal);
  turnEnd(t, reply);
  busyOff();
  out(`${isClaude ? "⏺" : "•"} ${reply}\n\n${promptBlock()}`);
  if (dialogPending) {
    dialogPending = false;
    phase = "dialog";
    out(`\x1b[2J\x1b[3J\x1b[H${screenFile("claude", "screens", "dialog.txt")}`);
  }
}

// ---- queue ----

const queue: string[] = [];
let draining = false;
let current: AbortController | null = null;

async function drain(): Promise<void> {
  if (draining) return;
  draining = true;
  try {
    for (let line = queue.shift(); line !== undefined; line = queue.shift()) {
      const ac = new AbortController();
      current = ac;
      try {
        await runTurn(line, ac.signal);
      } catch (e) {
        if (!(e instanceof Interrupted)) throw e;
        busyOff();
        out(`⎿ Interrupted\n\n${promptBlock()}`);
      } finally {
        current = null;
      }
    }
  } finally {
    draining = false;
  }
}

function submit(line: string): void {
  if (waiter) {
    const w = waiter;
    waiter = null;
    w(line);
    return;
  }
  queue.push(line);
  void drain();
}

// ---- input ----

type Phase = "trust" | "update" | "dialog" | "flash" | "main";
let phase: Phase = "main";
/** FAKE_SCREEN=dialog: the dialog opens after the first turn. */
let dialogPending = false;
let sawDown = false;
let lineBuf = "";
/** Codex flavor: lines sent while a start screen of 400 ms was up. They run after the trust question is answered. */
const held: string[] = [];

const FLASH_MS = 400;
const CLEAR = "\x1b[2J\x1b[3J\x1b[H";

function begin(): void {
  // After a start screen the real tool redraws the whole terminal.
  out(phase === "main" ? "\x1b[?2004h" : CLEAR);
  phase = "main";
  if (isClaude) {
    fire("SessionStart", {
      ...common(),
      hook_event_name: "SessionStart",
      ...(opts.resume
        ? {
            source: "resume",
            seconds_since_last_response: 0,
            context_tokens: 0,
            prompt_cache_likely_expired: false,
            estimated_cache_write_usd: 0,
          }
        : { source: "startup", model }),
    });
  }
  // The prompt comes after SessionStart, so a screen that shows it means the hook ran.
  out(`${header()}${promptBlock()}`);
  for (const line of held.splice(0)) submit(line);
}

/** The start screens of FAKE_SCREEN, in order. `dialog` is not one of them: it opens after the first turn. */
const startScreens = (process.env.FAKE_SCREEN ?? "")
  .split(",")
  .map((x) => x.trim())
  .filter((x) => x === "trust" || x === "update" || x === "ready");

/** Shows the next start screen, or the ready screen when none is left. `fromUpdate`: Escape just closed the update question. */
function nextStart(fromUpdate: boolean): void {
  const name = startScreens.shift();
  if (name === undefined) {
    begin();
  } else if (name === "update") {
    phase = "update";
    out(`${CLEAR}${screenFile("codex", "screens", "update.txt")}`);
  } else if (name === "ready") {
    // A real-looking ready screen that does not last: the tool is not ready yet.
    phase = "flash";
    out(`${CLEAR}${header()}${promptBlock()}`);
    setTimeout(() => nextStart(false), FLASH_MS);
  } else if (fromUpdate) {
    // What real Codex did on 2026-11-11: after the update question, a bare prompt for a moment, then the trust question.
    phase = "flash";
    out(`${CLEAR}${header()}${PROMPT}`);
    setTimeout(() => showTrust(), FLASH_MS);
  } else {
    showTrust();
  }
}

function showTrust(): void {
  phase = "trust";
  out(`${CLEAR}${screenFile(isClaude ? "claude" : "codex", "screens", "trust.txt")}`);
}

function cleanup(): void {
  out("\x1b[?2004l");
  if (process.stdin.isTTY) process.stdin.setRawMode(false);
}

function quit(code: number): never {
  cleanup();
  process.exit(code);
}

type Key = { k: "esc" } | { k: "down" } | { k: "enter" } | { k: "back" } | { k: "text"; s: string } | { k: "paste"; s: string };

function onKey(key: Key): void {
  logInput(phase, key.k, key.k === "paste" || key.k === "text" ? key.s : "");
  if (phase === "flash") {
    // Codex keeps what is sent to it now, and runs it later. Claude Code's start screens take nothing.
    if (!isClaude && (key.k === "paste" || key.k === "text")) lineBuf += key.s;
    else if (!isClaude && key.k === "enter") {
      if (lineBuf.trim() !== "") held.push(lineBuf);
      lineBuf = "";
    }
    return;
  }
  if (phase === "dialog") {
    const sticky = process.env.FAKE_DIALOG_STICKY === "1";
    if ((key.k === "esc" && !sticky) || (key.k === "text" && key.s === "n" && sticky)) {
      phase = "main";
      out(`\x1b[2J\x1b[3J\x1b[H${header()}${promptBlock()}`);
    } else if (key.k === "enter") {
      // The real default answer is "Yes": Enter confirms it. The fake says so, so that a test can see it.
      phase = "main";
      out(`\x1b[2J\x1b[3J\x1b[HDIALOG: confirmed\n${promptBlock()}`);
    }
    return; // text and paste go nowhere while the dialog is open
  }
  if (phase === "trust" && !isClaude) {
    // Codex's trust question: Enter continues, Escape quits.
    if (key.k === "enter") begin();
    else if (key.k === "esc") quit(0);
    return;
  }
  if (phase === "trust") {
    // The real default answer is "No, exit": Enter leaves, only Down then Enter trusts the folder.
    if (key.k === "down") {
      sawDown = true;
      return;
    }
    const trusted = key.k === "enter" && sawDown;
    sawDown = false;
    if (trusted) begin();
    else if (key.k === "enter" || key.k === "esc") quit(0);
    return;
  }
  if (phase === "update") {
    if (key.k === "esc") nextStart(true);
    else if (key.k === "enter") {
      // The real default answer runs an installer. The fake only says so.
      out("INSTALLER: update now\n");
      quit(0);
    }
    return;
  }
  switch (key.k) {
    case "esc":
      current?.abort();
      return;
    case "paste":
    case "text":
      lineBuf += key.s;
      out(key.s);
      return;
    case "back":
      lineBuf = lineBuf.slice(0, -1);
      return;
    case "enter": {
      const line = lineBuf;
      lineBuf = "";
      out("\n\x1b[J");
      if (busyActive) busyRows++;
      if (line.trim() !== "") submit(line);
      return;
    }
    default:
      return;
  }
}

let carry = "";
let pasting = false;
let pasteBuf = "";

function feed(chunk: string): void {
  const s = carry + chunk;
  carry = "";
  let i = 0;
  while (i < s.length) {
    if (pasting) {
      const end = s.indexOf(PASTE_END, i);
      if (end >= 0) {
        pasteBuf += s.slice(i, end);
        const text = pasteBuf.replace(/[\r\n]/g, " ");
        pasteBuf = "";
        pasting = false;
        i = end + PASTE_END.length;
        onKey({ k: "paste", s: text });
        continue;
      }
      // keep the tail when it could be the start of the end marker
      let keep = 0;
      for (let n = Math.min(PASTE_END.length - 1, s.length - i); n > 0; n--) {
        if (PASTE_END.startsWith(s.slice(s.length - n))) {
          keep = n;
          break;
        }
      }
      pasteBuf += s.slice(i, s.length - keep);
      carry = s.slice(s.length - keep);
      return;
    }
    const c = s.charAt(i);
    if (c === "\x1b") {
      const rest = s.slice(i + 1);
      if (rest === "") {
        i++;
        onKey({ k: "esc" }); // a lone ESC byte
        continue;
      }
      if (s.startsWith(PASTE_START, i)) {
        pasting = true;
        i += PASTE_START.length;
        continue;
      }
      if (rest.startsWith("[B") || rest.startsWith("OB")) {
        i += 3;
        onKey({ k: "down" });
        continue;
      }
      const csi = /^\[[0-9;?]*[ -/]*[@-~]/.exec(rest);
      if (csi) {
        i += 1 + csi[0].length; // some other key sequence: ignored
        continue;
      }
      if (/^\[[0-9;?]*[ -/]*$/.test(rest)) {
        carry = s.slice(i); // a sequence that continues in the next chunk
        return;
      }
      i++;
      onKey({ k: "esc" });
      continue;
    }
    i++;
    if (c === "\r" || c === "\n") onKey({ k: "enter" });
    else if (c === "\x03") quit(130);
    else if (c === "\x7f" || c === "\b") onKey({ k: "back" });
    else if (c >= " ") onKey({ k: "text", s: c });
  }
}

// ---- start ----

if (!isClaude) {
  rolloutPath = (opts.resume ? findRollout(opts.resume) : undefined) ?? newRolloutPath(sessionId);
  rolloutFresh = !existsSync(rolloutPath);
  if (!rolloutFresh) ordinal = readFileSync(rolloutPath, "utf8").split("\n").filter((l) => l !== "").length;
  if (rolloutFresh) {
    rollout("session_meta", {
      id: sessionId,
      session_id: sessionId,
      cwd,
      cli_version: CODEX_VERSION,
      originator: "codex-tui",
    });
  }
}

if (process.stdin.isTTY) process.stdin.setRawMode(true);
process.stdin.setEncoding("utf8");
process.stdin.on("data", (d) => feed(String(d)));
process.stdin.on("end", () => quit(0));
process.on("SIGTERM", () => quit(143));
process.stdin.resume();

dialogPending = (process.env.FAKE_SCREEN ?? "").split(",").map((x) => x.trim()).includes("dialog") && isClaude;
if (startScreens.length > 0) {
  out("\x1b[?2004h");
  nextStart(false);
} else {
  begin();
}

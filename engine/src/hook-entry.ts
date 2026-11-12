/**
 * The program that Claude Code and Codex run as their hook. It does one small thing and never fails loudly:
 * a hook that breaks would break the tool.
 *
 *   bun hook-entry.ts hook claude            the hook input is on stdin
 *   bun hook-entry.ts hook codex '<json>'    Codex's notify passes the input as its last argument
 *   bun hook-entry.ts status                 the Claude Code status line input is on stdin; prints `starship`. It keeps the input
 *                                            for the engine, also per agent when STARSHIP_CHAT and STARSHIP_AGENT are set.
 *
 * The chat and the agent come from the env STARSHIP_CHAT and STARSHIP_AGENT. It prints nothing for a hook, except for
 * a Claude Code PreToolUse input: then it asks the guard (guards.ts) and prints the guard's answer, which is nothing
 * when the tool call is allowed. It exits 0 even when it fails, and a failure allows the tool call: a hook must never
 * break the tool. A failure goes to `<home>/hook-errors.log`.
 *
 * After a hook has logged its event, it posts `POST /api/hook { chat }` to the running engine, with a 300 ms limit, so the engine
 * applies the event at once. Every failure of that is ignored: the engine's poll loop is the fallback.
 *
 * `starship hook ...` and `starship status` (cli.ts) call `main` too: it is the one program the tools run.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { getChat } from "./chats.ts";
import { home, paths } from "./config.ts";
import { type GuardInput, claudeHookOutput, decide } from "./guards.ts";
import { appendHookEvent } from "./hooks.ts";
import { HEAVY, getRepo } from "./repos.ts";
import { readRunState } from "./run/state.ts";
import type { Role } from "./types.ts";

function logError(message: string): void {
  try {
    mkdirSync(home(), { recursive: true });
    appendFileSync(join(home(), "hook-errors.log"), `${new Date().toISOString()} ${message}\n`);
  } catch {
    // nowhere left to report it
  }
}

const ROLES: readonly Role[] = ["admin", "orchestrator", "worker", "reviewer", "cardRunner"];

/** The guard's answer for a PreToolUse input: the JSON to print, or "" when the tool call is allowed. */
function guardAnswer(chat: string, agent: string, raw: string): string {
  const v: unknown = JSON.parse(raw);
  if (typeof v !== "object" || v === null || Array.isArray(v)) return "";
  const o = v as Record<string, unknown>; // checked just above: a non-null, non-array object
  if (o.hook_event_name !== "PreToolUse") return "";
  const file = join(paths.chat(chat), "agents", `${agent}.json`);
  if (!existsSync(file)) return "";
  const a: unknown = JSON.parse(readFileSync(file, "utf8"));
  if (typeof a !== "object" || a === null) return "";
  const f = a as Record<string, unknown>; // checked just above: an object
  const role = ROLES.find((r) => r === f.role);
  if (!role) return "";
  const stored = getChat(chat);
  const repo = stored.repo ? getRepo(stored.repo) : null;
  let buildStarted = false;
  if (stored.featureDir && existsSync(stored.featureDir)) buildStarted = readRunState(stored.featureDir).build.status !== "notStarted";
  const input: GuardInput = {
    role,
    tool: typeof o.tool_name === "string" ? o.tool_name : "",
    input: o.tool_input,
    cwd: typeof o.cwd === "string" ? o.cwd : typeof f.cwd === "string" ? f.cwd : (stored.worktree ?? process.cwd()),
    worktree: stored.worktree,
    featureFolder: stored.featureDir,
    adrDir: stored.worktree ? join(stored.worktree, "docs", "adr") : null,
    buildStarted,
    heavyPatterns: repo ? repo.heavyPatterns : HEAVY,
  };
  return claudeHookOutput(decide(input));
}

async function hook(tool: string | undefined, rest: string[], stdin: string | undefined): Promise<string> {
  if (tool !== "claude" && tool !== "codex") throw new Error(`hook: the tool must be claude or codex, not ${JSON.stringify(tool)}`);
  const chat = process.env.STARSHIP_CHAT;
  const agent = process.env.STARSHIP_AGENT;
  if (!chat || !agent) throw new Error("hook: STARSHIP_CHAT and STARSHIP_AGENT must be set");
  const raw = tool === "claude" ? (stdin ?? (await Bun.stdin.text())) : (rest[rest.length - 1] ?? "");
  if (raw.trim() === "") throw new Error(`hook ${tool}: no input`);
  appendHookEvent(chat, { agent, tool, raw: tool === "claude" ? raw.trim() : raw });
  // The engine hears of the event at once. The guard runs meanwhile, so the tool waits for the slower of the two, never both.
  const told = tellEngine(chat);
  if (tool !== "claude") {
    await told;
    return "";
  }
  try {
    return guardAnswer(chat, agent, raw.trim());
  } catch (e) {
    // The guard failed. The tool call goes on, and the failure is logged.
    logError(`guard ${e instanceof Error ? e.message : String(e)}`);
    return "";
  } finally {
    await told;
  }
}

/** The longest the hook waits for the engine. The engine's own poll loop applies the event anyway, so a miss costs nothing. */
export const TELL_MS = 300;

/**
 * `POST /api/hook { chat }` to the running engine: the address and the token come from engine.json. It never rejects and never
 * waits longer than TELL_MS. No engine, a wrong answer, a slow engine: all are ignored, because a hook must never break or slow the tool.
 */
async function tellEngine(chat: string): Promise<void> {
  try {
    const file = paths.engine();
    if (!existsSync(file)) return;
    const info: unknown = JSON.parse(readFileSync(file, "utf8"));
    if (typeof info !== "object" || info === null) return;
    const { port, token } = info as Record<string, unknown>; // checked just above: an object
    if (typeof port !== "number" || typeof token !== "string") return;
    const res = await fetch(`http://127.0.0.1:${port}/api/hook`, {
      method: "POST",
      headers: { authorization: `Bearer ${token}`, "content-type": "application/json" },
      body: JSON.stringify({ chat }),
      signal: AbortSignal.timeout(TELL_MS),
    });
    await res.body?.cancel();
  } catch {
    // ignored by design: the poll loop is the fallback
  }
}

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

/** A chat id or an agent id as one path part: no separator, and not `..`. */
const isName = (s: string): boolean => s !== "" && s !== "." && s !== ".." && !/[\\/\0]/.test(s);

/**
 * The status line input goes to two files: `<home>/usage/claude-status.json` (the newest of all agents, for the usage numbers)
 * and, when STARSHIP_CHAT and STARSHIP_AGENT are set, `<home>/chats/<chat>/agents/<agent>.status.json` (this agent's context use).
 */
async function status(stdin: string | undefined): Promise<void> {
  const text = stdin ?? (await Bun.stdin.text());
  const v: unknown = JSON.parse(text);
  if (typeof v !== "object" || v === null || Array.isArray(v)) throw new Error("status: the input is not a JSON object");
  writeAtomic(join(home(), "usage", "claude-status.json"), text);
  const chat = process.env.STARSHIP_CHAT;
  const agent = process.env.STARSHIP_AGENT;
  if (chat && agent && isName(chat) && isName(agent)) writeAtomic(join(paths.chat(chat), "agents", `${agent}.status.json`), text);
}

/**
 * Runs one command. Never throws. Returns what to print. `stdin` is the input when the caller has read it already.
 * A hook returns the guard's answer for a PreToolUse input, else "". `status` returns "starship".
 */
export async function main(argv: string[], stdin?: string): Promise<string> {
  const [command, ...rest] = argv;
  let out = "";
  try {
    if (command === "hook") out = await hook(rest[0], rest.slice(1), stdin);
    else if (command === "status") await status(stdin);
    else throw new Error(`unknown command ${JSON.stringify(command)}`);
  } catch (e) {
    logError(`${command ?? ""} ${e instanceof Error ? e.message : String(e)}`.trim());
  }
  return command === "status" ? "starship" : out;
}

if (import.meta.main) {
  const out = await main(process.argv.slice(2));
  if (out) process.stdout.write(`${out}\n`);
  process.exit(0);
}

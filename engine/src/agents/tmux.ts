/**
 * tmux adapter: the one place that talks to tmux.
 *
 * Every call goes through `run`, which starts tmux with an argv array and no shell.
 * The only shell string is the session's own command, which tmux needs as one string.
 * The only keys this file ever sends are Enter and Escape. Text goes in by paste.
 */

import { existsSync } from "node:fs";

export class TmuxError extends Error {
  /** What tmux wrote on stderr. */
  readonly stderr: string;

  constructor(message: string, stderr = "") {
    super(stderr ? `${message}: ${stderr}` : message);
    this.name = "TmuxError";
    this.stderr = stderr;
  }
}

interface Result {
  ok: boolean;
  stdout: string;
  stderr: string;
}

/** The single function that runs tmux. */
function run(args: string[]): Result {
  const spawn = () => Bun.spawnSync(["tmux", ...args], { stdin: "ignore", stdout: "pipe", stderr: "pipe" });
  let proc: ReturnType<typeof spawn>;
  try {
    proc = spawn();
  } catch (e) {
    throw new TmuxError("tmux could not start", e instanceof Error ? e.message : String(e));
  }
  return {
    ok: proc.exitCode === 0,
    stdout: proc.stdout.toString(),
    stderr: proc.stderr.toString().trim(),
  };
}

/** Runs tmux and throws a TmuxError with tmux's stderr when it fails. */
function must(args: string[]): string {
  const r = run(args);
  if (!r.ok) throw new TmuxError(`tmux ${args[0]} failed`, r.stderr);
  return r.stdout;
}

/** `=` makes tmux match the session name exactly, never as a prefix. */
const session = (name: string) => `=${name}`;
/** Target for a pane: the exact session's current window and pane. */
const target = (name: string) => `=${name}:`;

const SAFE = /^[A-Za-z0-9_@%+=:,./-]+$/;

/** Quotes one word for a POSIX shell. Plain words stay as they are. */
export function shellQuote(s: string): string {
  if (SAFE.test(s)) return s;
  return `'${s.replaceAll("'", `'\\''`)}'`;
}

export interface NewSession {
  name: string;
  cwd: string;
  /** argv of the program to run. Each item is quoted for tmux's shell. */
  command: string[];
  env?: Record<string, string>;
  width?: number;
  height?: number;
}

/** Starts a detached session that runs `command`. The session ends when the command ends. */
export function newSession(o: NewSession): void {
  if (o.command.length === 0) throw new TmuxError("tmux new-session needs a command");
  // tmux falls back to another folder when cwd is missing. A missing folder is an error here.
  if (!existsSync(o.cwd)) throw new TmuxError("tmux new-session needs an existing cwd", o.cwd);
  const args = [
    "new-session",
    "-d",
    "-s",
    o.name,
    "-x",
    String(o.width ?? 200),
    "-y",
    String(o.height ?? 50),
    "-c",
    o.cwd,
  ];
  for (const [k, v] of Object.entries(o.env ?? {})) args.push("-e", `${k}=${v}`);
  args.push(o.command.map(shellQuote).join(" "));
  must(args);
}

export function hasSession(name: string): boolean {
  return run(["has-session", "-t", session(name)]).ok;
}

/** Ends a session. Nothing happens when it is already gone. */
export function kill(name: string): void {
  if (!hasSession(name)) return;
  const r = run(["kill-session", "-t", session(name)]);
  if (!r.ok && hasSession(name)) throw new TmuxError("tmux kill-session failed", r.stderr);
}

/** Names of the sessions that start with `prefix`. Empty when no tmux server runs. */
export function list(prefix: string): string[] {
  const r = run(["list-sessions", "-F", "#{session_name}"]);
  if (!r.ok) {
    // With no server there is no session. Any other failure is a real error.
    if (/no server running|error connecting|no sessions/i.test(r.stderr)) return [];
    throw new TmuxError("tmux list-sessions failed", r.stderr);
  }
  return r.stdout
    .split("\n")
    .filter((n) => n !== "" && n.startsWith(prefix));
}

let counter = 0;

/**
 * Pastes one line into a session and presses Enter.
 * A newline would submit early, so a text with one is refused.
 */
export function paste(name: string, text: string): void {
  if (/[\r\n]/.test(text)) throw new TmuxError("paste takes one line: the text has a line break");
  const buffer = `starship-${process.pid}-${Date.now().toString(36)}-${counter++}`;
  must(["set-buffer", "-b", buffer, "--", text]);
  try {
    must(["paste-buffer", "-p", "-d", "-b", buffer, "-t", target(name)]);
  } catch (e) {
    // paste-buffer deletes the buffer only when it works.
    run(["delete-buffer", "-b", buffer]);
    throw e;
  }
  // The tool must take the paste in before Enter arrives.
  Bun.sleepSync(300);
  must(["send-keys", "-t", target(name), "Enter"]);
}

/** Presses Escape in a session. */
export function escape(name: string): void {
  must(["send-keys", "-t", target(name), "Escape"]);
}

/** The last `lines` lines of history plus the visible screen, as text. */
export function capture(name: string, lines = 200): string {
  return must(["capture-pane", "-p", "-S", `-${lines}`, "-t", target(name)]);
}

/** The argv a terminal runs to attach to the session. */
export function attachCommand(name: string): string[] {
  return ["tmux", "attach", "-t", name];
}

/**
 * Opens a real terminal window that attaches to an agent's tmux session (decision record: agents in tmux).
 * iTerm when it is installed, Terminal.app when it is not.
 */
import { existsSync } from "node:fs";

export type TerminalApp = "iterm" | "terminal";

export interface RunResult {
  exitCode: number;
  stderr: string;
}

export interface OpenTerminalOptions {
  app?: TerminalApp;
  itermInstalled?: () => boolean;
  /** Runs one command. Tests pass a fake, so no window opens. */
  run?: (argv: string[]) => RunResult;
}

const SESSION = /^[A-Za-z0-9_.-]+$/;

export const defaultItermInstalled = (): boolean => existsSync("/Applications/iTerm.app");

export const defaultRun = (argv: string[]): RunResult => {
  const r = Bun.spawnSync(argv, { stdin: "ignore", stdout: "ignore", stderr: "pipe" });
  return { exitCode: r.exitCode, stderr: r.stderr.toString() };
};

/** The AppleScript lines, one per -e argument. The session name was validated before it gets here. */
function script(app: TerminalApp, session: string): string[] {
  const cmd = `tmux attach -t ${session}`;
  if (app === "iterm") {
    return [
      'tell application "iTerm"',
      "activate",
      "create window with default profile",
      `tell current session of current window to write text "${cmd}"`,
      "end tell",
    ];
  }
  return ['tell application "Terminal"', "activate", `do script "${cmd}"`, "end tell"];
}

export function openTerminal(session: string, o: OpenTerminalOptions = {}): { app: TerminalApp } {
  if (typeof session !== "string" || !SESSION.test(session)) {
    throw new Error(`bad session name: ${JSON.stringify(session)} (letters, digits, _ . - only)`);
  }
  const app: TerminalApp = o.app ?? ((o.itermInstalled ?? defaultItermInstalled)() ? "iterm" : "terminal");
  const argv = ["osascript", ...script(app, session).flatMap((line) => ["-e", line])];
  const r = (o.run ?? defaultRun)(argv);
  if (r.exitCode !== 0) {
    throw new Error(`could not open ${app === "iterm" ? "iTerm" : "Terminal"} for ${session}: ${r.stderr.trim() || `exit ${r.exitCode}`}`);
  }
  return { app };
}

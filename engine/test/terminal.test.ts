import { describe, expect, test } from "bun:test";
import { openTerminal } from "../src/terminal.ts";

type Call = string[];
const fake = (exitCode = 0, stderr = "") => {
  const calls: Call[] = [];
  return { calls, run: (argv: string[]) => (calls.push(argv), { exitCode, stderr }) };
};
const script = (argv: string[]) => argv.slice(1).join("\n");

describe("terminal", () => {
  test("iTerm opens a new window that attaches to the session", () => {
    const f = fake();
    const r = openTerminal("ss-recipes-worker-a", { itermInstalled: () => true, run: f.run });
    expect(r).toEqual({ app: "iterm" });
    expect(f.calls.length).toBe(1);
    expect(f.calls[0]?.[0]).toBe("osascript");
    const s = script(f.calls[0] ?? []);
    expect(s).toContain('tell application "iTerm"');
    expect(s).toContain("create window with default profile");
    expect(s).toContain('write text "tmux attach -t ss-recipes-worker-a"');
  });

  test("D14: iTerm is not installed, so Terminal.app opens instead", () => {
    const f = fake();
    const r = openTerminal("ss-recipes-worker-a", { itermInstalled: () => false, run: f.run });
    expect(r).toEqual({ app: "terminal" });
    const s = script(f.calls[0] ?? []);
    expect(s).toContain('tell application "Terminal"');
    expect(s).toContain('do script "tmux attach -t ss-recipes-worker-a"');
    expect(s).not.toContain("iTerm");
  });

  test("the app option forces one app", () => {
    const f = fake();
    expect(openTerminal("a", { app: "terminal", itermInstalled: () => true, run: f.run })).toEqual({ app: "terminal" });
    expect(openTerminal("a", { app: "iterm", itermInstalled: () => false, run: f.run })).toEqual({ app: "iterm" });
  });

  test("a session name with a quote, a space, a semicolon or a newline never reaches a script", () => {
    for (const bad of ['a"b', "a b", "a;b", "a\nb", "", 'x" & do shell script "rm -rf ~', "$(id)", "a`b"]) {
      const f = fake();
      expect(() => openTerminal(bad, { itermInstalled: () => true, run: f.run })).toThrow(/session name/);
      expect(f.calls).toEqual([]);
    }
  });

  test("a failed run throws with the runner's stderr", () => {
    const f = fake(1, "execution error: not allowed");
    expect(() => openTerminal("ss-a-b", { itermInstalled: () => true, run: f.run })).toThrow(/not allowed/);
  });
});

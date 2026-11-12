import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import {
  claudeScreen,
  claudeSettings,
  claudeStart,
  parseClaudeHook,
  parseClaudeStatusLine,
  readClaudeTranscript,
  writeClaudeSettings,
} from "../src/agents/claude.ts";
import { drop, fixture, tempDir } from "./helpers.ts";

const raw = (...p: string[]) => readFileSync(fixture("claude", ...p), "utf8");
const SID = "40cb1d49-ec61-4fc8-90dc-ca398e7a8d15";
const dirs: string[] = [];
const temp = () => {
  const d = tempDir();
  dirs.push(d);
  return d;
};
afterEach(() => {
  while (dirs.length) drop(dirs.pop() as string); // pop on a non-empty list always gives a string
});

describe("claudeStart", () => {
  test("the argv, in order", () => {
    expect(claudeStart({ settingsPath: "/s/settings.json" })).toEqual(["claude", "--settings", "/s/settings.json"]);
    expect(
      claudeStart({ bin: "/x/claude", settingsPath: "/s.json", promptFile: "/p.md", model: "opus", permissionMode: "auto", sessionId: "abc" }),
    ).toEqual(["/x/claude", "--settings", "/s.json", "--append-system-prompt-file", "/p.md", "--model", "opus", "--permission-mode", "auto", "--session-id", "abc"]);
  });

  test("resume instead of a new session id", () => {
    const a = claudeStart({ settingsPath: "/s.json", resume: SID });
    expect(a.slice(-2)).toEqual(["--resume", SID]);
    expect(a).not.toContain("--session-id");
  });

  test("both a session id and resume throws", () => {
    expect(() => claudeStart({ settingsPath: "/s.json", sessionId: "a", resume: "b" })).toThrow(/both/);
  });

  test("extra flags come last, after every other flag", () => {
    const a = claudeStart({ settingsPath: "/s.json", model: "opus", resume: SID, extra: ["--setting-sources", "project,local"] });
    expect(a).toEqual(["claude", "--settings", "/s.json", "--model", "opus", "--resume", SID, "--setting-sources", "project,local"]);
    expect(claudeStart({ settingsPath: "/s.json", extra: [] })).toEqual(["claude", "--settings", "/s.json"]);
  });
});

describe("claudeSettings", () => {
  const o = { hookCommand: "starship hook claude", statusCommand: "starship status claude" };

  test("hooks for six events and the status line", () => {
    const s = claudeSettings(o) as {
      hooks: Record<string, { matcher?: string; hooks: { type: string; command: string }[] }[]>;
      statusLine: unknown;
    };
    expect(Object.keys(s.hooks).sort()).toEqual(["Notification", "PreToolUse", "SessionEnd", "SessionStart", "Stop", "UserPromptSubmit"]);
    for (const list of Object.values(s.hooks)) expect(list[0]?.hooks).toEqual([{ type: "command", command: "starship hook claude" }]);
    expect(s.hooks.PreToolUse?.[0]?.matcher).toBe("*");
    expect(s.statusLine).toEqual({ type: "command", command: "starship status claude" });
  });

  test("writes the file with mode 0600 and leaves no temp file", () => {
    const dir = temp();
    const path = join(dir, "sess", "settings.json");
    writeClaudeSettings(path, o);
    expect(JSON.parse(readFileSync(path, "utf8"))).toEqual(JSON.parse(JSON.stringify(claudeSettings(o))));
    expect(statSync(path).mode & 0o777).toBe(0o600);
    expect(readdirSync(join(dir, "sess"))).toEqual(["settings.json"]);
    writeClaudeSettings(path, { hookCommand: "other", statusCommand: "s" });
    expect(readFileSync(path, "utf8")).toContain('"other"');
    expect(statSync(path).mode & 0o777).toBe(0o600);
  });
});

describe("parseClaudeHook: contract with the real hook inputs", () => {
  const dumpPath = (name: string) => (JSON.parse(raw(name)) as { transcript_path: string }).transcript_path;

  test("hook-session-start.json", () => {
    expect(parseClaudeHook(raw("hook-session-start.json"))).toEqual({
      kind: "sessionStart",
      sessionId: SID,
      transcriptPath: dumpPath("hook-session-start.json"),
      cwd: "/work/demo",
      source: "startup",
      backgroundTasks: 0,
    });
  });

  test("hook-session-start-resume.json", () => {
    const h = parseClaudeHook(raw("hook-session-start-resume.json"));
    expect(h.kind).toBe("sessionStart");
    expect(h.source).toBe("resume");
    expect(h.sessionId).toBe(SID);
  });

  test("hook-user-prompt-submit.json", () => {
    expect(parseClaudeHook(raw("hook-user-prompt-submit.json"))).toEqual({
      kind: "promptSubmit",
      sessionId: SID,
      transcriptPath: dumpPath("hook-user-prompt-submit.json"),
      cwd: "/work/demo",
      prompt: "Reply with the single word hello. Do not use any tool.",
      permissionMode: "auto",
      backgroundTasks: 0,
    });
  });

  test("hook-stop.json", () => {
    expect(parseClaudeHook(raw("hook-stop.json"))).toEqual({
      kind: "turnEnd",
      sessionId: SID,
      transcriptPath: dumpPath("hook-stop.json"),
      cwd: "/work/demo",
      reply: "hello",
      permissionMode: "auto",
      backgroundTasks: 0,
    });
  });

  test("hook-pre-tool-use.json", () => {
    expect(parseClaudeHook(raw("hook-pre-tool-use.json"))).toEqual({
      kind: "toolUse",
      sessionId: SID,
      transcriptPath: dumpPath("hook-pre-tool-use.json"),
      cwd: "/work/demo",
      permissionMode: "auto",
      tool: {
        name: "Bash",
        input: { command: "sleep 40", description: "Sleep 40 seconds in background", run_in_background: true },
        id: "toolu_01NRkoHGJhgWwMoustbn2Go4",
      },
      backgroundTasks: 0,
    });
  });

  test("a turn that ends while a background shell runs counts it", () => {
    const j = JSON.parse(raw("hook-stop.json"));
    j.background_tasks = [{ id: "bik12j9se" }, { id: "x" }];
    expect(parseClaudeHook(JSON.stringify(j)).backgroundTasks).toBe(2);
  });

  test("Notification and SessionEnd", () => {
    const base = JSON.parse(raw("hook-stop.json"));
    const n = parseClaudeHook(JSON.stringify({ ...base, hook_event_name: "Notification", message: "Claude needs your permission to use Bash", title: "t" }));
    expect(n.kind).toBe("notification");
    expect(n.message).toBe("Claude needs your permission to use Bash");
    const e = parseClaudeHook(JSON.stringify({ session_id: "s", hook_event_name: "SessionEnd", reason: "other" }));
    expect(e).toMatchObject({ kind: "sessionEnd", sessionId: "s", backgroundTasks: 0 });
  });

  test("unknown extra keys are ignored", () => {
    const j = { ...JSON.parse(raw("hook-stop.json")), brand_new_key: { a: 1 } };
    const h = parseClaudeHook(JSON.stringify(j));
    expect(h.kind).toBe("turnEnd");
    expect("brand_new_key" in h).toBe(false);
  });

  test("errors: not JSON, not an object, no event name, an unknown event", () => {
    expect(() => parseClaudeHook("not json {")).toThrow(/not JSON/);
    expect(() => parseClaudeHook("")).toThrow(/not JSON/);
    expect(() => parseClaudeHook("[1]")).toThrow(/object/);
    expect(() => parseClaudeHook('{"session_id":"x"}')).toThrow(/hook_event_name/);
    expect(() => parseClaudeHook('{"hook_event_name":"Banana"}')).toThrow(/Banana/);
  });
});

describe("parseClaudeStatusLine: contract with the real status line inputs", () => {
  test("statusline.json", () => {
    expect(parseClaudeStatusLine(raw("statusline.json"))).toEqual({
      sessionId: "873588b0-0342-44ab-b0ff-8aef91b44c69",
      model: "claude-haiku-5-5",
      contextPct: 6,
      windows: [
        { name: "five_hour", usedPct: 100, resetsAt: 1794457800 },
        { name: "seven_day", usedPct: 73, resetsAt: 1794848400 },
      ],
      costUsd: 0,
    });
  });

  test("statusline-no-limits.json: no rate_limits gives no windows, and a null percentage stays null", () => {
    expect(parseClaudeStatusLine(raw("statusline-no-limits.json"))).toEqual({
      sessionId: "873588b0-0342-44ab-b0ff-8aef91b44c69",
      model: "claude-haiku-5-5",
      contextPct: null,
      windows: [],
      costUsd: 0,
    });
  });

  test("any other key of rate_limits is a window", () => {
    const j = JSON.parse(raw("statusline.json"));
    j.rate_limits.seven_day_opus = { used_percentage: 5, resets_at: 1 };
    j.rate_limits.junk = "x";
    expect(parseClaudeStatusLine(JSON.stringify(j)).windows.map((w) => w.name)).toEqual(["five_hour", "seven_day", "seven_day_opus"]);
  });

  test("errors", () => {
    expect(() => parseClaudeStatusLine("nope")).toThrow(/not JSON/);
    expect(() => parseClaudeStatusLine("3")).toThrow(/object/);
  });
});

describe("readClaudeTranscript: contract with the real transcript", () => {
  test("transcript.jsonl: only user and assistant text, in order", () => {
    const t = readClaudeTranscript(fixture("claude", "transcript.jsonl"));
    expect(t.lines).toBe(raw("transcript.jsonl").trimEnd().split("\n").length);
    const [first, second, third] = t.turns;
    expect(first).toEqual({ role: "user", text: "Reply with the single word hello. Do not use any tool.", at: "2026-11-12T04:21:52.856Z" });
    expect(second).toEqual({ role: "assistant", text: "hello", at: "2026-11-12T04:21:54.701Z" });
    expect(third?.role).toBe("user");
    // thinking blocks, tool_use blocks and tool_result blocks never appear
    const starts = ["user:Reply with", "assistant:hello", "user:Write the", "assistant:1\n2\n3", "user:Run the sh", "assistant:The harness", "assistant:The 40-seco", "user:<task-noti"];
    expect(t.turns.length).toBe(starts.length);
    starts.forEach((p, i) => expect(((t.turns[i]?.role ?? "") + ":" + (t.turns[i]?.text ?? "")).startsWith(p)).toBe(true));
    expect(t.turns[3]?.text.split("\n").length).toBe(400);
  });

  test("fromLine reads only what is new", () => {
    const all = readClaudeTranscript(fixture("claude", "transcript.jsonl"));
    const rest = readClaudeTranscript(fixture("claude", "transcript.jsonl"), 50);
    expect(rest.lines).toBe(all.lines);
    expect(rest.turns.map((x) => x.text.slice(0, 8))).toEqual(["Run the ", "The harn", "The 40-s", "<task-no"]);
    expect(rest.turns.length).toBeLessThan(all.turns.length);
    expect(readClaudeTranscript(fixture("claude", "transcript.jsonl"), all.lines)).toEqual({ lines: all.lines, turns: [] });
  });

  test("a broken last line is skipped and not counted, so the next read picks it up", () => {
    const dir = temp();
    const p = join(dir, "t.jsonl");
    const a = JSON.stringify({ type: "user", message: { role: "user", content: "one" }, timestamp: "T1" });
    const b = JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "two" }] } });
    writeFileSync(p, a + "\n" + b.slice(0, 20));
    const first = readClaudeTranscript(p);
    expect(first).toEqual({ lines: 1, turns: [{ role: "user", text: "one", at: "T1" }] });
    writeFileSync(p, a + "\n" + b + "\n");
    const next = readClaudeTranscript(p, first.lines);
    expect(next).toEqual({ lines: 2, turns: [{ role: "assistant", text: "two", at: null }] });
  });

  test("a broken line in the middle is skipped; unknown kinds, blank lines and joined text blocks", () => {
    const dir = temp();
    const p = join(dir, "t.jsonl");
    const lines = [
      "{ broken",
      "",
      JSON.stringify({ type: "mystery", message: { role: "user", content: "no" } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "text", text: "a" }, { type: "thinking", thinking: "x" }, { type: "text", text: "b" }] } }),
      JSON.stringify({ type: "assistant", message: { role: "assistant", content: [{ type: "tool_use", id: "t", name: "Bash", input: {} }] } }),
    ];
    writeFileSync(p, lines.join("\n") + "\n");
    const t = readClaudeTranscript(p);
    expect(t.turns).toEqual([{ role: "assistant", text: "a\nb", at: null }]);
    expect(t.lines).toBe(5);
  });

  test("a missing file throws", () => {
    expect(() => readClaudeTranscript(join(temp(), "nope.jsonl"))).toThrow();
    expect(existsSync(join(temp(), "nope.jsonl"))).toBe(false);
  });
});

describe("claudeScreen: contract with the real screens", () => {
  const screen = (n: string) => claudeScreen(readFileSync(fixture("claude", "screens", n), "utf8"));
  test("trust.txt", () => expect(screen("trust.txt")).toBe("trust"));
  test("ready.txt", () => expect(screen("ready.txt")).toBe("ready"));
  test("busy.txt", () => expect(screen("busy.txt")).toBe("busy"));
  test("dialog.txt: a dialog over the prompt", () => expect(screen("dialog.txt")).toBe("dialog"));
  // permission.txt is NOT a capture. It is made from the description of Claude Code's permission prompt ("❯ 1. Yes", the footer
  // "Esc to cancel · Tab to amend"). It was never seen in a real session, so it may differ from the real screen in its other lines.
  test("permission.txt (not a capture): a permission prompt is `permission`, not `ready`", () => expect(screen("permission.txt")).toBe("permission"));
  test("a permission prompt under a spinner, or with old output above, is still `permission`", () => {
    const text = readFileSync(fixture("claude", "screens", "permission.txt"), "utf8");
    expect(claudeScreen(`· Working… (3s · esc to interrupt)\n${text}`)).toBe("permission");
    expect(claudeScreen(`──────────\n❯ \n──────────\n${text}`)).toBe("permission");
  });
  test("the dialog keeps its own footer: `❯ 1. Yes` with `Enter to confirm` is a dialog, not a permission prompt", () => {
    expect(screen("dialog.txt")).toBe("dialog");
    expect(claudeScreen("  Do you want to proceed?\n  ❯ 1. Yes\n    2. No\n  Enter to confirm · Esc to cancel\n")).toBe("dialog");
  });
  test("a finished turn's busy line far above the prompt does not make the screen busy", () => {
    const old = ["· Working… (3s · esc to interrupt)", "⏺ done", ...Array.from({ length: 14 }, (_, i) => `line ${i}`), "──────────", "❯ ", "──────────", "  sst"].join("\n");
    expect(claudeScreen(old)).toBe("ready");
  });
  test("a dialog is any screen with the confirm footer that is not the trust question", () => {
    expect(claudeScreen("  Pick one\n  ❯ 1. A\n    2. B\n  Enter to confirm · Esc to cancel\n")).toBe("dialog");
  });
  test("the trust question stays `trust`, though it has the same footer", () => {
    expect(screen("trust.txt")).toBe("trust");
  });
  test("a footer far up in old output does not make a dialog", () => {
    const old = ["  Pick one", "  Enter to confirm · Esc to cancel", ...Array.from({ length: 12 }, (_, i) => `line ${i}`), "──────────", "❯ ", "──────────"].join("\n");
    expect(claudeScreen(old)).toBe("ready");
  });
  test("anything else is unknown", () => {
    expect(claudeScreen("")).toBe("unknown");
    expect(claudeScreen("$ ls\nfoo bar\n")).toBe("unknown");
  });
});

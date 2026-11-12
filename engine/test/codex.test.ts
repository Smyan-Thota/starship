import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { codexScreen, codexStart, findCodexRollout, parseCodexNotify, readCodexRollout } from "../src/agents/codex.ts";
import { drop, fixture, tempDir } from "./helpers.ts";

const SESSION = "01a1ce00-de3f-7770-a27f-7a5ba10b8623";
const TURN = "01a1ce01-1598-7e82-b4f8-ab791e2fbf53";
const rolloutPath = fixture("codex", "rollout.jsonl");

const dirs: string[] = [];
const temp = () => {
  const d = tempDir("starship-codex-");
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) drop(d);
});

describe("codexStart", () => {
  test("builds the start argv", () => {
    expect(codexStart({ cwd: "/work/demo", notify: ["/bin/hook", "codex"] })).toEqual([
      "codex",
      "-C",
      "/work/demo",
      "-c",
      'notify=["/bin/hook","codex"]',
    ]);
  });

  test("adds model and effort, and extra arguments last", () => {
    expect(codexStart({ bin: "/opt/codex", cwd: "/w", notify: ["h"], model: "luna", effort: "high", extra: ["--search"] })).toEqual([
      "/opt/codex",
      "-C",
      "/w",
      "-c",
      'notify=["h"]',
      "-m",
      "luna",
      "-c",
      "model_reasoning_effort=high",
      "--search",
    ]);
  });

  test("a resume puts `resume <id>` right after the binary", () => {
    const argv = codexStart({ cwd: "/w", notify: ["h"], resume: SESSION });
    expect(argv.slice(0, 3)).toEqual(["codex", "resume", SESSION]);
    expect(argv).toContain("-C");
  });

  test("the notify value keeps quotes and spaces in one argument", () => {
    const argv = codexStart({ cwd: "/w", notify: ['/a b/hook', 'say "x"'] });
    const value = argv[argv.indexOf("-c") + 1] ?? "";
    expect(value.startsWith("notify=")).toBe(true);
    expect(JSON.parse(value.slice("notify=".length))).toEqual(["/a b/hook", 'say "x"']);
  });
});

describe("parseCodexNotify", () => {
  test("the real notify payload", () => {
    const arg = readFileSync(fixture("codex", "notify.json"), "utf8");
    expect(parseCodexNotify(arg)).toEqual({
      kind: "turnEnd",
      threadId: SESSION,
      turnId: TURN,
      cwd: "/work/demo",
      reply: "hello",
      inputs: ["Reply with the single word hello. Do not run any command."],
    });
  });

  test("missing reply and inputs become empty", () => {
    const got = parseCodexNotify(JSON.stringify({ type: "agent-turn-complete", "thread-id": "t", "turn-id": "u", cwd: "/x" }));
    expect(got).toMatchObject({ reply: "", inputs: [] });
  });

  test("text that is not JSON is refused", () => {
    expect(() => parseCodexNotify("not json")).toThrow(/not JSON/);
  });

  test("another type is refused", () => {
    expect(() => parseCodexNotify(JSON.stringify({ type: "approval-requested", "thread-id": "t" }))).toThrow(/approval-requested/);
  });

  test("a payload without a thread id is refused", () => {
    expect(() => parseCodexNotify(JSON.stringify({ type: "agent-turn-complete", "turn-id": "u" }))).toThrow(/thread-id/);
  });
});

describe("readCodexRollout", () => {
  test("the real rollout file", () => {
    const r = readCodexRollout(rolloutPath);
    expect(r.lines).toBe(17);
    expect(r.sessionId).toBe(SESSION);
    expect(r.cwd).toBe("/work/demo");
    expect(r.turns).toEqual([{ turnId: TURN, complete: true, reply: "hello" }]);
    expect(r.contextWindow).toBe(475000);
    expect(r.totalTokens).toBe(26818);
    expect(r.windows).toEqual([{ name: "primary", usedPct: 12, windowMinutes: 10080, resetsAt: 1794502696 }]);
  });

  test("reading from a later line sees only the new records", () => {
    const r = readCodexRollout(rolloutPath, 16);
    expect(r.lines).toBe(17);
    expect(r.sessionId).toBeNull();
    expect(r.turns).toEqual([{ turnId: TURN, complete: true, reply: "hello" }]);
    expect(r.totalTokens).toBeNull();
    expect(r.windows).toEqual([]);
  });

  test("a turn that has started and not ended is incomplete", () => {
    const dir = temp();
    const lines = readFileSync(rolloutPath, "utf8").trim().split("\n");
    const file = join(dir, "r.jsonl");
    writeFileSync(file, lines.slice(0, 15).join("\n") + "\n");
    const r = readCodexRollout(file);
    expect(r.turns).toEqual([{ turnId: TURN, complete: false, reply: null }]);
    expect(r.totalTokens).toBeNull();
    expect(r.contextWindow).toBe(475000);
  });

  test("a broken last line is skipped and not counted", () => {
    const dir = temp();
    const file = join(dir, "r.jsonl");
    writeFileSync(file, readFileSync(rolloutPath, "utf8") + '{"timestamp": "2026-11-12T04:2');
    const r = readCodexRollout(file);
    expect(r.lines).toBe(17);
    expect(r.turns.length).toBe(1);
  });

  test("a broken line in the middle is skipped", () => {
    const dir = temp();
    const file = join(dir, "r.jsonl");
    const lines = readFileSync(rolloutPath, "utf8").trim().split("\n");
    lines.splice(3, 0, "{broken");
    writeFileSync(file, lines.join("\n") + "\n");
    const r = readCodexRollout(file);
    expect(r.lines).toBe(18);
    expect(r.totalTokens).toBe(26818);
  });

  test("the newest token_count wins, and null rate limits give no windows", () => {
    const dir = temp();
    const file = join(dir, "r.jsonl");
    const tc = (total: number, limits: unknown) =>
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, model_context_window: 1000 }, rate_limits: limits } });
    writeFileSync(
      file,
      [
        tc(10, { primary: { used_percent: 5, window_minutes: 300, resets_at: 100 }, secondary: { used_percent: 50, window_minutes: 10080, resets_at: 200 } }),
        tc(20, null),
      ].join("\n") + "\n",
    );
    const r = readCodexRollout(file);
    expect(r.totalTokens).toBe(20);
    expect(r.contextWindow).toBe(1000);
    expect(r.windows).toEqual([]);
  });

  test("primary and secondary both come back", () => {
    const dir = temp();
    const file = join(dir, "r.jsonl");
    writeFileSync(
      file,
      JSON.stringify({
        type: "event_msg",
        payload: {
          type: "token_count",
          info: null,
          rate_limits: { primary: { used_percent: 5, window_minutes: 300, resets_at: 100 }, secondary: { used_percent: 50.5, window_minutes: 10080, resets_at: 200 } },
        },
      }) + "\n",
    );
    expect(readCodexRollout(file).windows).toEqual([
      { name: "primary", usedPct: 5, windowMinutes: 300, resetsAt: 100 },
      { name: "secondary", usedPct: 50.5, windowMinutes: 10080, resetsAt: 200 },
    ]);
  });

  test("an empty file and a missing file are refused clearly", () => {
    const dir = temp();
    const file = join(dir, "empty.jsonl");
    writeFileSync(file, "");
    expect(readCodexRollout(file)).toMatchObject({ lines: 0, sessionId: null, turns: [], windows: [] });
    expect(() => readCodexRollout(join(dir, "none.jsonl"))).toThrow(/none\.jsonl/);
  });
});

describe("findCodexRollout", () => {
  test("finds the file by session id in YYYY/MM/DD folders", () => {
    const dir = temp();
    const day = join(dir, "2026", "11", "12");
    mkdirSync(day, { recursive: true });
    mkdirSync(join(dir, "2026", "11", "11"), { recursive: true });
    const want = join(day, `rollout-2026-11-12T04-25-40-${SESSION}.jsonl`);
    writeFileSync(want, "");
    writeFileSync(join(day, "rollout-2026-11-12T04-25-40-other.jsonl"), "");
    expect(findCodexRollout(dir, SESSION)).toBe(want);
  });

  test("gives null when no file matches or the folder is missing", () => {
    const dir = temp();
    mkdirSync(join(dir, "2026", "11", "12"), { recursive: true });
    expect(findCodexRollout(dir, SESSION)).toBeNull();
    expect(findCodexRollout(join(dir, "nope"), SESSION)).toBeNull();
  });

  test("an id with path characters finds nothing", () => {
    const dir = temp();
    expect(findCodexRollout(dir, "../x")).toBeNull();
  });
});

describe("codexScreen", () => {
  const screen = (name: string) => readFileSync(fixture("codex", "screens", name), "utf8");

  test("the real update question is `update`", () => {
    expect(codexScreen(screen("update.txt"))).toBe("update");
  });

  test("the real trust question is `trust`, not `update`: it says esc quit", () => {
    expect(codexScreen(screen("trust.txt"))).toBe("trust");
  });

  test("the real first screen is `ready`", () => {
    expect(codexScreen(screen("ready.txt"))).toBe("ready");
  });

  test("a working screen is `busy`", () => {
    expect(codexScreen("• Working (3s • esc to interrupt)\n› Ask Codex to do anything")).toBe("busy");
  });

  test("a finished turn's busy line far above the prompt does not make the screen busy", () => {
    const old = ["• Working (3s • esc to interrupt)", "• done", ...Array.from({ length: 14 }, (_, i) => `line ${i}`), "› Ask Codex to do anything", "  ? for shortcuts"].join("\n");
    expect(codexScreen(old)).toBe("ready");
  });

  test("a bare prompt is not `ready`: the tool's own ready screen has more than the glyph", () => {
    expect(codexScreen("  >_ OpenAI Codex (v0.166.0)\n     /work/demo\n\n›")).toBe("unknown");
  });

  test("anything else is `unknown`", () => {
    expect(codexScreen("")).toBe("unknown");
    expect(codexScreen("loading...")).toBe("unknown");
  });
});

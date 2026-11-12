import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { claudeUsage, codexUsage, effectivePct, limitText, mergeUsage, overThreshold } from "../src/usage/read.ts";
import type { ToolUsage, UsageWindow } from "../src/usage/read.ts";
import { fixture } from "./helpers.ts";

const read = (name: string) => readFileSync(fixture("usage", name), "utf8");
const NOW = 1794400000; // epoch seconds, before both Claude resets and the Codex reset

const claude = (windows: UsageWindow[], at = NOW): ToolUsage => ({ tool: "claude", windows, contextPct: null, at });

describe("claudeUsage", () => {
  test("the real status line input", () => {
    expect(claudeUsage(read("claude-statusline.json"), NOW)).toEqual({
      tool: "claude",
      windows: [
        { name: "five_hour", usedPct: 100, resetsAt: 1794457800 },
        { name: "seven_day", usedPct: 73, resetsAt: 1794848400 },
      ],
      contextPct: 6,
      at: NOW,
    });
  });

  test("the real input without rate_limits gives no windows and a null context", () => {
    expect(claudeUsage(read("claude-statusline-no-limits.json"), NOW)).toEqual({ tool: "claude", windows: [], contextPct: null, at: NOW });
  });

  test("a window with a missing number keeps its name and the number is null", () => {
    const u = claudeUsage(JSON.stringify({ rate_limits: { five_hour: { resets_at: 5 }, seven_day: {} } }), NOW);
    expect(u.windows).toEqual([
      { name: "five_hour", usedPct: null, resetsAt: 5 },
      { name: "seven_day", usedPct: null, resetsAt: null },
    ]);
  });

  test("text that is not JSON is refused", () => {
    expect(() => claudeUsage("nope", NOW)).toThrow(/not JSON/);
  });
});

describe("codexUsage", () => {
  test("the real rollout file", () => {
    const u = codexUsage(read("codex-rollout.jsonl"), NOW);
    expect(u.tool).toBe("codex");
    expect(u.at).toBe(NOW);
    expect(u.windows).toEqual([{ name: "primary", usedPct: 12, resetsAt: 1794502696 }]);
    expect(u.contextPct).toBeCloseTo((26818 / 475000) * 100, 5);
  });

  test("no token_count record gives no windows and a null context", () => {
    const u = codexUsage('{"type":"session_meta","payload":{"id":"x"}}\n{"type":"mystery","payload":{}}\n', NOW);
    expect(u).toEqual({ tool: "codex", windows: [], contextPct: null, at: NOW });
  });

  test("a broken line is skipped", () => {
    const u = codexUsage("{broken\n" + read("codex-rollout.jsonl") + '{"timestamp": "20', NOW);
    expect(u.windows.length).toBe(1);
  });

  test("the newest token_count wins, even with null rate limits", () => {
    const tc = (total: number, limits: unknown) =>
      JSON.stringify({ type: "event_msg", payload: { type: "token_count", info: { total_token_usage: { total_tokens: total }, model_context_window: 1000 }, rate_limits: limits } });
    const u = codexUsage([tc(100, { primary: { used_percent: 9, window_minutes: 300, resets_at: 1 } }), tc(500, null)].join("\n"), NOW);
    expect(u.contextPct).toBe(50);
    expect(u.windows).toEqual([]);
  });
});

describe("effectivePct", () => {
  test("G3: a window whose reset time has passed counts as 0", () => {
    expect(effectivePct({ name: "five_hour", usedPct: 100, resetsAt: NOW - 1 }, NOW)).toBe(0);
    expect(effectivePct({ name: "five_hour", usedPct: 100, resetsAt: NOW }, NOW)).toBe(0);
  });

  test("G3: a window that has not reset keeps its number", () => {
    expect(effectivePct({ name: "five_hour", usedPct: 100, resetsAt: NOW + 1 }, NOW)).toBe(100);
  });

  test("G3: the real input with the clock after the five-hour reset", () => {
    const u = claudeUsage(read("claude-statusline.json"), NOW);
    const later = 1794457800 + 60;
    expect(u.windows.map((w) => effectivePct(w, later))).toEqual([0, 73]);
  });

  test("an unknown number stays null, past reset or not", () => {
    expect(effectivePct({ name: "a", usedPct: null, resetsAt: NOW - 100 }, NOW)).toBeNull();
    expect(effectivePct({ name: "a", usedPct: null, resetsAt: null }, NOW)).toBeNull();
  });

  test("a number with no reset time keeps its value", () => {
    expect(effectivePct({ name: "a", usedPct: 40, resetsAt: null }, NOW)).toBe(40);
  });

  test("a time in milliseconds is read as milliseconds", () => {
    expect(effectivePct({ name: "a", usedPct: 90, resetsAt: NOW + 1000 }, NOW * 1000)).toBe(90);
  });
});

describe("overThreshold", () => {
  test("any window at or over the threshold counts", () => {
    const u = claude([{ name: "a", usedPct: 10, resetsAt: NOW + 5 }, { name: "b", usedPct: 80, resetsAt: NOW + 5 }]);
    expect(overThreshold(u, 80, NOW)).toBe("over");
    expect(overThreshold(u, 81, NOW)).toBe("under");
  });

  test("the real input: five_hour 100 is over 90", () => {
    expect(overThreshold(claudeUsage(read("claude-statusline.json"), NOW), 90, NOW)).toBe("over");
  });

  test("G3: a stale window does not count", () => {
    const u = claude([{ name: "a", usedPct: 100, resetsAt: NOW - 10 }, { name: "b", usedPct: 20, resetsAt: NOW + 10 }]);
    expect(overThreshold(u, 90, NOW)).toBe("under");
  });

  test("G5: no window gives unknown", () => {
    expect(overThreshold(claudeUsage(read("claude-statusline-no-limits.json"), NOW), 90, NOW)).toBe("unknown");
    expect(overThreshold(claude([]), 90, NOW)).toBe("unknown");
  });

  test("G5: windows without numbers give unknown", () => {
    expect(overThreshold(claude([{ name: "a", usedPct: null, resetsAt: NOW + 1 }]), 90, NOW)).toBe("unknown");
  });

  test("G5: a known number under the threshold beside an unknown one is under, a known one over is over", () => {
    const unknown = { name: "u", usedPct: null, resetsAt: null };
    expect(overThreshold(claude([unknown, { name: "k", usedPct: 10, resetsAt: null }]), 90, NOW)).toBe("under");
    expect(overThreshold(claude([unknown, { name: "k", usedPct: 95, resetsAt: null }]), 90, NOW)).toBe("over");
  });
});

describe("mergeUsage", () => {
  const old = claude([{ name: "five_hour", usedPct: 100, resetsAt: NOW + 5 }], NOW - 60);

  test("keeps the older windows when the newer input carries none", () => {
    const newer: ToolUsage = { tool: "claude", windows: [], contextPct: 12, at: NOW };
    expect(mergeUsage(old, newer)).toEqual({ tool: "claude", windows: old.windows, contextPct: 12, at: NOW });
  });

  test("takes the newer windows when it has some", () => {
    const newer = claude([{ name: "five_hour", usedPct: 3, resetsAt: NOW + 9 }]);
    expect(mergeUsage(old, newer).windows).toEqual(newer.windows);
  });

  test("with nothing older, the newer one stands", () => {
    const newer = claude([]);
    expect(mergeUsage(null, newer)).toEqual(newer);
  });

  test("a different tool is not merged", () => {
    const newer: ToolUsage = { tool: "codex", windows: [], contextPct: null, at: NOW };
    expect(mergeUsage(old, newer)).toEqual(newer);
  });

  test("the newer context stays null when it is unknown", () => {
    const withContext: ToolUsage = { ...old, contextPct: 40 };
    expect(mergeUsage(withContext, claude([])).contextPct).toBeNull();
  });
});

describe("limitText", () => {
  // No real sample of the tool's limit message was captured. These are the patterns the module matches.
  test("D12: the usual wordings of a reached limit match", () => {
    expect(limitText("Claude usage limit reached. Your limit will reset at 3pm.")).toBe(true);
    expect(limitText("5-hour limit reached ∙ resets 3pm")).toBe(true);
    expect(limitText("You've hit your usage limit. Try again at 4:12 PM.")).toBe(true);
    expect(limitText("■ You've reached your weekly limit")).toBe(true);
    expect(limitText("USAGE LIMIT REACHED")).toBe(true);
  });

  test("D12: the real ready and update screens do not match", () => {
    expect(limitText(readFileSync(fixture("codex", "screens", "ready.txt"), "utf8"))).toBe(false);
    expect(limitText(readFileSync(fixture("codex", "screens", "update.txt"), "utf8"))).toBe(false);
  });

  test("D12: ordinary text about limits does not match", () => {
    expect(limitText("")).toBe(false);
    expect(limitText("I added a rate limit to the API route.")).toBe(false);
    expect(limitText("The usage limit field is shown in the settings page.")).toBe(false);
  });
});

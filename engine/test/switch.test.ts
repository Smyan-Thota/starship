import { describe, expect, test } from "bun:test";
import { decideSwitch } from "../src/usage/switch.ts";
import type { SwitchWorker } from "../src/usage/switch.ts";
import type { ToolUsage } from "../src/usage/read.ts";

const NOW = 1794400000; // epoch seconds, before every reset below
const LATER = NOW + 3600;

const usage = (tool: "claude" | "codex", pct: number | null, resetsAt: number | null = LATER): ToolUsage => ({
  tool,
  windows: [{ name: "w", usedPct: pct, resetsAt }],
  contextPct: null,
  at: NOW,
});
const low = (tool: "claude" | "codex") => usage(tool, 10);
const high = (tool: "claude" | "codex") => usage(tool, 95);

const worker = (over: Partial<SwitchWorker> = {}): SwitchWorker => ({
  id: "w1",
  chat: "c1",
  tool: "codex",
  taskEnded: true,
  contextPct: null,
  stalledOnLimit: false,
  task: "T1",
  ...over,
});

const input = (
  over: Partial<{ enabled: boolean; usage: { claude: ToolUsage | null; codex: ToolUsage | null }; workers: SwitchWorker[] }> = {},
) => ({
  enabled: true,
  thresholdPct: 90,
  contextRestartPct: 85,
  now: NOW,
  usage: { claude: low("claude"), codex: high("codex") },
  workers: [worker()],
  ...over,
});

describe("G1: a worker on a tool at the threshold moves when its task ends", () => {
  test("G1: codex over, the worker moves to claude", () => {
    expect(decideSwitch(input())).toEqual([{ kind: "move", agent: "w1", chat: "c1", to: "claude", checkFirst: true }]);
  });

  test("G1: it works the other way, claude over, a claude worker moves to codex", () => {
    const r = decideSwitch(input({ usage: { claude: high("claude"), codex: low("codex") }, workers: [worker({ tool: "claude" })] }));
    expect(r).toEqual([{ kind: "move", agent: "w1", chat: "c1", to: "codex", checkFirst: true }]);
  });

  test("G1: the worker waits while its task has not ended", () => {
    expect(decideSwitch(input({ workers: [worker({ taskEnded: false })] }))).toEqual([]);
  });

  test("G1: a worker on the tool that is under does not move", () => {
    expect(decideSwitch(input({ workers: [worker({ tool: "claude" })] }))).toEqual([]);
  });

  test("G1: any window at the threshold counts, and exactly at counts", () => {
    const codex: ToolUsage = {
      tool: "codex",
      windows: [
        { name: "a", usedPct: 5, resetsAt: LATER },
        { name: "b", usedPct: 90, resetsAt: LATER },
      ],
      contextPct: null,
      at: NOW,
    };
    expect(decideSwitch(input({ usage: { claude: low("claude"), codex } }))).toHaveLength(1);
  });

  test("G1: a window past its reset time counts as 0, so no move", () => {
    expect(decideSwitch(input({ usage: { claude: low("claude"), codex: usage("codex", 99, NOW - 1) } }))).toEqual([]);
  });

  test("G1: enabled false turns the move off", () => {
    expect(decideSwitch(input({ enabled: false }))).toEqual([]);
  });

  test("G1: each worker moves, in order, and only the ones whose task ended", () => {
    const r = decideSwitch(
      input({ workers: [worker({ id: "a", chat: "c1" }), worker({ id: "b", chat: "c2", taskEnded: false }), worker({ id: "c", chat: "c3" })] }),
    );
    expect(r.map((a) => (a.kind === "move" ? a.agent : "?"))).toEqual(["a", "c"]);
  });
});

describe("G2: the move runs the in-flight task's check first", () => {
  test("G2: a worker with a task moves with checkFirst true", () => {
    const [a] = decideSwitch(input({ workers: [worker({ task: "T9" })] }));
    expect(a).toMatchObject({ kind: "move", checkFirst: true });
  });

  test("G2: a worker with no task moves with checkFirst false", () => {
    const [a] = decideSwitch(input({ workers: [worker({ task: null })] }));
    expect(a).toMatchObject({ kind: "move", checkFirst: false });
  });
});

describe("G4: both tools over the threshold", () => {
  const both = { claude: high("claude"), codex: high("codex") };

  test("G4: no move, one needsYou per chat", () => {
    const r = decideSwitch(
      input({
        usage: both,
        workers: [worker({ id: "a", chat: "c1" }), worker({ id: "b", chat: "c1", tool: "claude" }), worker({ id: "c", chat: "c2" })],
      }),
    );
    expect(r.map((a) => a.kind)).toEqual(["needsYou", "needsYou"]);
    expect(r.map((a) => a.chat)).toEqual(["c1", "c2"]);
    expect(r[0]).toMatchObject({ agent: "a" });
  });

  test("G4: a worker whose task has not ended causes nothing", () => {
    expect(decideSwitch(input({ usage: both, workers: [worker({ taskEnded: false })] }))).toEqual([]);
  });

  test("G4: the needsYou text names the reason", () => {
    const [a] = decideSwitch(input({ usage: both }));
    expect(a?.kind === "needsYou" && a.text.length > 0).toBe(true);
  });
});

describe("G5: an unknown usage number causes no automatic move", () => {
  test("G5: the target usage is null, no action", () => {
    expect(decideSwitch(input({ usage: { claude: null, codex: high("codex") } }))).toEqual([]);
  });

  test("G5: the target has windows but no numbers, no action", () => {
    expect(decideSwitch(input({ usage: { claude: usage("claude", null), codex: high("codex") } }))).toEqual([]);
  });

  test("G5: the source usage is unknown, no move", () => {
    expect(decideSwitch(input({ usage: { claude: low("claude"), codex: null } }))).toEqual([]);
  });

  test("G5: both unknown, no action", () => {
    expect(decideSwitch(input({ usage: { claude: null, codex: null } }))).toEqual([]);
  });
});

describe("G6: a worker with a full context restarts when its task ends", () => {
  const calm = { claude: low("claude"), codex: low("codex") };

  test("G6: context at the limit gives restart", () => {
    expect(decideSwitch(input({ usage: calm, workers: [worker({ contextPct: 85 })] }))).toEqual([{ kind: "restart", agent: "w1", chat: "c1" }]);
  });

  test("G6: context under the limit gives nothing", () => {
    expect(decideSwitch(input({ usage: calm, workers: [worker({ contextPct: 84.9 })] }))).toEqual([]);
  });

  test("G6: the restart waits for taskEnded", () => {
    expect(decideSwitch(input({ usage: calm, workers: [worker({ contextPct: 99, taskEnded: false })] }))).toEqual([]);
  });

  test("G6: an unknown context causes nothing", () => {
    expect(decideSwitch(input({ usage: calm, workers: [worker({ contextPct: null })] }))).toEqual([]);
  });

  test("G6: a restart still happens when enabled is false", () => {
    expect(decideSwitch(input({ enabled: false, usage: calm, workers: [worker({ contextPct: 90 })] }))).toEqual([
      { kind: "restart", agent: "w1", chat: "c1" },
    ]);
  });

  test("G6: a move wins over a restart, one action per worker", () => {
    const r = decideSwitch(input({ workers: [worker({ contextPct: 95 })] }));
    expect(r).toEqual([{ kind: "move", agent: "w1", chat: "c1", to: "claude", checkFirst: true }]);
  });

  test("G6: the restart applies when the move cannot happen because the target is unknown", () => {
    const r = decideSwitch(input({ usage: { claude: null, codex: high("codex") }, workers: [worker({ contextPct: 95 })] }));
    expect(r).toEqual([{ kind: "restart", agent: "w1", chat: "c1" }]);
  });
});

describe("D12: a worker stalled on a limit moves at once", () => {
  test("D12: it moves without waiting for taskEnded, with checkFirst true", () => {
    const r = decideSwitch(input({ usage: { claude: low("claude"), codex: low("codex") }, workers: [worker({ stalledOnLimit: true, taskEnded: false })] }));
    expect(r).toEqual([{ kind: "move", agent: "w1", chat: "c1", to: "claude", checkFirst: true }]);
  });

  test("D12: it moves even with enabled false", () => {
    const r = decideSwitch(input({ enabled: false, workers: [worker({ stalledOnLimit: true, taskEnded: false })] }));
    expect(r).toEqual([{ kind: "move", agent: "w1", chat: "c1", to: "claude", checkFirst: true }]);
  });

  test("D12: the other tool is over, needsYou", () => {
    const r = decideSwitch(input({ usage: { claude: high("claude"), codex: high("codex") }, workers: [worker({ stalledOnLimit: true, taskEnded: false })] }));
    expect(r).toHaveLength(1);
    expect(r[0]).toMatchObject({ kind: "needsYou", chat: "c1", agent: "w1" });
  });

  test("D12: the other tool is unknown, no action", () => {
    expect(decideSwitch(input({ usage: { claude: null, codex: low("codex") }, workers: [worker({ stalledOnLimit: true, taskEnded: false })] }))).toEqual([]);
  });

  test("D12: a stalled claude worker moves to codex", () => {
    const r = decideSwitch(
      input({ usage: { claude: low("claude"), codex: low("codex") }, workers: [worker({ tool: "claude", stalledOnLimit: true, taskEnded: false })] }),
    );
    expect(r).toEqual([{ kind: "move", agent: "w1", chat: "c1", to: "codex", checkFirst: true }]);
  });

  test("D12: a stalled worker with no task still gets checkFirst true", () => {
    const r = decideSwitch(input({ workers: [worker({ stalledOnLimit: true, taskEnded: false, task: null })] }));
    expect(r[0]).toMatchObject({ kind: "move", checkFirst: true });
  });
});

describe("one action per worker, one needsYou per chat", () => {
  test("a stalled worker with a full context moves once", () => {
    const r = decideSwitch(input({ workers: [worker({ stalledOnLimit: true, contextPct: 99 })] }));
    expect(r).toHaveLength(1);
    expect(r[0]?.kind).toBe("move");
  });
});

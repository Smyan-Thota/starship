import { beforeEach, describe, expect, test } from "bun:test";
import type { AgentPort, AgentSpec, Clock } from "../src/run/ports.ts";
import type { ToolUsage } from "../src/usage/read.ts";
import { UsageSwitch } from "../src/usage/executor.ts";
import type { UsageSwitchDeps } from "../src/usage/executor.ts";
import type { AgentStatus, AgentView, UsageMove } from "../src/types.ts";

const NOW = 1794400000; // epoch seconds
const LATER = NOW + 3600;
const CHAT = "chat-1";

type Tool = "claude" | "codex";

class FakeAgents implements AgentPort {
  log: string[] = [];
  restarts: { chat: string; agent: string; change?: { tool?: Tool; model?: string } }[] = [];
  sent: { agent: string; line: string }[] = [];
  async ensure(_chat: string, _spec: AgentSpec): Promise<void> {}
  async send(_chat: string, agent: string, line: string): Promise<void> {
    this.log.push(`send ${agent}`);
    this.sent.push({ agent, line });
  }
  async interrupt(): Promise<void> {}
  async restart(chat: string, agent: string, change?: { tool?: Tool; model?: string }): Promise<{ resumed: boolean }> {
    this.log.push(`restart ${agent}`);
    this.restarts.push({ chat, agent, change });
    return { resumed: false };
  }
  async stop(): Promise<void> {}
  status(): AgentStatus | null {
    return null;
  }
  mark(): void {}
  agents(): AgentView[] {
    return [];
  }
  on(): () => void {
    return () => {};
  }
}

const usage = (tool: Tool, pct: number | null, o: { resetsAt?: number | null; at?: number } = {}): ToolUsage => ({
  tool,
  windows: [{ name: "w", usedPct: pct, resetsAt: o.resetsAt === undefined ? LATER : o.resetsAt }],
  contextPct: null,
  at: o.at ?? NOW,
});
const evt = (u: ToolUsage) => ({ type: "usage" as const, tool: u.tool, usage: u });

interface W {
  id: string;
  chat: string;
  tool: Tool;
  task: string | null;
  contextPct: number | null;
}

let clockMs: number;
let agents: FakeAgents;
let workers: W[];
let cfg: { enabled: boolean; thresholdPct: number; contextRestartPct: number };
let needs: { chat: string; agent: string | null; text: string }[];
let saved: UsageMove[][];
let checks: { chat: string; task: string }[];
let checkResult: "pass" | "fail";
/** When set, runCheck waits for this to resolve. */
let gate: Promise<void> | null;
let published: number;
let initialMoves: UsageMove[];
let pickupText: string | null;

function make(): UsageSwitch {
  const clock: Clock = { now: () => clockMs };
  const deps: UsageSwitchDeps = {
    agents,
    clock,
    config: () => cfg,
    workers: () => workers,
    runCheck: async (chat, task) => {
      agents.log.push(`check ${task}`);
      checks.push({ chat, task });
      if (gate) await gate;
      return checkResult;
    },
    pickup: (_chat, agent, r) => pickupText ?? `Continue as ${agent}; check ${r ?? "not run"}.`,
    modelFor: (tool) => (tool === "claude" ? "sonnet" : "codex-model"),
    needsYou: (chat, agent, text) => {
      needs.push({ chat, agent, text });
    },
    saveMoves: (m) => {
      saved.push(m);
    },
    loadMoves: () => initialMoves,
    publish: () => {
      published++;
    },
  };
  return new UsageSwitch(deps);
}

beforeEach(() => {
  clockMs = NOW * 1000;
  agents = new FakeAgents();
  workers = [{ id: "worker-a", chat: CHAT, tool: "codex", task: "T1", contextPct: null }];
  cfg = { enabled: true, thresholdPct: 90, contextRestartPct: 85 };
  needs = [];
  saved = [];
  checks = [];
  checkResult = "pass";
  gate = null;
  published = 0;
  initialMoves = [];
  pickupText = null;
});

/** Feeds codex over the threshold and claude under it. */
function codexOver(sw: UsageSwitch) {
  sw.onEvent(evt(usage("claude", 10)));
  sw.onEvent(evt(usage("codex", 95)));
}

describe("G1: a worker moves to the other tool when its own task ends", () => {
  test("G1: nothing moves on the reading alone, then the worker moves at its task end", async () => {
    const sw = make();
    codexOver(sw);
    await sw.idle();
    expect(agents.restarts).toEqual([]);

    await sw.taskEnded(CHAT, "worker-a");
    expect(agents.restarts).toEqual([{ chat: CHAT, agent: "worker-a", change: { tool: "claude", model: "sonnet" } }]);
    expect(agents.sent).toEqual([{ agent: "worker-a", line: "Continue as worker-a; check pass." }]);
  });

  test("G1: the move is recorded, saved and published", async () => {
    const sw = make();
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-a");
    const moves = sw.state().moves;
    expect(moves).toEqual([{ at: new Date(clockMs).getHours().toString().padStart(2, "0") + ":" + new Date(clockMs).getMinutes().toString().padStart(2, "0"), chat: CHAT, agent: "worker-a", from: "codex", to: "claude" }]);
    expect(saved.at(-1)).toEqual(moves);
    expect(published).toBeGreaterThan(0);
  });

  test("G1: only the worker whose task ended moves", async () => {
    workers = [
      { id: "worker-a", chat: CHAT, tool: "codex", task: "T1", contextPct: null },
      { id: "worker-b", chat: CHAT, tool: "codex", task: "T2", contextPct: null },
    ];
    const sw = make();
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-b");
    expect(agents.restarts.map((r) => r.agent)).toEqual(["worker-b"]);
    expect(checks.map((c) => c.task)).toEqual(["T2"]);
  });

  test("G1: a worker on the tool that is under does not move", async () => {
    workers = [{ id: "worker-a", chat: CHAT, tool: "claude", task: "T1", contextPct: null }];
    const sw = make();
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-a");
    expect(agents.restarts).toEqual([]);
  });

  test("G1: with the switch off, no worker moves at its task end", async () => {
    cfg.enabled = false;
    const sw = make();
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-a");
    expect(agents.restarts).toEqual([]);
  });

  test("G1: the pickup text is sent as one line", async () => {
    pickupText = "Line one.\nLine two.\n\nLine three."; // a pickup with line breaks still goes as one line
    const sw = make();
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-a");
    expect(agents.sent[0]?.line).toBe("Line one. Line two. Line three.");
  });
});

describe("G2: the check of the task in flight runs before the move", () => {
  test("G2: runCheck comes before restart, and its result goes into the pickup", async () => {
    checkResult = "fail";
    const sw = make();
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-a");
    expect(agents.log).toEqual(["check T1", "restart worker-a", "send worker-a"]);
    expect(agents.sent[0]?.line).toBe("Continue as worker-a; check fail.");
  });

  test("G2: a worker with no task moves with no check", async () => {
    workers = [{ id: "worker-a", chat: CHAT, tool: "codex", task: null, contextPct: null }];
    const sw = make();
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-a");
    expect(checks).toEqual([]);
    expect(agents.restarts).toHaveLength(1);
    expect(agents.sent[0]?.line).toBe("Continue as worker-a; check not run.");
  });
});

describe("G4: both tools over the threshold", () => {
  test("G4: no move, and the owner is told once for the chat", async () => {
    workers = [
      { id: "worker-a", chat: CHAT, tool: "codex", task: "T1", contextPct: null },
      { id: "worker-b", chat: CHAT, tool: "codex", task: "T2", contextPct: null },
    ];
    const sw = make();
    sw.onEvent(evt(usage("claude", 95)));
    sw.onEvent(evt(usage("codex", 96)));
    await sw.taskEnded(CHAT, "worker-a");
    await sw.taskEnded(CHAT, "worker-b");
    await sw.taskEnded(CHAT, "worker-a");
    expect(agents.restarts).toEqual([]);
    expect(needs).toHaveLength(1);
    expect(needs[0]?.chat).toBe(CHAT);
    expect(needs[0]?.text).toContain("Both tools are over the 90% threshold");
  });

  test("G4: when the situation changes and comes back, the owner is told again", async () => {
    const sw = make();
    sw.onEvent(evt(usage("claude", 95)));
    sw.onEvent(evt(usage("codex", 96)));
    await sw.taskEnded(CHAT, "worker-a");
    expect(needs).toHaveLength(1);
    sw.onEvent(evt(usage("claude", 20)));
    sw.onEvent(evt(usage("claude", 97)));
    await sw.taskEnded(CHAT, "worker-a");
    expect(needs).toHaveLength(2);
  });
});

describe("G6: a full context restarts the worker when its own task ends", () => {
  test("G6: restart with no change of tool, then a pickup line, and no move is recorded", async () => {
    workers = [{ id: "worker-a", chat: CHAT, tool: "codex", task: "T1", contextPct: 90 }];
    const sw = make();
    sw.onEvent(evt(usage("claude", 10)));
    sw.onEvent(evt(usage("codex", 20)));
    await sw.idle();
    expect(agents.restarts).toEqual([]); // not at the end of its task yet

    await sw.taskEnded(CHAT, "worker-a");
    expect(agents.restarts).toEqual([{ chat: CHAT, agent: "worker-a", change: undefined }]);
    expect(agents.sent).toEqual([{ agent: "worker-a", line: "Continue as worker-a; check not run." }]);
    expect(checks).toEqual([]);
    expect(sw.state().moves).toEqual([]);
  });

  test("G6: an unknown context causes no restart", async () => {
    const sw = make();
    await sw.taskEnded(CHAT, "worker-a");
    expect(agents.restarts).toEqual([]);
  });
});

describe("D12: the tool reports its usage limit", () => {
  test("D12: the worker moves at once, with no task end, and its check runs first", async () => {
    const sw = make();
    sw.onEvent(evt(usage("claude", 10)));
    sw.onEvent(evt(usage("codex", 50)));
    sw.onEvent({ type: "stalled", chat: CHAT, agent: "worker-a", reason: "limit" });
    await sw.idle();
    expect(agents.log).toEqual(["check T1", "restart worker-a", "send worker-a"]);
    expect(agents.restarts[0]?.change).toEqual({ tool: "claude", model: "sonnet" });
  });

  test("D12: a stall for the reason quiet does not move anything", async () => {
    const sw = make();
    sw.onEvent(evt(usage("claude", 10)));
    sw.onEvent({ type: "stalled", chat: CHAT, agent: "worker-a", reason: "quiet" });
    await sw.idle();
    expect(agents.restarts).toEqual([]);
  });

  test("D12: when the other tool is over too, nothing moves; it moves when that tool is free again", async () => {
    const sw = make();
    sw.onEvent(evt(usage("claude", 95)));
    sw.onEvent(evt(usage("codex", 100)));
    sw.onEvent({ type: "stalled", chat: CHAT, agent: "worker-a", reason: "limit" });
    await sw.idle();
    expect(agents.restarts).toEqual([]);
    expect(needs).toHaveLength(1);

    sw.onEvent(evt(usage("claude", 30)));
    await sw.idle();
    expect(agents.log).toEqual(["check T1", "restart worker-a", "send worker-a"]);
    expect(needs).toHaveLength(1);
  });

  test("D12: when the other tool's reset time passes, the stalled worker moves at the next reading", async () => {
    const sw = make();
    sw.onEvent(evt(usage("claude", 95, { resetsAt: NOW + 60 })));
    sw.onEvent(evt(usage("codex", 100)));
    sw.onEvent({ type: "stalled", chat: CHAT, agent: "worker-a", reason: "limit" });
    await sw.idle();
    expect(agents.restarts).toEqual([]);

    clockMs += 120 * 1000;
    sw.onEvent(evt(usage("codex", 100)));
    await sw.idle();
    expect(agents.restarts).toHaveLength(1);
  });

  test("D12: a failed check does not stop the move; the pickup carries the result", async () => {
    checkResult = "fail";
    const sw = make();
    sw.onEvent(evt(usage("claude", 10)));
    sw.onEvent({ type: "stalled", chat: CHAT, agent: "worker-a", reason: "limit" });
    await sw.idle();
    expect(agents.sent[0]?.line).toBe("Continue as worker-a; check fail.");
  });

  test("D12: a worker that moved is not moved again by the next reading", async () => {
    const sw = make();
    sw.onEvent(evt(usage("claude", 10)));
    sw.onEvent({ type: "stalled", chat: CHAT, agent: "worker-a", reason: "limit" });
    await sw.idle();
    sw.onEvent(evt(usage("claude", 11)));
    await sw.idle();
    expect(agents.restarts).toHaveLength(1);
  });
});

describe("one worker is never moved twice at the same time", () => {
  test("a second reading while the check runs starts no second move", async () => {
    let open: () => void = () => {};
    gate = new Promise<void>((r) => {
      open = r;
    });
    const sw = make();
    sw.onEvent(evt(usage("claude", 10)));
    sw.onEvent({ type: "stalled", chat: CHAT, agent: "worker-a", reason: "limit" });
    sw.onEvent(evt(usage("claude", 12)));
    sw.onEvent(evt(usage("claude", 13)));
    void sw.taskEnded(CHAT, "worker-a");
    await Promise.resolve();
    expect(checks).toHaveLength(1);
    open();
    await sw.idle();
    expect(checks).toHaveLength(1);
    expect(agents.restarts).toHaveLength(1);
    expect(agents.sent).toHaveLength(1);
    expect(sw.state().moves).toHaveLength(1);
  });

  test("a move that fails tells the owner once and does not record a move", async () => {
    agents.restart = async () => {
      throw new Error("tmux is gone");
    };
    const sw = make();
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-a");
    await sw.taskEnded(CHAT, "worker-a");
    expect(needs).toHaveLength(1);
    expect(needs[0]?.text).toContain("tmux is gone");
    expect(sw.state().moves).toEqual([]);
  });
});

describe("state()", () => {
  test("it has both tools, with windows, an ISO reset time, expired and stale", () => {
    const sw = make();
    sw.onEvent(evt({ tool: "claude", windows: [{ name: "five_hour", usedPct: 40, resetsAt: LATER }, { name: "seven_day", usedPct: 73, resetsAt: NOW - 10 }, { name: "x", usedPct: null, resetsAt: null }], contextPct: null, at: NOW - 60 }));
    sw.onEvent(evt(usage("codex", 20, { at: NOW - 11 * 60 })));
    const s = sw.state();
    expect(s.switchOn).toBe(true);
    expect(s.thresholdPct).toBe(90);
    expect(s.tools.map((t) => t.tool)).toEqual(["claude", "codex"]);
    const claude = s.tools[0];
    expect(claude?.stale).toBe(false);
    expect(claude?.updatedAt).toBe(new Date((NOW - 60) * 1000).toISOString());
    expect(claude?.windows).toEqual([
      { window: "five_hour", usedPct: 40, resetsAt: new Date(LATER * 1000).toISOString(), expired: false },
      // G3: an expired window counts as 0.
      { window: "seven_day", usedPct: 0, resetsAt: new Date((NOW - 10) * 1000).toISOString(), expired: true },
    ]);
    expect(s.tools[1]?.stale).toBe(true);
  });

  test("a tool with no reading shows no windows, no time, and stale", () => {
    const s = make().state();
    expect(s.tools).toEqual([
      { tool: "claude", windows: [], updatedAt: null, stale: true },
      { tool: "codex", windows: [], updatedAt: null, stale: true },
    ]);
  });

  test("a reading with no windows keeps the older windows of that tool", () => {
    const sw = make();
    sw.onEvent(evt(usage("claude", 40)));
    sw.onEvent(evt({ tool: "claude", windows: [], contextPct: 30, at: NOW + 5 }));
    expect(sw.state().tools[0]?.windows).toHaveLength(1);
  });

  test("moves are newest first, at most 50, and the saved ones load at the start", async () => {
    initialMoves = Array.from({ length: 60 }, (_, i) => ({ at: "10:00", chat: "old", agent: `a${i}`, from: "claude" as const, to: "codex" as const }));
    const sw = make();
    expect(sw.state().moves).toHaveLength(50);
    codexOver(sw);
    await sw.taskEnded(CHAT, "worker-a");
    const moves = sw.state().moves;
    expect(moves).toHaveLength(50);
    expect(moves[0]?.agent).toBe("worker-a");
    expect(moves[1]?.agent).toBe("a0");
    expect(saved.at(-1)).toHaveLength(50);
  });

  test("switchOn and thresholdPct follow the config", () => {
    cfg = { enabled: false, thresholdPct: 80, contextRestartPct: 85 };
    const s = make().state();
    expect(s.switchOn).toBe(false);
    expect(s.thresholdPct).toBe(80);
  });
});

import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { Orchestrator, type TaskCommand } from "../src/run/orchestrator.ts";
import type { AgentEvent, AgentPort, AgentSpec } from "../src/run/ports.ts";
import { parseTasks } from "../src/folder/tasks.ts";
import type { AgentStatus, AgentView } from "../src/types.ts";
import { drop, tempDir } from "./helpers.ts";

const CHAT = "chat-1";
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);
const BOSS = { agent: "orchestrator", role: "orchestrator" } as const;
const ADMIN = { agent: "admin", role: "admin" } as const;

class FakeAgents implements AgentPort {
  listeners = new Set<(e: AgentEvent) => void>();
  ensured: string[] = [];
  sent: { agent: string; line: string }[] = [];
  failSend = false;
  async ensure(_chat: string, spec: AgentSpec): Promise<void> {
    this.ensured = [...this.ensured, spec.id];
  }
  async send(_chat: string, agent: string, line: string): Promise<void> {
    if (this.failSend) throw new Error("tmux refuses");
    this.sent = [...this.sent, { agent, line }];
  }
  async interrupt(): Promise<void> {}
  async restart(): Promise<{ resumed: boolean }> {
    return { resumed: true };
  }
  async stop(): Promise<void> {}
  status(): AgentStatus | null {
    return "idle";
  }
  mark(): void {}
  agents(): AgentView[] {
    return [];
  }
  on(l: (e: AgentEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  turnEnd(agent = "orchestrator"): void {
    for (const l of this.listeners) l({ type: "turnEnd", chat: CHAT, agent, reply: "ok", fromTerminal: false });
  }
}

const SPEC: AgentSpec = { id: "orchestrator", role: "orchestrator", tool: "claude", model: "m", cwd: "/tmp", promptFile: null };

const TASKS = [
  "# TASKS",
  "",
  "## Phase 1 — Part 1",
  "",
  "- [x] T001 Do T001 — `src/a.ts` — verify: `bun test a` (in scope #1)",
  "- [ ] T002 Do T002 — `src/b.ts`, `src/c.ts` — verify: `bun test b` (in scope #1)",
  "- [ ] T003 [P] Do T003 — `src/d.ts` — verify: `bun test d` (in scope #2)",
  "Checkpoint: all green — `bun test`",
  "",
  "## Phase 2 — Part 2",
  "",
  "- [ ] T010 Do T010 — `src/e.ts` — verify: `bun test e` (in scope #3)",
  "",
].join("\n");

interface H {
  feat: string;
  agents: FakeAgents;
  orch: Orchestrator;
  calls: string[];
  states: Record<string, string>;
  tasks(): string;
  inboxFiles(): string[];
  /** The file the last pasted line points at. */
  brief(): string;
  flush(): Promise<void>;
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) drop(d);
  dirs = [];
});

function mk(tasks: string | null = TASKS): H {
  const root = tempDir("starship-orch-");
  dirs.push(root);
  const feat = join(root, "docs", "features", "demo");
  mkdirSync(join(feat, "run"), { recursive: true });
  if (tasks !== null) writeFileSync(join(feat, "TASKS.md"), tasks);
  const agents = new FakeAgents();
  const calls: string[] = [];
  const states: Record<string, string> = { T001: "verified", T002: "queued", T003: "queued", T010: "queued" };
  const orch = new Orchestrator({
    agents,
    clock: { now: () => NOW },
    chat: () => ({ featureDir: feat, halted: false }),
    spec: () => SPEC,
    loop: {
      retry: (c, t, by) => void calls.push(`retry ${c} ${t} ${by}`),
      block: (c, t, r) => void calls.push(`block ${c} ${t} ${r}`),
      drop: (c, t, r, by) => void calls.push(`drop ${c} ${t} ${r} ${by}`),
      taskAdded: (c) => void calls.push(`taskAdded ${c}`),
      undecided: (c, t) => void calls.push(`undecided ${c} ${t}`),
      checkpointUndecided: (c) => void calls.push(`checkpointUndecided ${c}`),
    },
    taskState: (_c, t) => states[t] ?? null,
    publish: () => {},
  });
  const flush = async () => {
    for (let i = 0; i < 5; i++) await new Promise((r) => setTimeout(r, 0));
  };
  return {
    feat,
    agents,
    orch,
    calls,
    states,
    tasks: () => readFileSync(join(feat, "TASKS.md"), "utf8"),
    inboxFiles: () => {
      const d = join(feat, "run", "inbox");
      return existsSync(d) ? readdirSync(d) : [];
    },
    brief: () => {
      const line = h0(agents);
      const m = line.match(/(\/\S+\.md)/);
      if (!m?.[1]) throw new Error(`the pasted line points at no file: ${line}`);
      return readFileSync(m[1], "utf8");
    },
    flush,
  };
}
const h0 = (a: FakeAgents) => a.sent[a.sent.length - 1]?.line ?? "";

describe("Orchestrator asks", () => {
  test("T044: an escalated task goes to a brief file with the log tail, the paste is one line, and a task still escalated when the turn ends goes to undecided", async () => {
    const h = mk();
    h.states.T002 = "escalated";
    const tail = Array.from({ length: 200 }, (_, i) => `log line ${i}`).join("\n");
    h.orch.escalated(CHAT, "T002", tail);
    await h.flush();
    expect(h.agents.ensured).toEqual(["orchestrator"]);
    expect(h.agents.sent).toHaveLength(1);
    const line = h0(h.agents);
    expect(line).not.toContain("\n");
    expect(line.length).toBeLessThan(400);
    expect(line).toContain("T002");
    expect(line).not.toContain("log line 100");
    const brief = h.brief();
    expect(brief).toContain("T002");
    expect(brief).toContain("log line 199");
    expect(brief).toContain("starship task retry");
    expect(brief).toContain("starship task block");
    expect(brief).toContain("starship task split");
    expect(h.inboxFiles()).toHaveLength(1);

    h.agents.turnEnd();
    await h.flush();
    expect(h.calls).toEqual(["undecided chat-1 T002"]);
  });

  test("T044: an escalated task that the orchestrator decided is not undecided when the turn ends", async () => {
    const h = mk();
    h.states.T002 = "escalated";
    h.orch.escalated(CHAT, "T002", "tail");
    await h.flush();
    h.states.T002 = "blocked"; // the loop moved it
    h.agents.turnEnd();
    await h.flush();
    expect(h.calls).toEqual([]);
  });

  test("T044: asks go one at a time, and the next one is pasted when the turn of the first ends", async () => {
    const h = mk();
    h.states.T002 = "escalated";
    h.orch.escalated(CHAT, "T002", "tail 1");
    h.orch.checkpointFailed(CHAT, 1, "checkpoint tail");
    h.orch.planChanged(CHAT, ["PLAN.md", "SPEC.md"]);
    await h.flush();
    expect(h.agents.sent).toHaveLength(1);
    expect(h.orch.busy(CHAT)).toBe(true);

    h.agents.turnEnd();
    await h.flush();
    expect(h.agents.sent).toHaveLength(2);
    expect(h.brief()).toContain("checkpoint tail");

    h.agents.turnEnd(); // no task was added to phase 1
    await h.flush();
    expect(h.agents.sent).toHaveLength(3);
    expect(h.brief()).toContain("PLAN.md");
    expect(h.brief()).toContain("SPEC.md");
    expect(h.calls).toEqual(["undecided chat-1 T002", "checkpointUndecided chat-1"]);

    h.agents.turnEnd();
    await h.flush();
    expect(h.orch.busy(CHAT)).toBe(false);
  });

  test("T044: a failed checkpoint with a fix task added to that phase during the turn is not undecided", async () => {
    const h = mk();
    h.orch.checkpointFailed(CHAT, 1, "checkpoint tail");
    await h.flush();
    expect(h.brief()).toContain("starship task add --phase 1");
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 1, text: "Fix the checkpoint", files: ["src/a.ts"], verify: "bun test a", parallel: false }).ok).toBe(true);
    h.agents.turnEnd();
    await h.flush();
    expect(h.calls).toEqual(["taskAdded chat-1"]);

    // A task added to another phase does not count.
    h.orch.checkpointFailed(CHAT, 1, "again");
    await h.flush();
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 2, text: "Other phase", files: ["src/e.ts"], verify: "bun test e", parallel: false }).ok).toBe(true);
    h.agents.turnEnd();
    await h.flush();
    expect(h.calls).toEqual(["taskAdded chat-1", "taskAdded chat-1", "checkpointUndecided chat-1"]);
  });

  test("T044: a fix list goes to a brief that lists every fix with its number, text and source", async () => {
    const h = mk();
    h.orch.fixList(CHAT, 3, [
      { n: 1, text: "Trim the input", from: "F2" },
      { n: 2, text: "Log the error", from: "Note 7" },
    ]);
    await h.flush();
    const line = h0(h.agents);
    expect(line).not.toContain("\n");
    const brief = h.brief();
    expect(brief).toContain("Trim the input");
    expect(brief).toContain("F2");
    expect(brief).toContain("Log the error");
    expect(brief).toContain("Note 7");
    expect(brief).toContain("--phase 3");
    h.agents.turnEnd();
    await h.flush();
    expect(h.calls).toEqual([]);
  });

  test("T044: a paste that tmux refuses ends the ask as undecided, and the next ask still goes", async () => {
    const h = mk();
    h.states.T002 = "escalated";
    h.agents.failSend = true;
    h.orch.escalated(CHAT, "T002", "tail");
    await h.flush();
    expect(h.calls).toEqual(["undecided chat-1 T002"]);
    expect(h.orch.busy(CHAT)).toBe(false);
    h.agents.failSend = false;
    h.orch.checkpointFailed(CHAT, 1, "tail");
    await h.flush();
    expect(h.agents.sent).toHaveLength(1);
  });

  test("T044: a turn end of another agent does not end the ask", async () => {
    const h = mk();
    h.states.T002 = "escalated";
    h.orch.escalated(CHAT, "T002", "tail");
    await h.flush();
    h.agents.turnEnd("worker-a");
    await h.flush();
    expect(h.calls).toEqual([]);
    expect(h.orch.busy(CHAT)).toBe(true);
  });
});

describe("Orchestrator task commands", () => {
  test("T044: add writes the task line, tells the loop, and refuses a task with no verify command", () => {
    const h = mk();
    const r = h.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 1, text: "Trim spaces", files: ["src/b.ts", "src/c.ts"], verify: "bun test b", parallel: true });
    expect(r).toEqual({ ok: true, id: "T004" });
    expect(h.tasks()).toContain("- [ ] T004 [P] Trim spaces — `src/b.ts`, `src/c.ts` — verify: `bun test b`");
    expect(parseTasks(h.tasks()).phases[0]?.tasks.map((t) => t.id)).toEqual(["T001", "T002", "T003", "T004"]);
    expect(h.calls).toEqual(["taskAdded chat-1"]);

    for (const verify of ["", "   ", undefined, null]) {
      const before = h.tasks();
      const bad = h.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 1, text: "No command", files: ["src/x.ts"], verify, parallel: false });
      expect(bad).toEqual({ ok: false, error: "A task needs a verify command that the engine can run" });
      expect(h.tasks()).toBe(before);
    }
    expect(h.calls).toEqual(["taskAdded chat-1"]);

    const noPhase = h.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 9, text: "Lost", files: ["src/x.ts"], verify: "bun test", parallel: false });
    expect(noPhase.ok).toBe(false);
    const noFiles = h.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 1, text: "No files", files: [], verify: "bun test", parallel: false });
    expect(noFiles.ok).toBe(false);
  });

  test("T044: edit changes a queued or an escalated task and refuses a task that has started or is done", () => {
    const h = mk();
    const r = h.orch.taskCommand(CHAT, BOSS, { cmd: "edit", id: "T002", text: "Do T002 better", verify: "bun test b2" });
    expect(r).toEqual({ ok: true });
    expect(h.tasks()).toContain("- [ ] T002 Do T002 better — `src/b.ts`, `src/c.ts` — verify: `bun test b2` (in scope #1)");

    h.states.T003 = "escalated";
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "edit", id: "T003", files: ["src/d.ts", "src/f.ts"] }).ok).toBe(true);
    expect(h.tasks()).toContain("`src/d.ts`, `src/f.ts`");

    for (const state of ["working", "assigned", "checking", "failed", "parked", "blocked", "verified"]) {
      h.states.T002 = state;
      const before = h.tasks();
      const bad = h.orch.taskCommand(CHAT, BOSS, { cmd: "edit", id: "T002", text: "Nope" });
      expect(bad.ok).toBe(false);
      if (!bad.ok) expect(bad.error).toContain(state);
      expect(h.tasks()).toBe(before);
    }
    h.states.T002 = "queued";
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "edit", id: "T002", verify: "" }).ok).toBe(false);
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "edit", id: "T002" }).ok).toBe(false);
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "edit", id: "T099", text: "x" }).ok).toBe(false);
    // The checked task T001 has no state entry in the fake: the box says it is done.
    delete h.states.T001;
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "edit", id: "T001", text: "x" }).ok).toBe(false);
  });

  test("T044: split replaces the task's line by its parts, in place, each queued with the original's files and verify", () => {
    const h = mk();
    const r = h.orch.taskCommand(CHAT, BOSS, { cmd: "split", id: "T002", into: ["First half", "Second half"] });
    expect(r).toEqual({ ok: true, id: "T004" });
    const doc = parseTasks(h.tasks());
    const p1 = doc.phases[0]?.tasks ?? [];
    expect(p1.map((t) => t.id)).toEqual(["T001", "T004", "T005", "T003"]);
    for (const id of ["T004", "T005"]) {
      const t = p1.find((x) => x.id === id);
      expect(t?.files).toEqual(["src/b.ts", "src/c.ts"]);
      expect(t?.verify).toBe("bun test b");
      expect(t?.done).toBe(false);
      expect(t?.trace).toBe("in scope #1");
    }
    expect(p1.find((t) => t.id === "T004")?.text).toBe("First half");
    expect(h.tasks()).not.toContain("T002");
    expect(doc.phases[0]?.checkpoint?.command).toBe("bun test");
    expect(doc.phases[1]?.tasks.map((t) => t.id)).toEqual(["T010"]);
    expect(h.calls).toEqual(["taskAdded chat-1"]);

    h.states.T003 = "working";
    const bad = h.orch.taskCommand(CHAT, BOSS, { cmd: "split", id: "T003", into: ["a", "b"] });
    expect(bad.ok).toBe(false);
    h.states.T010 = "escalated";
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "split", id: "T010", into: ["a", "b"] }).ok).toBe(true);
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "split", id: "T004", into: ["only one"] }).ok).toBe(false);
  });

  test("T044: block, drop and retry go to the loop, and the loop's refusal comes back as a plain error", () => {
    const h = mk();
    h.states.T002 = "escalated";
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "block", id: "T002", reason: "needs the owner" })).toEqual({ ok: true });
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "retry", id: "T002" })).toEqual({ ok: true });
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "drop", id: "T002", reason: "not needed" })).toEqual({ ok: true });
    expect(h.calls).toEqual(["block chat-1 T002 needs the owner", "retry chat-1 T002 orchestrator", "drop chat-1 T002 not needed orchestrator"]);

    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "block", id: "T002", reason: "" }).ok).toBe(false);
    expect(h.orch.taskCommand(CHAT, BOSS, { cmd: "drop", id: "T002", reason: "  " }).ok).toBe(false);

    // The loop says no: it returns false.
    const refuse = mk();
    const orch = new Orchestrator({
      agents: refuse.agents,
      clock: { now: () => NOW },
      chat: () => ({ featureDir: refuse.feat, halted: false }),
      spec: () => SPEC,
      loop: { retry: () => false, block: () => false, drop: () => false, taskAdded: () => {}, undecided: () => {}, checkpointUndecided: () => {} },
      taskState: () => "escalated",
      publish: () => {},
    });
    const r = orch.taskCommand(CHAT, BOSS, { cmd: "retry", id: "T002" });
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.error).toContain("T002");
    // A retry of a task that is not escalated never reaches the loop.
    const h2 = mk();
    const q = h2.orch.taskCommand(CHAT, BOSS, { cmd: "retry", id: "T003" });
    expect(q.ok).toBe(false);
    expect(h2.calls).toEqual([]);
  });

  test("T044: the admin agent may only retry a blocked task and drop, both on the owner's word; every other combination is refused", () => {
    const h = mk();
    h.states.T002 = "blocked";
    expect(h.orch.taskCommand(CHAT, ADMIN, { cmd: "retry", id: "T002" })).toEqual({ ok: true });
    expect(h.orch.taskCommand(CHAT, ADMIN, { cmd: "drop", id: "T002", reason: "the owner said so" })).toEqual({ ok: true });
    expect(h.calls).toEqual(["retry chat-1 T002 owner", "drop chat-1 T002 the owner said so owner"]);

    const before = h.tasks();
    h.states.T003 = "queued";
    const calls = h.calls.length;
    const attempts = [
      h.orch.taskCommand(CHAT, ADMIN, { cmd: "retry", id: "T003" }), // not blocked
      h.orch.taskCommand(CHAT, ADMIN, { cmd: "add", phase: 1, text: "x", files: ["a"], verify: "bun test", parallel: false }),
      h.orch.taskCommand(CHAT, ADMIN, { cmd: "edit", id: "T003", text: "x" }),
      h.orch.taskCommand(CHAT, ADMIN, { cmd: "split", id: "T003", into: ["a", "b"] }),
      h.orch.taskCommand(CHAT, ADMIN, { cmd: "block", id: "T003", reason: "x" }),
      h.orch.taskCommand(CHAT, { agent: "worker-a", role: "worker" } as never, { cmd: "retry", id: "T002" }),
    ];
    for (const r of attempts) {
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).not.toContain("\n");
    }
    expect(h.tasks()).toBe(before);
    expect(h.calls).toHaveLength(calls);
  });

  test("T044: nothing throws out of taskCommand: a missing, unreadable or unknown file and task give a plain error", () => {
    const missing = mk(null);
    const a = missing.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 1, text: "x", files: ["a"], verify: "bun test", parallel: false });
    expect(a.ok).toBe(false);

    const broken = mk("# TASKS\n\n## Phase 1 — One\n\n- [ ] this line cannot be read\n");
    const b = broken.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 1, text: "x", files: ["a"], verify: "bun test", parallel: false });
    expect(b.ok).toBe(false);
    if (!b.ok) expect(b.error).toContain("TASKS.md");

    const h = mk();
    const unknown: TaskCommand[] = [
      { cmd: "retry", id: "T404" },
      { cmd: "drop", id: "T404", reason: "x" },
      { cmd: "block", id: "T404", reason: "x" },
      { cmd: "split", id: "T404", into: ["a", "b"] },
    ];
    for (const c of unknown) {
      const r = h.orch.taskCommand(CHAT, BOSS, c);
      expect(r.ok).toBe(false);
      if (!r.ok) expect(r.error).toContain("T404");
    }
    const multi = h.orch.taskCommand(CHAT, BOSS, { cmd: "add", phase: 1, text: "two\nlines", files: ["a"], verify: "bun test", parallel: false });
    expect(multi.ok).toBe(false);
  });
});

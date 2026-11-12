import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BuildLoop } from "../src/run/loop.ts";
import { Questions } from "../src/run/park.ts";
import type { AgentPort, AgentSpec, CheckPort } from "../src/run/ports.ts";
import type { CheckResult, Job } from "../src/run/queue.ts";
import { readRunState } from "../src/run/state.ts";
import type { AgentStatus, AgentView } from "../src/types.ts";
import { runGit } from "../src/worktree.ts";
import { drop, tempDir } from "./helpers.ts";

/** The text of the turn that an agent starts now: the last line that was sent to it. */
const lineTo = (agents: { sent: { agent: string; line: string }[] }, agent: string): string => [...agents.sent].reverse().find((x) => x.agent === agent)?.line ?? "";

const CHAT = "chat-1";

class FakeAgents implements AgentPort {
  statuses = new Map<string, AgentStatus>();
  sent: { agent: string; line: string }[] = [];
  failNextSend = false;
  async ensure(_c: string, spec: AgentSpec): Promise<void> {
    if (!this.statuses.has(spec.id)) this.statuses.set(spec.id, "idle");
  }
  async send(_c: string, agent: string, line: string): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("tmux refuses");
    }
    this.sent = [...this.sent, { agent, line }];
  }
  async interrupt(): Promise<void> {}
  async restart(): Promise<{ resumed: boolean }> {
    return { resumed: true };
  }
  async stop(): Promise<void> {}
  status(_c: string, agent: string): AgentStatus | null {
    return this.statuses.get(agent) ?? null;
  }
  mark(_c: string, agent: string, status: AgentStatus): void {
    this.statuses.set(agent, status);
  }
  agents(): AgentView[] {
    return [];
  }
  on(): () => void {
    return () => {};
  }
}

class FakeChecks implements CheckPort {
  enqueue(_job: Job): Promise<CheckResult> {
    return new Promise(() => {});
  }
  drop(): number {
    return 0;
  }
}

const PLAN = ["# PLAN", "", "## Goal", "", "A goal.", "", "## In scope", "", "1. Alpha", "", "## Out of scope", "", "- Gamma", "", "## Data", "", "## Interfaces", "", "## Errors", "", "## Edge cases", "", "## Tests", "", "## Rollout", ""].join("\n");
const TASKS = ["# TASKS", "", "## Phase 1 — Part 1", "", "- [ ] T001 Do T001 — `src/a.ts` — verify: `bun test T001` (in scope #1)", "- [ ] T002 Do T002 — `src/a.ts` — verify: `bun test T002` (in scope #1)", ""].join("\n");

interface H {
  wt: string;
  feat: string;
  agents: FakeAgents;
  loop: BuildLoop;
  q: Questions;
  chat: { halted: boolean };
  /** What tellAdmin was given. */
  told: { id: string; line: string }[];
  /** The admin agent's state: lines wait while it is in a turn or gone. */
  admin: { busy: boolean; gone: boolean; delivered: string[] };
  taskAgent: Map<string, string>;
  state: () => ReturnType<typeof readRunState>;
  /** Writes a question to run/questions.md, as the HTTP route does before it calls `asked`. */
  writeQuestion: (n: number, task: string, agent: string, text: string) => void;
}

let h: H;
afterEach(() => drop(h.wt));

function git(cwd: string, ...args: string[]): void {
  const r = runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
}

async function mk(): Promise<H> {
  const wt = tempDir("starship-questions-");
  git(wt, "init", "-q", "-b", "main");
  git(wt, "config", "user.name", "Test");
  git(wt, "config", "user.email", "test@example.com");
  git(wt, "config", "commit.gpgsign", "false");
  const feat = join(wt, "docs", "features", "demo");
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    writeFileSync(join(wt, rel), text);
  };
  write("README.md", "demo\n");
  git(wt, "add", "README.md");
  git(wt, "commit", "-q", "-m", "first");
  write("docs/features/demo/SPEC.md", "# SPEC\n\n## Problem\n\nA problem.\n\n## Scope\n\n- one\n");
  write("docs/features/demo/PLAN.md", PLAN);
  write("docs/features/demo/TASKS.md", TASKS);
  write("docs/features/demo/ACCEPTANCE.md", "# Acceptance\n\n## Behavior\n\n- Alpha works.\n");
  const excl = runGit(wt, ["rev-parse", "--path-format=absolute", "--git-path", "info/exclude"]).stdout.trim();
  mkdirSync(dirname(excl), { recursive: true });
  writeFileSync(excl, "docs/features/demo/run/\n");

  const agents = new FakeAgents();
  const chat = { halted: false };
  const specs: AgentSpec[] = [{ id: "worker-a", role: "worker", tool: "claude", model: "m", cwd: wt, promptFile: null }];
  const loop = new BuildLoop({
    agents,
    checks: new FakeChecks(),
    clock: { now: () => Date.UTC(2026, 10, 11, 12, 0, 0) },
    publish: () => {},
    chat: () => ({ worktree: wt, featureDir: feat, slug: "demo", halted: chat.halted, heavy: () => false }),
    workers: () => specs,
    orchestrator: { escalated: () => {}, checkpointFailed: () => {} },
  });
  const told: H["told"] = [];
  const admin = { busy: false, gone: false, delivered: [] as string[] };
  const taskAgent = new Map<string, string>();
  const q = new Questions({
    agents,
    loop,
    chat: () => ({ featureDir: feat, halted: chat.halted }),
    // As ChatService.tellAdmin does: the line is queued, and it reaches the admin agent when the agent is idle.
    tellAdmin: (_c, id, line) => {
      told.push({ id, line });
      if (!admin.busy && !admin.gone) admin.delivered.push(line);
    },
    taskAgent: (_c, t) => taskAgent.get(t) ?? null,
    publish: () => {},
  });
  const self: H = {
    wt,
    feat,
    agents,
    loop,
    q,
    chat,
    told,
    admin,
    taskAgent,
    state: () => readRunState(feat),
    writeQuestion: (n, task, agent, text) => {
      const file = join(feat, "run", "questions.md");
      mkdirSync(dirname(file), { recursive: true });
      const prev = existsSync(file) ? readFileSync(file, "utf8") : "# Questions\n";
      writeFileSync(file, `${prev}\n## Q${n} · 12:00 · ${agent} · ${task}\n${text}\nStatus: open\n`);
    },
  };
  h = self;
  return self;
}

/** The build runs, T001 is handed to worker-a and its turn started: the task is `working`. */
async function working(x: H): Promise<void> {
  x.loop.start(CHAT);
  await x.loop.settled();
  x.agents.statuses.set("worker-a", "working");
  x.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-a", prompt: lineTo(x.agents, "worker-a"), fromTerminal: false });
  x.taskAgent.set("T001", "worker-a");
  expect(x.state().tasks.T001?.state).toBe("working");
}

const answerFile = (x: H, n: number) => join(x.feat, "run", "inbox", `answer-q${n}.md`);
/** The answer lines the worker got. The first prompt of the task is not one of them. */
const answers = (x: H) => x.agents.sent.filter((s) => s.line.startsWith("Answer to Q"));

describe("T046: a worker asks, the owner answers", () => {
  test("T046: asked parks the task, and tells the admin agent with one line that names the file", async () => {
    await mk();
    await working(h);
    h.writeQuestion(1, "T001", "worker-a", "Include archived recipes?");
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "Include archived recipes?" });
    expect(h.state().tasks.T001?.state).toBe("parked");
    expect(h.state().tasks.T001?.parkedBy).toBe("question");
    expect(h.told).toEqual([{ id: "q1", line: `worker-a asks Q1 about T001. Read ${join(h.feat, "run", "questions.md")} and ask the owner.` }]);
    expect(h.told[0]?.line.includes("\n")).toBe(false);
    // The parked task keeps T002 out: both list src/a.ts.
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.state().tasks.T002).toBeUndefined();
  });

  test("T046: answered writes the answer to run/inbox, sends the worker one line that points at it, and unparks the task", async () => {
    await mk();
    await working(h);
    h.writeQuestion(1, "T001", "worker-a", "Include archived recipes?");
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "Include archived recipes?" });
    const longAnswer = "Exclude them.\nAnd keep the old sort order.";
    await h.q.answered(CHAT, { n: 1, task: "T001", text: longAnswer });
    expect(readFileSync(answerFile(h, 1), "utf8")).toContain("Exclude them.\nAnd keep the old sort order.");
    expect(answers(h)).toHaveLength(1);
    expect(answers(h)[0]?.agent).toBe("worker-a");
    expect(answers(h)[0]?.line).toContain(answerFile(h, 1));
    expect(answers(h)[0]?.line.includes("\n")).toBe(false);
    expect(h.state().tasks.T001?.state).toBe("working");
    expect(h.state().sent).toContain("answer-q1");
  });

  test("T046: an answer is never sent twice, also when answered and Resume come again", async () => {
    await mk();
    await working(h);
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "x?" });
    await h.q.answered(CHAT, { n: 1, task: "T001", text: "yes" });
    await h.q.answered(CHAT, { n: 1, task: "T001", text: "yes" });
    await h.q.resumed(CHAT);
    await h.q.agentBack(CHAT);
    expect(answers(h)).toHaveLength(1);
  });

  test("T046: a paused agent keeps the task parked after the answer, gets the answer file only when it is back", async () => {
    await mk();
    await working(h);
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "x?" });
    await h.loop.pause(CHAT, "worker-a");
    await h.q.answered(CHAT, { n: 1, task: "T001", text: "yes" });
    expect(h.state().tasks.T001?.state).toBe("parked");
    expect(h.state().tasks.T001?.parkedBy).toBe("pause");
    expect(answers(h)).toHaveLength(0);
    await h.loop.resumeAgent(CHAT, "worker-a");
    await h.q.agentBack(CHAT);
    expect(h.state().tasks.T001?.state).toBe("working");
    expect(answers(h)).toHaveLength(1);
  });

  test("T046: a failed send leaves the answer waiting, and the next look sends it once", async () => {
    await mk();
    await working(h);
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "x?" });
    h.agents.failNextSend = true;
    await h.q.answered(CHAT, { n: 1, task: "T001", text: "yes" });
    expect(answers(h)).toHaveLength(0);
    expect(h.state().sent).not.toContain("answer-q1");
    await h.q.resumed(CHAT);
    await h.q.resumed(CHAT);
    expect(answers(h)).toHaveLength(1);
    expect(h.state().sent).toContain("answer-q1");
  });
});

describe("A15: the question is on disk before anyone is told", () => {
  test("A15: the admin agent is in a turn: the line is queued, and it reaches the admin agent when the agent is idle", async () => {
    await mk();
    await working(h);
    h.admin.busy = true;
    h.writeQuestion(1, "T001", "worker-a", "Include archived recipes?");
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "Include archived recipes?" });
    expect(h.state().tasks.T001?.state).toBe("parked");
    expect(readFileSync(join(h.feat, "run", "questions.md"), "utf8")).toContain("Q1 · 12:00 · worker-a · T001");
    expect(h.told).toHaveLength(1);
    expect(h.admin.delivered).toHaveLength(0);
  });

  test("A15: the admin agent is gone: the task is parked and the line is queued all the same", async () => {
    await mk();
    await working(h);
    h.admin.gone = true;
    h.writeQuestion(1, "T001", "worker-a", "x?");
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "x?" });
    expect(h.state().tasks.T001?.state).toBe("parked");
    expect(h.told.map((t) => t.id)).toEqual(["q1"]);
  });

  test("A15: the chat is halted: the question parks the task and tells the admin agent; the answer waits for Resume and goes out once", async () => {
    await mk();
    await working(h);
    h.chat.halted = true;
    h.agents.statuses.set("worker-a", "halted");
    h.writeQuestion(1, "T001", "worker-a", "x?");
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "x?" });
    expect(h.state().tasks.T001?.state).toBe("parked");
    expect(h.told).toHaveLength(1);

    await h.q.answered(CHAT, { n: 1, task: "T001", text: "yes" });
    expect(h.state().tasks.T001?.state).toBe("working");
    expect(answers(h)).toHaveLength(0);
    expect(existsSync(answerFile(h, 1))).toBe(true);
    expect(h.state().sent).not.toContain("answer-q1");

    await h.q.resumed(CHAT); // still halted: nothing goes out
    expect(answers(h)).toHaveLength(0);
    h.chat.halted = false;
    h.agents.statuses.set("worker-a", "idle");
    await h.q.resumed(CHAT);
    await h.q.resumed(CHAT);
    expect(answers(h)).toHaveLength(1);
    expect(answers(h)[0]?.line).toContain(answerFile(h, 1));
  });

  test("A15: the worker is gone when the answer comes: the answer waits, and it goes out when the agent is back, after a new Questions object too", async () => {
    await mk();
    await working(h);
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "x?" });
    h.agents.statuses.set("worker-a", "stopped");
    await h.q.answered(CHAT, { n: 1, task: "T001", text: "yes" });
    expect(answers(h)).toHaveLength(0);
    expect(h.state().tasks.T001?.state).toBe("working");

    // The engine restarts: a new object over the same folder finds the answer in run/inbox.
    const again = new Questions({
      agents: h.agents,
      loop: h.loop,
      chat: () => ({ featureDir: h.feat, halted: false }),
      tellAdmin: () => {},
      taskAgent: (_c, t) => h.taskAgent.get(t) ?? null,
      publish: () => {},
    });
    h.agents.statuses.set("worker-a", "idle");
    await again.agentBack(CHAT);
    await again.resumed(CHAT);
    expect(answers(h)).toHaveLength(1);
    expect(answers(h)[0]?.line).toContain(answerFile(h, 1));
  });

  test("A15: the same question told twice leaves the same one line", async () => {
    await mk();
    await working(h);
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "x?" });
    h.q.asked(CHAT, { n: 1, task: "T001", agent: "worker-a", text: "x?" });
    expect(h.told.map((t) => t.id)).toEqual(["q1", "q1"]);
    expect(new Set(h.told.map((t) => t.line)).size).toBe(1);
    expect(h.state().tasks.T001?.state).toBe("parked");
  });
});

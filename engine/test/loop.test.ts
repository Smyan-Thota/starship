import { afterEach, describe, expect, test } from "bun:test";
import { cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { BuildLoop, activeTask } from "../src/run/loop.ts";
import type { AgentEvent, AgentPort, AgentSpec, CheckPort } from "../src/run/ports.ts";
import type { CheckResult, Job } from "../src/run/queue.ts";
import { type RunState, emptyRunState, readRunState, runStatePath } from "../src/run/state.ts";
import { isInvalid, nextAgent } from "../src/run/states.ts";
import type { AgentStatus, AgentView } from "../src/types.ts";
import { runGit } from "../src/worktree.ts";
import { drop, tempDir } from "./helpers.ts";

const CHAT = "chat-1";

// ───────────────────────────── fakes ─────────────────────────────

class FakeAgents implements AgentPort {
  statuses = new Map<string, AgentStatus>();
  views = new Map<string, AgentView>();
  ensured: string[] = [];
  sent: { agent: string; line: string; sentIdsAtSend: string[] }[] = [];
  interrupts: string[] = [];
  marks: { agent: string; status: AgentStatus }[] = [];
  /** Lets a test read the loop's state at the moment of a send. */
  peek: () => string[] = () => [];
  failNextSend = false;

  async ensure(_chat: string, spec: AgentSpec): Promise<void> {
    this.ensured = [...this.ensured, spec.id];
    if (!this.statuses.has(spec.id)) this.statuses.set(spec.id, "idle");
    this.views.set(spec.id, { id: spec.id, name: spec.id, role: spec.role, tool: spec.tool, model: spec.model, tmux: `sst-${spec.id}`, status: "idle", task: null, prompts: [], history: [] });
  }
  async send(_chat: string, agent: string, line: string): Promise<void> {
    if (this.failNextSend) {
      this.failNextSend = false;
      throw new Error("tmux refuses");
    }
    this.sent = [...this.sent, { agent, line, sentIdsAtSend: this.peek() }];
  }
  async interrupt(_chat: string, agent: string): Promise<void> {
    this.interrupts = [...this.interrupts, agent];
  }
  async restart(): Promise<{ resumed: boolean }> {
    return { resumed: true };
  }
  async stop(): Promise<void> {}
  status(_chat: string, agent: string): AgentStatus | null {
    return this.statuses.get(agent) ?? null;
  }
  mark(_chat: string, agent: string, status: AgentStatus): void {
    this.statuses.set(agent, status);
    this.marks = [...this.marks, { agent, status }];
  }
  agents(): AgentView[] {
    return [...this.views.values()].map((v) => ({ ...v, status: this.statuses.get(v.id) ?? v.status }));
  }
  on(): () => void {
    return () => {};
  }
  /** The port moves an agent's status by the table, as the real sessions do, before the loop hears the event. */
  step(agent: string, event: "turnStart" | "turnEnd"): void {
    const cur = this.statuses.get(agent) ?? "idle";
    const r = nextAgent(cur, event);
    if (!isInvalid(r)) this.statuses.set(agent, r.state);
  }
}

class FakeChecks implements CheckPort {
  jobs: { job: Job; done: boolean; res: (r: CheckResult) => void }[] = [];
  enqueue(job: Job): Promise<CheckResult> {
    return new Promise((res) => {
      this.jobs = [...this.jobs, { job, done: false, res }];
    });
  }
  drop(chat: string): number {
    let n = 0;
    for (const j of this.jobs) {
      if (j.done || j.job.chat !== chat) continue;
      j.done = true;
      n++;
      j.res({ id: j.job.id, outcome: "dropped", exit: null, durationMs: 0, logPath: j.job.logPath });
    }
    return n;
  }
  pending(name?: string): Job[] {
    return this.jobs.filter((j) => !j.done && (name === undefined || j.job.name === name)).map((j) => j.job);
  }
  /** Ends the oldest waiting job of a task (or of a checkpoint: "checkpoint-1"). */
  finish(name: string, outcome: CheckResult["outcome"], logText = ""): Job {
    const j = this.jobs.find((x) => !x.done && x.job.name === name);
    if (!j) throw new Error(`no waiting job named ${name}`);
    j.done = true;
    mkdirSync(dirname(j.job.logPath), { recursive: true });
    writeFileSync(j.job.logPath, logText);
    j.res({ id: j.job.id, outcome, exit: outcome === "pass" ? 0 : outcome === "fail" ? 1 : null, durationMs: 1, logPath: j.job.logPath });
    return j.job;
  }
}

// ───────────────────────────── a chat on disk ─────────────────────────────

const SPEC = "# SPEC\n\n## Problem\n\nA problem.\n\n## Scope\n\n- one\n";
const PLAN = ["# PLAN", "", "## Goal", "", "A goal.", "", "## In scope", "", "1. Alpha", "", "## Out of scope", "", "- Gamma", "", "## Data", "", "## Interfaces", "", "## Errors", "", "## Edge cases", "", "## Tests", "", "## Rollout", ""].join("\n");
const ACCEPTANCE = "# Acceptance\n\n## Behavior\n\n- Alpha works.\n";

interface TaskOpts {
  p?: boolean;
  files?: string;
  verify?: string;
  done?: boolean;
}
const tl = (id: string, o: TaskOpts = {}) =>
  `- [${o.done ? "x" : " "}] ${id}${o.p ? " [P]" : ""} Do ${id} — \`${o.files ?? `src/${id}.ts`}\` — verify: ${o.verify ?? `\`bun test ${id}\``} (in scope #1)`;
const phase = (n: number, lines: string[], checkpoint?: string) => [`## Phase ${n} — Part ${n}`, "", ...lines, ...(checkpoint ? [`Checkpoint: all green — \`${checkpoint}\``] : []), ""].join("\n");
const tasksMd = (...phases: string[]) => ["# TASKS", "", ...phases].join("\n");

function git(cwd: string, ...args: string[]): string {
  const r = runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

interface Calls {
  escalated: [string, string, string][];
  checkpoint: [number, string][];
  planChanged: string[][];
  boundary: number;
  ended: [string, string][];
  published: number;
}

interface H {
  wt: string;
  feat: string;
  loop: BuildLoop;
  agents: FakeAgents;
  checks: FakeChecks;
  chat: { halted: boolean };
  calls: Calls;
  st(): RunState;
  tasksText(): string;
  write(rel: string, text: string): void;
  /** A worker's turn: it starts, writes the files, ends. */
  turn(agent: string, files?: Record<string, string>, reply?: string): Promise<void>;
  /** The loop's log of what it refused. */
  debug(): string;
}

let h: H;
let extra: string[] = [];
afterEach(() => {
  drop(h.wt);
  for (const d of extra) drop(d);
  extra = [];
});

function mk(tasks: string, o: { workers?: number; maxAttempts?: number; commitPlanFiles?: boolean } = {}): H {
  const wt = tempDir("starship-loop-");
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
  write("docs/features/demo/SPEC.md", SPEC);
  write("docs/features/demo/PLAN.md", PLAN);
  write("docs/features/demo/TASKS.md", tasks);
  write("docs/features/demo/ACCEPTANCE.md", ACCEPTANCE);
  const excl = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
  mkdirSync(dirname(excl), { recursive: true });
  writeFileSync(excl, "docs/features/demo/run/\n");

  const agents = new FakeAgents();
  const checks = new FakeChecks();
  const chat = { halted: false };
  const calls: Calls = { escalated: [], checkpoint: [], planChanged: [], boundary: 0, ended: [], published: 0 };
  const count = o.workers ?? 1;
  const specs: AgentSpec[] = Array.from({ length: count }, (_, i) => ({ id: `worker-${String.fromCharCode(97 + i)}`, role: "worker", tool: "claude", model: "m", cwd: wt, promptFile: null }));
  const loop = new BuildLoop({
    agents,
    checks,
    clock: { now: () => Date.UTC(2026, 10, 11, 12, 0, 0) },
    publish: () => {
      calls.published++;
    },
    chat: () => ({ worktree: wt, featureDir: feat, slug: "demo", halted: chat.halted, heavy: (cmd) => cmd.includes("tsc"), ...(o.commitPlanFiles === undefined ? {} : { commitPlanFiles: o.commitPlanFiles }) }),
    workers: () => specs,
    orchestrator: {
      escalated: (c, t, tail) => calls.escalated.push([c, t, tail]),
      checkpointFailed: (_c, n, tail) => calls.checkpoint.push([n, tail]),
      planChanged: (_c, files) => calls.planChanged.push(files),
    },
    onBoundary: () => {
      calls.boundary++;
    },
    onTaskEnded: (_c, agent, task) => calls.ended.push([agent, task]),
    ...(o.maxAttempts ? { maxAttempts: o.maxAttempts } : {}),
  });
  agents.peek = () => readRunState(feat).sent;
  const self: H = {
    wt,
    feat,
    loop,
    agents,
    checks,
    chat,
    calls,
    st: () => readRunState(feat),
    tasksText: () => readFileSync(join(feat, "TASKS.md"), "utf8"),
    write,
    async turn(agent, files = {}, reply = "done") {
      agents.step(agent, "turnStart");
      loop.handle({ type: "turnStart", chat: CHAT, agent, prompt: lineTo(agents, agent), fromTerminal: false });
      for (const [rel, text] of Object.entries(files)) write(rel, text);
      agents.step(agent, "turnEnd");
      loop.handle({ type: "turnEnd", chat: CHAT, agent, reply, fromTerminal: false });
      await loop.settled();
    },
    debug: () => {
      const f = join(feat, "run", "logs", "loop.log");
      return existsSync(f) ? readFileSync(f, "utf8") : "";
    },
  };
  h = self;
  return self;
}

const startAndSettle = async (x: H) => {
  const r = x.loop.start(CHAT);
  await x.loop.settled();
  return r;
};
/** The text of the turn that an agent starts now: the last line that was sent to it. */
const lineTo = (agents: FakeAgents, agent: string) => [...agents.sent].reverse().find((x) => x.agent === agent)?.line ?? "";
const lastLine = (x: H) => x.agents.sent[x.agents.sent.length - 1]?.line ?? "";
const stateOf = (x: H, id: string) => x.st().tasks[id]?.state;
const boxes = (x: H) => [...x.tasksText().matchAll(/^- \[(.)\] (T\d+\w?)/gm)].map((m) => `${m[2]}${m[1] === "x" ? "+" : "-"}`).join(" ");
const logOf = (n: number) => Array.from({ length: n }, (_, i) => `line ${i + 1}`).join("\n");

// ───────────────────────────── start and handing out ─────────────────────────────

describe("T041: start and handing out", () => {
  test("T041: start commits the plan files, runs the build and hands the idle worker one task with one line that points at its prompt file", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    expect(await startAndSettle(h)).toEqual({ ok: true });
    expect(h.st().build.status).toBe("running");
    expect(git(h.wt, "log", "-1", "--format=%s").trim()).toBe("plan: demo");
    expect(stateOf(h, "T001")).toBe("assigned");
    expect(h.st().tasks.T001?.agent).toBe("worker-a");
    expect(stateOf(h, "T002")).toBeUndefined();
    expect(h.agents.ensured).toEqual(["worker-a"]);
    expect(h.agents.sent).toHaveLength(1);
    const file = join(h.feat, "run", "prompts", "worker-a-T001-v1.md");
    expect(existsSync(file)).toBe(true);
    expect(readFileSync(file, "utf8")).toContain("Task T001: Do T001");
    expect(lastLine(h)).toContain(file);
    expect(lastLine(h)).not.toContain("\n");
  });

  test("T041: the prompt id is recorded in state.sent before the line is sent, and a second look sends nothing again", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    expect(h.agents.sent[0]?.sentIdsAtSend).toEqual(["worker-a-T001-v1"]);
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.agents.sent).toHaveLength(1);
  });

  test("T041: a line the tool refused is sent again at the next look, from the same file", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    h.agents.failNextSend = true;
    await startAndSettle(h);
    expect(h.agents.sent).toHaveLength(0);
    expect(h.st().sent).toEqual([]);
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.agents.sent).toHaveLength(1);
    expect(readdirSync(join(h.feat, "run", "prompts"))).toEqual(["worker-a-T001-v1.md"]);
  });

  test("T041: a task waits for the tasks before it; a [P] task waits only for earlier tasks that are not [P]", async () => {
    mk(tasksMd(phase(1, [tl("T001", { p: true }), tl("T002", { p: true }), tl("T003"), tl("T004", { p: true })])), { workers: 3 });
    await startAndSettle(h);
    // T001 and T002 run together. T003 (not [P]) waits for both. T004 ([P]) waits for T003, the only earlier task that is not [P].
    expect(stateOf(h, "T001")).toBe("assigned");
    expect(stateOf(h, "T002")).toBe("assigned");
    expect(stateOf(h, "T003")).toBeUndefined();
    expect(stateOf(h, "T004")).toBeUndefined();
    expect(h.agents.sent).toHaveLength(2);
  });

  test("T041: no task is handed out while a task in flight lists one of its files, and a folder entry covers its files", async () => {
    mk(tasksMd(phase(1, [tl("T001", { p: true, files: "src/shared.ts" }), tl("T002", { p: true, files: "src/shared.ts" }), tl("T003", { p: true, files: "src/lib/" }), tl("T004", { p: true, files: "src/lib/x.ts" })])), { workers: 3 });
    await startAndSettle(h);
    expect(stateOf(h, "T001")).toBe("assigned");
    expect(stateOf(h, "T002")).toBeUndefined();
    expect(stateOf(h, "T003")).toBe("assigned");
    expect(stateOf(h, "T004")).toBeUndefined();
  });

  test("T041: only the current phase is handed out", async () => {
    mk(tasksMd(phase(1, [tl("T001")]), phase(2, [tl("T010")])), { workers: 2 });
    await startAndSettle(h);
    expect(stateOf(h, "T001")).toBe("assigned");
    expect(stateOf(h, "T010")).toBeUndefined();
  });

  test("T041: a worker that is not idle gets no task", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    h.agents.statuses.set("worker-a", "needsYou");
    await startAndSettle(h);
    expect(h.agents.sent).toHaveLength(0);
    expect(stateOf(h, "T001")).toBeUndefined();
  });

  test("T041: a halted chat hands out no task and queues no check", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    h.chat.halted = true;
    await startAndSettle(h);
    expect(h.agents.sent).toHaveLength(0);
    h.chat.halted = false;
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("assigned");
    h.chat.halted = true;
    await h.turn("worker-a");
    expect(stateOf(h, "T001")).toBe("checking");
    expect(h.checks.pending()).toHaveLength(0);
  });
});

// ───────────────────────────── checks ─────────────────────────────

describe("T041: a turn ends and the check runs", () => {
  test("T041: turnEnd puts the task in checking and queues its verify command, heavy by the chat's rule, with a log path and a run counter", async () => {
    mk(tasksMd(phase(1, [tl("T001", { verify: "`bun tsc`" }), tl("T002")])));
    await startAndSettle(h);
    await h.turn("worker-a");
    expect(stateOf(h, "T001")).toBe("checking");
    const [job] = h.checks.pending();
    expect(job?.cmd).toBe("bun tsc");
    expect(job?.heavy).toBe(true);
    expect(job?.chat).toBe(CHAT);
    expect(job?.cwd).toBe(h.wt);
    expect(job?.logPath).toBe(join(h.feat, "run", "logs", "T001-1.log"));
    expect(h.st().tasks.T001?.runs).toBe(1);
  });

  test("T041: a task whose verify is prose goes to blocked with the reason manual check, and no check is queued", async () => {
    mk(tasksMd(phase(1, [tl("T001", { verify: "a person reads the page" }), tl("T002")])));
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    expect(stateOf(h, "T001")).toBe("blocked");
    expect(h.st().tasks.T001?.reason).toBe("manual check");
    expect(h.checks.pending()).toHaveLength(0);
    expect(boxes(h)).toBe("T001- T002-");
    // The edits stay in the worktree for the person to look at.
    expect(existsSync(join(h.wt, "src/T001.ts"))).toBe(true);
  });

  test("T041: a pass verifies the task, checks its box, commits its listed files only, records outside files, renders progress, and tells the loop's owner", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "export const a = 1;\n", "src/stray.ts": "x\n" });
    h.checks.finish("T001", "pass", "ok");
    await h.loop.settled();

    expect(stateOf(h, "T001")).toBe("verified");
    expect(boxes(h)).toBe("T001+ T002-");
    expect(h.st().pendingCommit).toBeNull();
    expect(git(h.wt, "log", "-2", "--format=%s").trim().split("\n")[0]).toBe("T001: Do T001");
    const files = git(h.wt, "show", "--name-only", "--format=", "HEAD").split("\n").filter(Boolean);
    expect(files).toEqual(["src/T001.ts"]);
    expect(h.st().outside).toEqual(["src/stray.ts"]);
    const progress = readFileSync(join(h.feat, "run", "progress.md"), "utf8");
    expect(progress).toContain("**1 / 2**");
    expect(progress).toContain("src/stray.ts");
    expect(h.calls.boundary).toBe(1);
    expect(h.calls.ended).toEqual([["worker-a", "T001"]]);
    // The task is done, so the same worker gets the next one.
    expect(stateOf(h, "T002")).toBe("assigned");
    expect(lastLine(h)).toContain("T002");
  });

  test("T041: a commit that fails leaves the pending commit in the state, and the next look finishes it once", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "export const a = 1;\n" });
    const lock = join(h.wt, ".git", "index.lock");
    writeFileSync(lock, "");
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(h.st().pendingCommit).toEqual({ task: "T001", text: "Do T001", files: ["src/T001.ts"] });
    const before = git(h.wt, "rev-list", "--count", "HEAD").trim();
    rmSync(lock);
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.st().pendingCommit).toBeNull();
    expect(Number(git(h.wt, "rev-list", "--count", "HEAD").trim())).toBe(Number(before) + 1);
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(Number(git(h.wt, "rev-list", "--count", "HEAD").trim())).toBe(Number(before) + 1);
  });

  test("T041: at a boundary a changed plan file is committed and the orchestrator is told which; TASKS.md alone is not reported", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    h.write("docs/features/demo/ACCEPTANCE.md", ACCEPTANCE + "\n- Beta works.\n");
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(h.calls.planChanged).toEqual([["docs/features/demo/ACCEPTANCE.md"]]);
    expect(git(h.wt, "show", "--name-only", "--format=%s", "HEAD").trim().split("\n")[0]).toBe("plan: demo");
  });
});

describe("the repo setting commitPlanFiles", () => {
  test("false: start does not commit the plan files, and the build runs", async () => {
    mk(tasksMd(phase(1, [tl("T001")])), { commitPlanFiles: false });
    expect(await startAndSettle(h)).toEqual({ ok: true });
    expect(h.st().build.status).toBe("running");
    expect(git(h.wt, "log", "--format=%s").trim()).toBe("first");
    expect(git(h.wt, "status", "--porcelain", "--", "docs/features/demo/SPEC.md").trim()).toBe("?? docs/features/demo/SPEC.md");
    expect(stateOf(h, "T001")).toBe("assigned");
  });

  test("false: a plan file that changes during the build is never committed, and the orchestrator is told once for each edit", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])), { commitPlanFiles: false });
    await startAndSettle(h);
    h.write("docs/features/demo/ACCEPTANCE.md", ACCEPTANCE + "\n- Beta works.\n");
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(h.calls.planChanged).toEqual([["docs/features/demo/ACCEPTANCE.md"]]);
    // The next boundary sees the same edit: no second report.
    await h.turn("worker-a", { "src/T002.ts": "x\n" });
    h.checks.finish("T002", "pass");
    await h.loop.settled();
    expect(h.calls.planChanged).toHaveLength(1);
    expect(git(h.wt, "log", "--format=%s").split("\n").filter((l) => l.startsWith("plan:"))).toEqual([]);
    expect(git(h.wt, "ls-files", "docs/features/demo/ACCEPTANCE.md").trim()).toBe("");
    expect(git(h.wt, "log", "--format=%s").split("\n")).toEqual(expect.arrayContaining(["T001: Do T001", "T002: Do T002"]));
  });

  test("true or not set: the plan files are committed, as before", async () => {
    mk(tasksMd(phase(1, [tl("T001")])), { commitPlanFiles: true });
    await startAndSettle(h);
    expect(git(h.wt, "log", "-1", "--format=%s").trim()).toBe("plan: demo");
  });
});

// ───────────────────────────── D7, D8, D11, D17 ─────────────────────────────

describe("failed checks", () => {
  test("D7: a failed check sends the last 200 lines of the log back to the same worker as a file plus one line", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])), { workers: 2 });
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    h.checks.finish("T001", "fail", logOf(300));
    await h.loop.settled();

    expect(stateOf(h, "T001")).toBe("failed");
    expect(h.st().tasks.T001?.attempts).toBe(1);
    const sent = h.agents.sent[h.agents.sent.length - 1];
    expect(sent?.agent).toBe("worker-a");
    const file = join(h.feat, "run", "prompts", "worker-a-T001-v2.md");
    expect(sent?.line).toContain(file);
    expect(sent?.line).not.toContain("\n");
    const body = readFileSync(file, "utf8");
    expect(body).toContain("line 300");
    expect(body).toContain("line 101");
    expect(body).not.toContain("line 100\n");
    expect(body.split("line ").length - 1).toBe(200);
    expect(h.st().sent).toContain("worker-a-T001-v2");
    expect(boxes(h)).toBe("T001- T002-");
    // A counted result is a task boundary.
    expect(h.calls.boundary).toBe(1);
    // The worker's next turn starts the task again.
    h.agents.step("worker-a", "turnStart");
    h.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-a", prompt: lineTo(h.agents, "worker-a"), fromTerminal: false });
    expect(stateOf(h, "T001")).toBe("working");
  });

  test("D7: a timeout is a failure like any other", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await h.turn("worker-a");
    h.checks.finish("T001", "timeout", "partial output");
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("failed");
    expect(readFileSync(join(h.feat, "run", "prompts", "worker-a-T001-v2.md"), "utf8")).toContain("timed out");
  });

  test("D8: the third counted failure escalates the task, calls the orchestrator, and no fourth attempt starts", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    for (let i = 1; i <= 3; i++) {
      await h.turn("worker-a");
      h.checks.finish("T001", "fail", `output ${i}`);
      await h.loop.settled();
    }
    expect(stateOf(h, "T001")).toBe("escalated");
    expect(h.st().tasks.T001?.attempts).toBe(3);
    expect(h.calls.escalated).toEqual([[CHAT, "T001", "output 3"]]);
    expect(h.calls.boundary).toBe(3);
    const sentBefore = h.agents.sent.length;
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.agents.sent).toHaveLength(sentBefore);
    expect(h.checks.pending()).toHaveLength(0);
  });

  test("D8: the limit can be set", async () => {
    mk(tasksMd(phase(1, [tl("T001")])), { maxAttempts: 2 });
    await startAndSettle(h);
    for (let i = 0; i < 2; i++) {
      await h.turn("worker-a");
      h.checks.finish("T001", "fail", "x");
      await h.loop.settled();
    }
    expect(stateOf(h, "T001")).toBe("escalated");
  });

  test("D11: a worker says done but changed nothing: the check still runs, and its result decides", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await startAndSettle(h);
    const before = git(h.wt, "rev-list", "--count", "HEAD").trim();
    await h.turn("worker-a", {}, "Done. Nothing needed to change.");
    expect(h.checks.pending("T001")).toHaveLength(1);
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("verified");
    expect(boxes(h)).toBe("T001+ T002-");
    expect(git(h.wt, "rev-list", "--count", "HEAD").trim()).toBe(before);
  });

  test("D11: a worker's claim that all is done, with a failing check, leaves the box unchecked (T053)", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "broken\n" }, "Done. All tests pass.");
    expect(boxes(h)).toBe("T001-");
    h.checks.finish("T001", "fail", "1 fail");
    await h.loop.settled();
    expect(boxes(h)).toBe("T001-");
    expect(stateOf(h, "T001")).toBe("failed");
    expect(git(h.wt, "log", "--format=%s").trim()).not.toContain("T001");
  });

  test("T053: a pass whose exit code is not 0 does not check the box", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await h.turn("worker-a");
    const j = h.checks.jobs.find((x) => !x.done);
    if (!j) throw new Error("no job");
    j.done = true;
    j.res({ id: j.job.id, outcome: "pass", exit: 2, durationMs: 1, logPath: j.job.logPath });
    await h.loop.settled();
    expect(boxes(h)).toBe("T001-");
    expect(stateOf(h, "T001")).toBe("failed");
  });

  test("D17: a failure while another worker is working does not count; the check runs again in a quiet worktree, and no task is handed out until that run ends", async () => {
    mk(tasksMd(phase(1, [tl("T001", { p: true }), tl("T002", { p: true }), tl("T003", { p: true })])), { workers: 2 });
    await startAndSettle(h);
    expect(stateOf(h, "T001")).toBe("assigned");
    expect(stateOf(h, "T002")).toBe("assigned");
    h.agents.step("worker-b", "turnStart");
    h.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-b", prompt: lineTo(h.agents, "worker-b"), fromTerminal: false });
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    expect(h.agents.status(CHAT, "worker-b")).toBe("working");

    h.checks.finish("T001", "fail", "flaky");
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("checking");
    expect(h.st().tasks.T001?.attempts).toBe(0);
    expect(h.calls.boundary).toBe(0);
    expect(h.checks.pending()).toHaveLength(0);
    expect(h.agents.sent).toHaveLength(2);

    // The other worker ends its turn: the worktree is quiet, and both checks run.
    h.agents.step("worker-b", "turnEnd");
    h.loop.handle({ type: "turnEnd", chat: CHAT, agent: "worker-b", reply: "done", fromTerminal: false });
    await h.loop.settled();
    expect(h.checks.pending("T001")).toHaveLength(1);
    expect(h.checks.pending("T002")).toHaveLength(1);
    expect(h.st().tasks.T001?.runs).toBe(2);

    h.checks.finish("T002", "pass");
    await h.loop.settled();
    expect(stateOf(h, "T002")).toBe("verified");
    // worker-b is idle and T003 is ready, but the second run of T001 has not ended.
    expect(stateOf(h, "T003")).toBeUndefined();

    h.checks.finish("T001", "fail", "still broken");
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("failed");
    expect(h.st().tasks.T001?.attempts).toBe(1);
    expect(h.calls.boundary).toBe(2);
    expect(stateOf(h, "T003")).toBe("assigned");
  });

  test("D17: the check that counted is the one that ran in a quiet worktree, and a pass is a pass at any time", async () => {
    mk(tasksMd(phase(1, [tl("T001", { p: true }), tl("T002", { p: true })])), { workers: 2 });
    await startAndSettle(h);
    h.agents.step("worker-b", "turnStart");
    h.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-b", prompt: lineTo(h.agents, "worker-b"), fromTerminal: false });
    await h.turn("worker-a");
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("verified");
  });

  test("T041: a result the queue dropped is not an attempt, and the task stays checking", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await h.turn("worker-a");
    h.checks.drop(CHAT);
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("checking");
    expect(h.st().tasks.T001?.attempts).toBe(0);
    expect(h.calls.boundary).toBe(0);
  });
});

// ───────────────────────────── phases, checkpoint, done ─────────────────────────────

describe("T041: phases and checkpoints", () => {
  const pass = async (x: H, agent: string, id: string) => {
    await x.turn(agent, { [`src/${id}.ts`]: "x\n" });
    x.checks.finish(id, "pass");
    await x.loop.settled();
  };

  test("T041: when every task of a phase is verified the Checkpoint runs through the queue, and a pass ends the phase", async () => {
    mk(tasksMd(phase(1, [tl("T001")], "bun test all"), phase(2, [tl("T010")])));
    await startAndSettle(h);
    await pass(h, "worker-a", "T001");
    const [cp] = h.checks.pending("checkpoint-1");
    expect(cp?.cmd).toBe("bun test all");
    expect(cp?.logPath).toBe(join(h.feat, "run", "logs", "checkpoint-1-1.log"));
    expect(stateOf(h, "T010")).toBeUndefined();
    h.checks.finish("checkpoint-1", "pass");
    await h.loop.settled();
    expect(h.st().checkpoints["1"]?.passed).toBe(true);
    expect(stateOf(h, "T010")).toBe("assigned");
    // A checkpoint is not a task boundary.
    expect(h.calls.boundary).toBe(1);
  });

  test("T041: a failed checkpoint calls the orchestrator with the log and waits for fix tasks; three failed runs stop the build with the reason checkpoint", async () => {
    mk(tasksMd(phase(1, [tl("T001")], "bun test all")));
    await startAndSettle(h);
    await pass(h, "worker-a", "T001");
    h.checks.finish("checkpoint-1", "fail", "red 1");
    await h.loop.settled();
    expect(h.calls.checkpoint).toEqual([[1, "red 1"]]);
    expect(h.st().build.status).toBe("running");
    // No fix task and no new run: the engine waits for the orchestrator.
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.checks.pending()).toHaveLength(0);

    // The orchestrator adds a fix task. When it is verified, the checkpoint runs again.
    h.write("docs/features/demo/TASKS.md", h.tasksText().replace("Checkpoint:", `${tl("T002")}\nCheckpoint:`));
    h.loop.taskAdded(CHAT);
    await h.loop.settled();
    await pass(h, "worker-a", "T002");
    h.checks.finish("checkpoint-1", "fail", "red 2");
    await h.loop.settled();
    h.write("docs/features/demo/TASKS.md", h.tasksText().replace("Checkpoint:", `${tl("T003")}\nCheckpoint:`));
    h.loop.taskAdded(CHAT);
    await h.loop.settled();
    await pass(h, "worker-a", "T003");
    h.checks.finish("checkpoint-1", "fail", "red 3");
    await h.loop.settled();

    expect(h.calls.checkpoint.map((c) => c[1])).toEqual(["red 1", "red 2", "red 3"]);
    expect(h.st().build.status).toBe("stopped");
    expect(h.st().build.reason?.kind).toBe("checkpoint");
    expect(h.loop.buildStatus(CHAT)).toEqual({ status: "stopped", reasons: ["checkpoint"] });
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.checks.pending()).toHaveLength(0);

    // The owner's Resume: three more runs.
    expect(h.loop.resumeBuild(CHAT)).toBe(true);
    await h.loop.settled();
    expect(h.st().build.status).toBe("running");
    expect(h.st().checkpoints["1"]?.fails).toBe(0);
    expect(h.checks.pending("checkpoint-1")).toHaveLength(1);
    h.checks.finish("checkpoint-1", "pass");
    await h.loop.settled();
    expect(h.st().build.status).toBe("done");
  });

  test("T041: an orchestrator turn that ends with no fix task stops the build on the checkpoint", async () => {
    mk(tasksMd(phase(1, [tl("T001")], "bun test all")));
    await startAndSettle(h);
    await pass(h, "worker-a", "T001");
    h.checks.finish("checkpoint-1", "fail", "red");
    await h.loop.settled();
    h.loop.checkpointUndecided(CHAT);
    expect(h.loop.buildStatus(CHAT).status).toBe("stopped");
    expect(h.st().build.reason?.kind).toBe("checkpoint");
  });

  test("T041: a phase with no Checkpoint ends when its last task is verified, and the last phase makes the build done", async () => {
    mk(tasksMd(phase(1, [tl("T001")]), phase(2, [tl("T010")])));
    await startAndSettle(h);
    await pass(h, "worker-a", "T001");
    expect(stateOf(h, "T010")).toBe("assigned");
    await pass(h, "worker-a", "T010");
    expect(h.st().build.status).toBe("done");
    expect(h.checks.pending()).toHaveLength(0);
    // Done: a task added to the plan makes the build run again.
    h.write("docs/features/demo/TASKS.md", h.tasksText().replace("## Phase 2", `## Phase 2`).trimEnd() + `\n${tl("T011")}\n`);
    h.loop.taskAdded(CHAT);
    await h.loop.settled();
    expect(h.st().build.status).toBe("running");
    expect(stateOf(h, "T011")).toBe("assigned");
  });

  test("T041: a phase with no task has not ended, so the build is not done", async () => {
    mk(tasksMd(phase(1, [tl("T001", { done: true })]), "## Phase 2 — Empty\n"));
    await startAndSettle(h);
    expect(h.st().build.status).toBe("running");
    expect(h.agents.sent).toHaveLength(0);
  });

  test("T041: a Checkpoint with a command that is dropped by Halt runs again at the next look", async () => {
    mk(tasksMd(phase(1, [tl("T001")], "bun test all")));
    await startAndSettle(h);
    await pass(h, "worker-a", "T001");
    h.checks.drop(CHAT);
    await h.loop.settled();
    expect(h.st().checkpoints["1"]?.fails ?? 0).toBe(0);
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.checks.pending("checkpoint-1")).toHaveLength(1);
  });
});

// ───────────────────────────── C2, C4 ─────────────────────────────

describe("files", () => {
  test("C2: the build does not start while TASKS.md has a line the parser cannot read", async () => {
    mk(tasksMd(phase(1, [tl("T001"), "- [ ] T002 no files and no verify"])));
    const r = await startAndSettle(h);
    expect(r.ok).toBe(false);
    if (!r.ok) expect(r.problems.some((p) => p.file === "TASKS.md")).toBe(true);
    expect(h.st().build.status).toBe("notStarted");
    expect(h.agents.sent).toHaveLength(0);
  });

  test("C2: a running build is stopped with the reason tasks at the next task boundary, and runs again when the file parses", async () => {
    const good = tasksMd(phase(1, [tl("T001"), tl("T002")]));
    mk(good);
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    h.write("docs/features/demo/TASKS.md", good + "\n- [ ] T003 garbage\n");
    h.checks.finish("T001", "pass");
    await h.loop.settled();

    expect(stateOf(h, "T001")).toBe("verified");
    expect(h.st().build.status).toBe("stopped");
    expect(h.st().build.reason?.kind).toBe("tasks");
    expect(h.st().build.reason?.text).toContain("TASKS.md line 8");
    expect(stateOf(h, "T002")).toBeUndefined();
    expect(h.calls.boundary).toBe(1);

    h.write("docs/features/demo/TASKS.md", good);
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.st().build.status).toBe("running");
    // The box of the verified task is checked now, and the next task goes out.
    expect(boxes(h)).toBe("T001+ T002-");
    expect(stateOf(h, "T002")).toBe("assigned");
  });

  test("C4: a missing feature folder stops the build with the reason folder, nothing is recreated, and the build runs when the folder is back", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await startAndSettle(h);
    const backup = tempDir("starship-loop-backup-");
    extra = [backup];
    cpSync(h.feat, join(backup, "demo"), { recursive: true });
    rmSync(h.feat, { recursive: true, force: true });

    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.loop.buildStatus(CHAT)).toEqual({ status: "stopped", reasons: ["folder"] });
    expect(existsSync(h.feat)).toBe(false);
    // A result that arrives meanwhile recreates nothing either.
    h.loop.handle({ type: "turnEnd", chat: CHAT, agent: "worker-a", reply: "x", fromTerminal: false });
    await h.loop.settled();
    expect(existsSync(h.feat)).toBe(false);

    cpSync(join(backup, "demo"), h.feat, { recursive: true });
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.loop.buildStatus(CHAT)).toEqual({ status: "running", reasons: [] });
    expect(h.st().build.status).toBe("running");
  });
});

// ───────────────────────────── task commands ─────────────────────────────

describe("task commands", () => {
  const escalate = async (x: H) => {
    await x.turn("worker-a", { "src/T001.ts": "half done\n" });
    x.checks.finish("T001", "fail", "x");
    await x.loop.settled();
    for (let i = 0; i < 2; i++) {
      await x.turn("worker-a");
      x.checks.finish("T001", "fail", "x");
      await x.loop.settled();
    }
  };

  test("C15: block sets the task's edits aside, and the owner's retry applies the patch again", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await startAndSettle(h);
    await escalate(h);
    expect(stateOf(h, "T001")).toBe("escalated");
    expect(h.loop.block(CHAT, "T001", "needs a design decision")).toBe(true);
    expect(stateOf(h, "T001")).toBe("blocked");
    expect(h.st().tasks.T001?.reason).toBe("needs a design decision");
    // setAside: the file is gone from the worktree, and the patch is saved.
    expect(existsSync(join(h.wt, "src/T001.ts"))).toBe(false);
    expect(readdirSync(join(h.feat, "run", "patches"))).toEqual(["T001-3.patch"]);
    // A blocked task holds back the tasks that wait for it.
    expect(stateOf(h, "T002")).toBeUndefined();

    // The orchestrator cannot move a blocked task. The owner can.
    expect(h.loop.retry(CHAT, "T001", "orchestrator")).toBe(false);
    expect(h.loop.retry(CHAT, "T001", "owner")).toBe(true);
    await h.loop.settled();
    expect(readFileSync(join(h.wt, "src/T001.ts"), "utf8")).toBe("half done\n");
    expect(h.st().tasks.T001?.attempts).toBe(0);
    expect(stateOf(h, "T001")).toBe("assigned");
  });

  test("D8: the orchestrator retries an escalated task once; the second escalation blocks it", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await escalate(h);
    expect(h.loop.retry(CHAT, "T001", "orchestrator")).toBe(true);
    await h.loop.settled();
    expect(h.st().tasks.T001?.attempts).toBe(0);
    expect(stateOf(h, "T001")).toBe("assigned");
    for (let i = 0; i < 3; i++) {
      await h.turn("worker-a", { "src/T001.ts": `again ${i}\n` });
      h.checks.finish("T001", "fail", "x");
      await h.loop.settled();
    }
    expect(stateOf(h, "T001")).toBe("blocked");
    expect(h.calls.escalated).toHaveLength(1);
    expect(h.loop.retry(CHAT, "T001", "orchestrator")).toBe(false);
  });

  test("T041: drop removes the task's line from TASKS.md and records it under dropped; the next task goes out", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await startAndSettle(h);
    await escalate(h);
    expect(h.loop.drop(CHAT, "T001", "no longer needed", "orchestrator")).toBe(true);
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("dropped");
    expect(h.tasksText()).not.toContain("T001");
    expect(h.st().dropped).toEqual([{ task: "T001", text: "Do T001", reason: "no longer needed" }]);
    expect(existsSync(join(h.wt, "src/T001.ts"))).toBe(false);
    expect(readdirSync(join(h.feat, "run", "patches"))).toEqual(["T001-3.patch"]);
    expect(stateOf(h, "T002")).toBe("assigned");
  });

  test("T041: a task that nobody decided on goes to blocked when the orchestrator's turn ends", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await escalate(h);
    expect(h.loop.undecided(CHAT, "T001")).toBe(true);
    expect(stateOf(h, "T001")).toBe("blocked");
  });

  test("split: the old id is dropped, holds its files no more, and its parts go out", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await escalate(h);
    expect(stateOf(h, "T001")).toBe("escalated");
    // What the orchestrator does: the line becomes two parts that list the same file.
    h.write("docs/features/demo/TASKS.md", tasksMd(phase(1, [tl("T002", { files: "src/T001.ts" }), tl("T003", { files: "src/T001.ts" })])));
    expect(h.loop.split(CHAT, "T001")).toBe(true);
    await h.loop.settled();
    expect(stateOf(h, "T001")).toBe("dropped");
    expect(h.st().dropped).toEqual([]);
    expect(stateOf(h, "T002")).toBe("assigned");
    // A second split of the same id changes nothing.
    expect(h.loop.split(CHAT, "T001")).toBe(false);
  });
});

// ───────────────────────────── one agent, and invalid pairs ─────────────────────────────

describe("one agent", () => {
  test("T041: Pause interrupts the agent, marks it paused and parks its working task; Resume sends 'continue <task>'", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    h.agents.step("worker-a", "turnStart");
    h.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-a", prompt: lineTo(h.agents, "worker-a"), fromTerminal: false });
    expect(stateOf(h, "T001")).toBe("working");
    await h.loop.pause(CHAT, "worker-a");
    expect(h.agents.interrupts).toEqual(["worker-a"]);
    expect(h.agents.status(CHAT, "worker-a")).toBe("paused");
    expect(stateOf(h, "T001")).toBe("parked");
    expect(h.st().tasks.T001?.parkedBy).toBe("pause");

    await h.loop.resumeAgent(CHAT, "worker-a");
    expect(stateOf(h, "T001")).toBe("working");
    expect(h.agents.status(CHAT, "worker-a")).toBe("working");
    expect(lastLine(h)).toBe("continue T001");
  });

  test("T041: Resume sends plain 'continue' to a paused agent with no task", async () => {
    mk(tasksMd(phase(1, [tl("T001", { done: true })])));
    h.agents.statuses.set("worker-a", "idle");
    await h.loop.pause(CHAT, "worker-a");
    await h.loop.resumeAgent(CHAT, "worker-a");
    expect(lastLine(h)).toBe("continue");
  });

  test("T041: an event the table calls invalid changes nothing, leaves one line in the log, and never throws", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    h.agents.step("worker-a", "turnStart");
    h.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-a", prompt: lineTo(h.agents, "worker-a"), fromTerminal: false });
    await h.loop.pause(CHAT, "worker-a");
    expect(stateOf(h, "T001")).toBe("parked");
    const before = JSON.stringify(h.st().tasks);
    // A parked task's turn end is not a check.
    expect(() => h.loop.handle({ type: "turnEnd", chat: CHAT, agent: "worker-a", reply: "x", fromTerminal: false })).not.toThrow();
    await h.loop.settled();
    expect(JSON.stringify(h.st().tasks)).toBe(before);
    expect(h.checks.pending()).toHaveLength(0);
    expect(h.debug()).toContain("T001: turnEnd while parked");
    // An event for an agent with no task, and a usage event, change nothing.
    expect(() => h.loop.handle({ type: "turnEnd", chat: CHAT, agent: "nobody", reply: "x", fromTerminal: false })).not.toThrow();
    // `as never`: the loop ignores a usage event, so the test does not build a full usage reading.
    expect(() => h.loop.handle({ type: "usage", tool: "claude", usage: { tool: "claude", windows: [], updatedAt: null, stale: false } as never })).not.toThrow();
    expect(h.loop.retry(CHAT, "T001", "owner")).toBe(false);
    expect(h.debug()).toContain("ownerRetry while parked");
  });

  test("T041: a corrupt state file never throws out of handle", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    writeFileSync(runStatePath(h.feat), "not json");
    expect(() => h.loop.handle({ type: "turnEnd", chat: CHAT, agent: "worker-a", reply: "x", fromTerminal: false })).not.toThrow();
  });

  test("T041: activeTask names the task an agent is in a turn for", () => {
    const st = emptyRunState();
    st.tasks.T001 = { state: "checking", agent: "worker-a", attempts: 0, escalations: 0, runs: 1, parkedBy: null };
    st.tasks.T002 = { state: "working", agent: "worker-a", attempts: 0, escalations: 0, runs: 0, parkedBy: null };
    expect(activeTask(st, "worker-a")).toBe("T002");
    expect(activeTask(st, "worker-b")).toBeNull();
  });
});

// ───────────────────────────── questions (T046) ─────────────────────────────

describe("T046: asked and answered", () => {
  const working = async () => {
    mk(tasksMd(phase(1, [tl("T001", { files: "src/a.ts" }), tl("T002", { files: "src/a.ts" })])));
    await startAndSettle(h);
    h.agents.step("worker-a", "turnStart");
    h.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-a", prompt: lineTo(h.agents, "worker-a"), fromTerminal: false });
    expect(stateOf(h, "T001")).toBe("working");
  };

  test("A15: asked parks a working task with the cause question, and its files stay held", async () => {
    await working();
    h.loop.asked(CHAT, "T001");
    expect(stateOf(h, "T001")).toBe("parked");
    expect(h.st().tasks.T001?.parkedBy).toBe("question");
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(stateOf(h, "T002")).toBeUndefined();
  });

  test("A15: answered sends the parked task back to working", async () => {
    await working();
    h.loop.asked(CHAT, "T001");
    h.loop.answered(CHAT, "T001");
    expect(stateOf(h, "T001")).toBe("working");
    expect(h.st().tasks.T001?.parkedBy).toBeNull();
  });

  test("A15: a task parked by a question and by a pause stays parked until both causes end", async () => {
    await working();
    h.loop.asked(CHAT, "T001");
    await h.loop.pause(CHAT, "worker-a");
    expect(stateOf(h, "T001")).toBe("parked");
    // The answer comes first: the pause still holds the task.
    h.loop.answered(CHAT, "T001");
    expect(stateOf(h, "T001")).toBe("parked");
    expect(h.st().tasks.T001?.parkedBy).toBe("pause");
    await h.loop.resumeAgent(CHAT, "worker-a");
    expect(stateOf(h, "T001")).toBe("working");
  });

  test("A15: Resume while the question is still open leaves the task parked until the answer", async () => {
    await working();
    await h.loop.pause(CHAT, "worker-a");
    expect(h.st().tasks.T001?.parkedBy).toBe("pause");
    h.loop.asked(CHAT, "T001");
    expect(h.st().tasks.T001?.parkedBy).toBe("question");
    await h.loop.resumeAgent(CHAT, "worker-a");
    expect(stateOf(h, "T001")).toBe("parked");
    h.loop.answered(CHAT, "T001");
    expect(stateOf(h, "T001")).toBe("working");
  });

  test("A15: a question or an answer for a task that is not in a turn changes nothing and leaves a line in the log", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    h.loop.asked(CHAT, "T001"); // assigned, not working
    h.loop.answered(CHAT, "T001");
    h.loop.asked(CHAT, "T099");
    expect(stateOf(h, "T001")).toBe("assigned");
    expect(h.st().tasks.T001?.parkedBy).toBeNull();
    expect(h.debug()).toContain("T001: a question came while the task is assigned");
    expect(h.debug()).toContain("T001: an answer came while the task is assigned");
  });
});

// ───────────────────────────── a commit that a worker made ─────────────────────────────

describe("G2: a commit the engine did not make", () => {
  const head = (x: H) => git(x.wt, "rev-parse", "HEAD").trim();
  /** What a worker does that it must not: it commits. */
  const workerCommits = (x: H, file: string, subject: string): string => {
    x.write(file, `${subject}\n`);
    git(x.wt, "add", file);
    git(x.wt, "commit", "-q", "-m", subject);
    return head(x);
  };

  test("a build with no commit of a worker has none listed", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    await h.turn("worker-a", { "src/T002.ts": "x\n" });
    h.checks.finish("T002", "pass");
    await h.loop.settled();
    expect(h.st().build.status).toBe("done");
    expect(h.st().foreignCommits).toEqual([]);
    expect(h.st().lastCommit).toBe(head(h));
  });

  test("a commit made in the middle of a build is listed once, with its id and subject, and the build still ends done", async () => {
    mk(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await startAndSettle(h);
    expect(h.st().lastCommit).toBe(head(h));

    // T001: the worker commits a file that no task lists, before its check ends. The engine's own commit of T001 comes on top of it.
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    const first = workerCommits(h, "notes/one.md", "worker commit one");
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(h.st().foreignCommits).toEqual([{ sha: first, subject: "worker commit one", at: "2026-11-11T12:00:00.000Z" }]);
    // The engine did not undo the commit, and it made its own commit of T001 after it.
    expect(git(h.wt, "log", "--format=%s").trim().split("\n").slice(0, 3)).toEqual(["T001: Do T001", "worker commit one", "plan: demo"]);
    expect(h.st().lastCommit).toBe(head(h));

    // Another look at the chat does not list it again.
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.st().foreignCommits.map((c) => c.sha)).toEqual([first]);

    // T002: the worker commits its own listed file. The engine has nothing left to commit, and the boundary still sees it.
    await h.turn("worker-a", { "src/T002.ts": "y\n" });
    const second = workerCommits(h, "src/T002.ts", "worker commit two");
    h.checks.finish("T002", "pass");
    await h.loop.settled();
    expect(h.st().foreignCommits.map((c) => [c.sha, c.subject])).toEqual([
      [first, "worker commit one"],
      [second, "worker commit two"],
    ]);
    expect(h.st().build.status).toBe("done");
    expect(h.st().tasks.T001?.state).toBe("verified");
    expect(h.st().tasks.T002?.state).toBe("verified");
    expect(h.st().pendingCommit).toBeNull();
    expect(h.debug()).not.toContain("failed");
  });

  test("two commits between two boundaries are two entries, oldest first", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    const a = workerCommits(h, "n/a.md", "first by hand");
    const b = workerCommits(h, "n/b.md", "second by hand");
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(h.st().foreignCommits.map((c) => [c.sha, c.subject])).toEqual([
      [a, "first by hand"],
      [b, "second by hand"],
    ]);
  });

  test("a build state written before this field existed gets its baseline at the next boundary, and lists nothing", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    // An old state file has neither field.
    const raw = JSON.parse(readFileSync(runStatePath(h.feat), "utf8")) as Record<string, unknown>;
    delete raw.lastCommit;
    delete raw.foreignCommits;
    writeFileSync(runStatePath(h.feat), JSON.stringify(raw));
    expect(h.st().lastCommit).toBeNull();
    expect(h.st().foreignCommits).toEqual([]);
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(h.st().foreignCommits).toEqual([]);
    expect(h.st().lastCommit).toBe(head(h));
  });

  test("a worker that resets the branch and commits again is listed for the new commit only", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    git(h.wt, "reset", "-q", "--hard", "HEAD~1"); // the plan commit goes: the engine's last commit is no longer an ancestor
    h.write("docs/features/demo/SPEC.md", SPEC);
    h.write("docs/features/demo/PLAN.md", PLAN);
    h.write("docs/features/demo/TASKS.md", tasksMd(phase(1, [tl("T001")])));
    h.write("docs/features/demo/ACCEPTANCE.md", ACCEPTANCE);
    h.write("src/T001.ts", "x\n");
    const own = workerCommits(h, "n/own.md", "rewritten by hand");
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(h.st().foreignCommits.map((c) => c.sha)).toContain(own);
    expect(h.st().build.status).toBe("done");
  });
});

// ───────────────────────────── a task is checked only after its own turn ─────────────────────────────

describe("FLAW 2: a task goes to `checking` only on the end of a turn that began with its own prompt", () => {
  const ROLE = "Read /w/run/prompts/worker-a.prompt.md first. It is your role. Then wait for your task.";
  /** Codex reports a turn when it ends: a turnStart and a turnEnd together, the turnStart carrying the turn's prompt. */
  const codexTurn = async (x: H, agent: string, prompt: string, fromTerminal = false) => {
    x.agents.step(agent, "turnStart");
    x.loop.handle({ type: "turnStart", chat: CHAT, agent, prompt, fromTerminal });
    x.agents.step(agent, "turnEnd");
    x.loop.handle({ type: "turnEnd", chat: CHAT, agent, reply: "ok", fromTerminal });
    await x.loop.settled();
  };

  test("the end of a turn of another line (the Codex role line) while the task is `assigned`: no check, no attempt; the task's own turn gets exactly one check", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    expect(stateOf(h, "T001")).toBe("assigned");

    await codexTurn(h, "worker-a", ROLE);
    expect(stateOf(h, "T001")).toBe("assigned");
    expect(h.checks.pending()).toHaveLength(0);
    expect(h.st().tasks.T001).toMatchObject({ attempts: 0, runs: 0 });
    expect(h.agents.sent).toHaveLength(1); // no second prompt version

    await codexTurn(h, "worker-a", lastLine(h));
    expect(stateOf(h, "T001")).toBe("checking");
    expect(h.checks.pending("T001")).toHaveLength(1);
    expect(h.st().tasks.T001).toMatchObject({ attempts: 0, runs: 1 });
  });

  test("Pause and Resume while the task is `assigned` (Codex reports no turn start): the turn of the engine's `continue T001` is the task's turn", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    expect(stateOf(h, "T001")).toBe("assigned");
    await h.loop.pause(CHAT, "worker-a");
    await h.loop.resumeAgent(CHAT, "worker-a");
    expect(h.agents.sent.some((x) => x.line === "continue T001")).toBe(true);
    await codexTurn(h, "worker-a", "continue T001");
    expect(stateOf(h, "T001")).toBe("checking");
    expect(h.checks.pending("T001")).toHaveLength(1);
    expect(h.st().tasks.T001).toMatchObject({ attempts: 0, runs: 1 });
  });

  test("a turn that the owner typed (fromTerminal) is not the task's turn either", async () => {
    mk(tasksMd(phase(1, [tl("T001")])));
    await startAndSettle(h);
    await codexTurn(h, "worker-a", "my own question", true);
    expect(stateOf(h, "T001")).toBe("assigned");
    expect(h.checks.pending()).toHaveLength(0);
  });
});

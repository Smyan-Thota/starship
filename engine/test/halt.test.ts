import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { appendNote, parseNotes, markRead } from "../src/folder/notes.ts";
import { haltChat, resumeChat, type HaltDeps } from "../src/run/halt.ts";
import { BuildLoop } from "../src/run/loop.ts";
import type { AgentPort, AgentSpec, CheckPort } from "../src/run/ports.ts";
import type { CheckResult, Job } from "../src/run/queue.ts";
import { type RunState, readRunState, updateRunState } from "../src/run/state.ts";
import { isInvalid, nextAgent } from "../src/run/states.ts";
import type { AgentStatus, AgentView, Role } from "../src/types.ts";
import { runGit } from "../src/worktree.ts";
import { drop, tempDir } from "./helpers.ts";

/** The text of the turn that an agent starts now: the last line that was sent to it. */
const lineTo = (agents: { sent: { agent: string; line: string }[] }, agent: string): string => [...agents.sent].reverse().find((x) => x.agent === agent)?.line ?? "";

const CHAT = "chat-1";
const OTHER = "chat-2";

// ───────────────────────────── fakes ─────────────────────────────

class FakeAgents implements AgentPort {
  views = new Map<string, AgentView>();
  interrupts: string[] = [];
  sent: { chat: string; agent: string; line: string }[] = [];

  add(chat: string, id: string, role: Role, status: AgentStatus): void {
    this.views.set(`${chat}/${id}`, { id, name: id, role, tool: "claude", model: "m", tmux: `sst-${id}`, status, task: null, prompts: [], history: [] });
  }
  async ensure(chat: string, spec: AgentSpec): Promise<void> {
    if (!this.views.has(`${chat}/${spec.id}`)) this.add(chat, spec.id, spec.role, "idle");
  }
  async send(chat: string, agent: string, line: string): Promise<void> {
    this.sent = [...this.sent, { chat, agent, line }];
  }
  async interrupt(chat: string, agent: string): Promise<void> {
    this.interrupts = [...this.interrupts, `${chat}/${agent}`];
  }
  async restart(): Promise<{ resumed: boolean }> {
    return { resumed: true };
  }
  async stop(): Promise<void> {}
  status(chat: string, agent: string): AgentStatus | null {
    return this.views.get(`${chat}/${agent}`)?.status ?? null;
  }
  mark(chat: string, agent: string, status: AgentStatus): void {
    const v = this.views.get(`${chat}/${agent}`);
    if (v) v.status = status;
  }
  agents(chat: string): AgentView[] {
    return [...this.views.entries()].filter(([k]) => k.startsWith(`${chat}/`)).map(([, v]) => ({ ...v }));
  }
  on(): () => void {
    return () => {};
  }
  step(chat: string, agent: string, event: "turnStart" | "turnEnd"): void {
    const v = this.views.get(`${chat}/${agent}`);
    if (!v) return;
    const r = nextAgent(v.status, event);
    if (!isInvalid(r)) v.status = r.state;
  }
  statusOf(chat: string, agent: string): AgentStatus | undefined {
    return this.views.get(`${chat}/${agent}`)?.status;
  }
}

class FakeChecks implements CheckPort {
  jobs: { job: Job; done: boolean; res: (r: CheckResult) => void }[] = [];
  dropped: string[] = [];
  enqueue(job: Job): Promise<CheckResult> {
    return new Promise((res) => {
      this.jobs = [...this.jobs, { job, done: false, res }];
    });
  }
  drop(chat: string): number {
    this.dropped = [...this.dropped, chat];
    let n = 0;
    for (const j of this.jobs) {
      if (j.done || j.job.chat !== chat) continue;
      j.done = true;
      n++;
      j.res({ id: j.job.id, outcome: "dropped", exit: null, durationMs: 0, logPath: j.job.logPath });
    }
    return n;
  }
  pending(name?: string, chat?: string): Job[] {
    return this.jobs.filter((j) => !j.done && (name === undefined || j.job.name === name) && (chat === undefined || j.job.chat === chat)).map((j) => j.job);
  }
  finish(name: string, outcome: CheckResult["outcome"], logText = ""): void {
    const j = this.jobs.find((x) => !x.done && x.job.name === name);
    if (!j) throw new Error(`no waiting job named ${name}`);
    j.done = true;
    mkdirSync(dirname(j.job.logPath), { recursive: true });
    writeFileSync(j.job.logPath, logText);
    j.res({ id: j.job.id, outcome, exit: outcome === "pass" ? 0 : outcome === "fail" ? 1 : null, durationMs: 1, logPath: j.job.logPath });
  }
}

// ───────────────────────────── a chat on disk ─────────────────────────────

const SPEC = "# SPEC\n\n## Problem\n\nA problem.\n\n## Scope\n\n- one\n";
const PLAN = ["# PLAN", "", "## Goal", "", "A goal.", "", "## In scope", "", "1. Alpha", "", "## Out of scope", "", "- Gamma", "", "## Data", "", "## Interfaces", "", "## Errors", "", "## Edge cases", "", "## Tests", "", "## Rollout", ""].join("\n");
const ACCEPTANCE = "# Acceptance\n\n## Behavior\n\n- Alpha works.\n";
const tl = (id: string, p = false) => `- [ ] ${id}${p ? " [P]" : ""} Do ${id} — \`src/${id}.ts\` — verify: \`bun test ${id}\` (in scope #1)`;
const phase = (n: number, lines: string[], checkpoint?: string) => [`## Phase ${n} — Part ${n}`, "", ...lines, ...(checkpoint ? [`Checkpoint: all green — \`${checkpoint}\``] : []), ""].join("\n");
const tasksMd = (...phases: string[]) => ["# TASKS", "", ...phases].join("\n");

function git(cwd: string, ...args: string[]): string {
  const r = runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

interface H {
  wt: string;
  feat: string;
  loop: BuildLoop;
  agents: FakeAgents;
  checks: FakeChecks;
  deps: HaltDeps;
  halted: Record<string, boolean>;
  /** Every call of setHalted, with the number of commits at that moment. */
  flagCalls: { chat: string; time: string | null; commits: number }[];
  st(): RunState;
  write(rel: string, text: string): void;
  turn(agent: string, files?: Record<string, string>): Promise<void>;
  commits(): number;
}

let h: H;
afterEach(() => drop(h.wt));

function mk(tasks: string): H {
  const wt = tempDir("starship-halt-");
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
  const halted: Record<string, boolean> = { [CHAT]: false, [OTHER]: false };
  const specs: AgentSpec[] = ["worker-a", "worker-b"].map((id) => ({ id, role: "worker", tool: "claude", model: "m", cwd: wt, promptFile: null }));
  const clock = { now: () => new Date(2026, 10, 11, 9, 5, 0).getTime() };
  const loop = new BuildLoop({
    agents,
    checks,
    clock,
    publish: () => {},
    chat: () => ({ worktree: wt, featureDir: feat, slug: "demo", halted: halted[CHAT] === true, heavy: () => false }),
    workers: () => specs,
    orchestrator: { escalated: () => {}, checkpointFailed: () => {} },
  });
  const flagCalls: H["flagCalls"] = [];
  const commits = () => Number(git(wt, "rev-list", "--count", "HEAD").trim());
  const deps: HaltDeps = {
    agents,
    checks,
    clock,
    chat: (c) => ({ worktree: wt, featureDir: feat, halted: halted[c] === true }),
    setHalted: (c, time) => {
      flagCalls.push({ chat: c, time, commits: commits() });
      halted[c] = time !== null;
    },
    loop,
  };
  h = {
    wt,
    feat,
    loop,
    agents,
    checks,
    deps,
    halted,
    flagCalls,
    st: () => readRunState(feat),
    write,
    commits,
    async turn(agent, files = {}) {
      agents.step(CHAT, agent, "turnStart");
      loop.handle({ type: "turnStart", chat: CHAT, agent, prompt: lineTo(agents, agent), fromTerminal: false });
      for (const [rel, text] of Object.entries(files)) write(rel, text);
      agents.step(CHAT, agent, "turnEnd");
      loop.handle({ type: "turnEnd", chat: CHAT, agent, reply: "done", fromTerminal: false });
      await loop.settled();
    },
  };
  return h;
}

const stateOf = (id: string) => h.st().tasks[id]?.state;
const handoffs = () => join(h.feat, "run", "handoffs.md");
const readNotes = () => parseNotes(readFileSync(handoffs(), "utf8")).notes;
const note = (text: string, to: "orchestrator" | "plan" | "fixes" | "repo", status?: "queued") => {
  const file = handoffs();
  mkdirSync(dirname(file), { recursive: true });
  const before = existsSync(file) ? readFileSync(file, "utf8") : "";
  writeFileSync(file, appendNote(before, { at: "2026-11-11 09:00", stage: "build", to, said: text, note: text, ...(status ? { status } : {}) }).text);
};

/** A build with one running worker and an idle one, the admin agent, and a second chat that must not change. */
async function running(tasks = tasksMd(phase(1, [tl("T001", true), tl("T002", true)]))): Promise<void> {
  mk(tasks);
  h.agents.add(CHAT, "admin", "admin", "working");
  h.agents.add(CHAT, "orchestrator", "orchestrator", "idle");
  h.agents.add(OTHER, "worker-a", "worker", "working");
  expect(h.loop.start(CHAT)).toEqual({ ok: true });
  await h.loop.settled();
}

// ───────────────────────────── Halt ─────────────────────────────

describe("Halt", () => {
  test("E1: Halt sends Escape to every agent of the chat except the admin agent, and other chats run on", async () => {
    await running();
    h.agents.step(CHAT, "worker-a", "turnStart");
    h.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-a", prompt: lineTo(h.agents, "worker-a"), fromTerminal: false });
    h.agents.add(CHAT, "reviewer-1", "reviewer", "needsYou");
    h.agents.add(CHAT, "worker-c", "worker", "paused");
    h.checks.jobs = [...h.checks.jobs, { job: { id: "o", chat: OTHER, name: "other", cmd: "x", cwd: h.wt, heavy: false, logPath: join(h.wt, "o.log") }, done: false, res: () => {} }];

    expect(await haltChat(h.deps, CHAT)).toBe(true);

    expect(h.agents.interrupts.sort()).toEqual([`${CHAT}/reviewer-1`, `${CHAT}/worker-a`, `${CHAT}/worker-b`, `${CHAT}/orchestrator`].sort());
    expect(h.agents.statusOf(CHAT, "worker-a")).toBe("halted");
    expect(h.agents.statusOf(CHAT, "worker-b")).toBe("halted");
    expect(h.agents.statusOf(CHAT, "orchestrator")).toBe("halted");
    expect(h.agents.statusOf(CHAT, "reviewer-1")).toBe("halted");
    // A paused agent stays paused, and gets no Escape.
    expect(h.agents.statusOf(CHAT, "worker-c")).toBe("paused");
    expect(h.agents.statusOf(CHAT, "admin")).toBe("working");
    // The other chat is not touched.
    expect(h.agents.statusOf(OTHER, "worker-a")).toBe("working");
    expect(h.checks.pending("other", OTHER)).toHaveLength(1);
    expect(h.checks.dropped).toEqual([CHAT]);
    // The flag is set with the time, and task states do not change.
    expect(h.flagCalls).toEqual([{ chat: CHAT, time: "09:05", commits: h.commits() }]);
    expect(h.halted[CHAT]).toBe(true);
    expect(stateOf("T001")).toBe("working");
    expect(stateOf("T002")).toBe("assigned");
    expect(readFileSync(join(h.feat, "run", "progress.md"), "utf8")).toContain("Halted 09:05");
  });

  test("B3: Halt makes each queued note to the orchestrator held, and leaves other notes as they are", async () => {
    await running();
    note("change T002", "orchestrator");
    note("a plan change", "plan");
    note("a fix", "fixes", "queued");
    note("another for the orchestrator", "orchestrator");
    const text = readFileSync(handoffs(), "utf8");
    writeFileSync(handoffs(), markRead(markRead(text, 4, "09:01"), 2, "09:01"));
    note("a repo fact", "repo");
    writeFileSync(handoffs(), markRead(readFileSync(handoffs(), "utf8"), 5, "09:01"));

    await haltChat(h.deps, CHAT);

    const by = Object.fromEntries(readNotes().map((n) => [n.n, `${n.to}:${n.status}`]));
    expect(by).toEqual({ 1: "orchestrator:held", 2: "plan:read", 3: "fixes:queued", 4: "orchestrator:read", 5: "repo:read" });

    // A note that is being read stays queued: its turn ends first.
    const file = handoffs();
    writeFileSync(file, readFileSync(file, "utf8").replace("Status: held", "Status: queued"));
    updateRunState(h.feat, (s) => {
      s.notes["1"] = { deliveries: 1, reading: true };
    });
    h.halted[CHAT] = false;
    await haltChat(h.deps, CHAT);
    expect(readNotes()[0]?.status).toBe("queued");
  });

  test("E3: Halt while a commit is pending finishes the commit first, then the halt applies", async () => {
    await running();
    h.write("src/T001.ts", "export const a = 1;\n");
    updateRunState(h.feat, (s) => {
      s.tasks.T001 = { state: "verified", agent: "worker-a", attempts: 0, escalations: 0, runs: 1, parkedBy: null };
      s.pendingCommit = { task: "T001", text: "Do T001", files: ["src/T001.ts"] };
    });
    const before = h.commits();

    await haltChat(h.deps, CHAT);

    expect(h.commits()).toBe(before + 1);
    expect(git(h.wt, "log", "-1", "--format=%s").trim()).toBe("T001: Do T001");
    expect(h.st().pendingCommit).toBeNull();
    // The flag was set after the commit was made.
    expect(h.flagCalls).toEqual([{ chat: CHAT, time: "09:05", commits: before + 1 }]);
    expect(h.halted[CHAT]).toBe(true);
  });

  test("E2: Halt while a check runs kills it, it is not an attempt, the task stays checking, and Resume queues its check again", async () => {
    await running();
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    expect(h.checks.pending("T001")).toHaveLength(1);

    await haltChat(h.deps, CHAT);
    await h.loop.settled();
    expect(h.checks.pending("T001")).toHaveLength(0);
    expect(stateOf("T001")).toBe("checking");
    expect(h.st().tasks.T001?.attempts).toBe(0);

    // While the chat is halted, no check runs and no task goes out.
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.checks.pending()).toHaveLength(0);

    expect(await resumeChat(h.deps, CHAT)).toBe(true);
    await h.loop.settled();
    expect(h.checks.pending("T001")).toHaveLength(1);
    expect(h.st().tasks.T001?.runs).toBe(2);
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(stateOf("T001")).toBe("verified");
  });

  test("E1: while a chat is halted the loop hands out no task and runs no check", async () => {
    await running(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    expect(stateOf("T002")).toBe("assigned");
    await h.turn("worker-b");
    await haltChat(h.deps, CHAT);
    await h.loop.settled();
    // A turn end that reaches the loop after Halt does not queue a check.
    h.loop.handle({ type: "turnEnd", chat: CHAT, agent: "worker-b", reply: "x", fromTerminal: false });
    await h.loop.settled();
    expect(h.checks.pending()).toHaveLength(0);
  });
});

// ───────────────────────────── Resume ─────────────────────────────

describe("Resume", () => {
  test("E4: each agent that was in a turn gets 'continue <task>' or 'continue', an idle agent gets nothing, held notes become queued, a paused agent stays paused", async () => {
    await running();
    h.agents.step(CHAT, "worker-a", "turnStart");
    h.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-a", prompt: lineTo(h.agents, "worker-a"), fromTerminal: false });
    h.agents.add(CHAT, "reviewer-1", "reviewer", "working");
    h.agents.add(CHAT, "worker-c", "worker", "paused");
    note("change T002", "orchestrator");
    await haltChat(h.deps, CHAT);
    expect(readNotes()[0]?.status).toBe("held");
    const sentBefore = h.agents.sent.length;
    expect(h.st().halt?.inTurn.sort()).toEqual(["reviewer-1", "worker-a"]);

    expect(await resumeChat(h.deps, CHAT)).toBe(true);

    const sent = h.agents.sent.slice(sentBefore).filter((s) => s.chat === CHAT);
    expect(sent.map((s) => `${s.agent}: ${s.line}`).sort()).toEqual(["reviewer-1: continue", "worker-a: continue T001"]);
    expect(h.agents.statusOf(CHAT, "worker-a")).toBe("working");
    expect(h.agents.statusOf(CHAT, "reviewer-1")).toBe("working");
    // An idle agent gets nothing and is idle again. A paused agent stays paused.
    expect(h.agents.statusOf(CHAT, "orchestrator")).toBe("idle");
    expect(h.agents.statusOf(CHAT, "worker-b")).toBe("idle");
    expect(h.agents.statusOf(CHAT, "worker-c")).toBe("paused");
    expect(h.halted[CHAT]).toBe(false);
    expect(h.st().halt).toBeUndefined();
    expect(readNotes()[0]?.status).toBe("queued");
    expect(readFileSync(join(h.feat, "run", "progress.md"), "utf8")).not.toContain("Halted");
  });

  test("E4: after Resume the loop hands out tasks again", async () => {
    await running(tasksMd(phase(1, [tl("T001"), tl("T002")])));
    await haltChat(h.deps, CHAT);
    await resumeChat(h.deps, CHAT);
    await h.loop.settled();
    expect(stateOf("T001")).toBe("assigned");
  });

  test("E5: Halt twice has no effect", async () => {
    await running();
    expect(await haltChat(h.deps, CHAT)).toBe(true);
    const interrupts = h.agents.interrupts.length;
    const marks = JSON.stringify(h.agents.agents(CHAT));
    expect(await haltChat(h.deps, CHAT)).toBe(false);
    expect(h.agents.interrupts).toHaveLength(interrupts);
    expect(JSON.stringify(h.agents.agents(CHAT))).toBe(marks);
    expect(h.flagCalls).toHaveLength(1);
    expect(h.checks.dropped).toEqual([CHAT]);
  });

  test("E5: Resume when the chat is not halted and its build is not stopped on a checkpoint has no effect", async () => {
    await running();
    const sent = h.agents.sent.length;
    const before = JSON.stringify(h.st());
    expect(await resumeChat(h.deps, CHAT)).toBe(false);
    expect(h.agents.sent).toHaveLength(sent);
    expect(JSON.stringify(h.st())).toBe(before);
    expect(h.flagCalls).toHaveLength(0);
    // A build stopped for another reason is not ended by Resume either.
    h.write("docs/features/demo/TASKS.md", readFileSync(join(h.feat, "TASKS.md"), "utf8") + "\n- [ ] T009 garbage\n");
    h.loop.kick(CHAT);
    await h.loop.settled();
    expect(h.loop.buildStatus(CHAT).reasons).toEqual(["tasks"]);
    expect(await resumeChat(h.deps, CHAT)).toBe(false);
  });

  test("E5: Resume when the build is stopped on its checkpoint runs the checkpoint again with three more runs, and one Resume clears the halt too", async () => {
    await running(tasksMd(phase(1, [tl("T001")], "bun test all")));
    await h.turn("worker-a", { "src/T001.ts": "x\n" });
    h.checks.finish("T001", "pass");
    await h.loop.settled();
    // Three failed runs of the checkpoint stop the build. The orchestrator adds a fix task between runs.
    for (let i = 1; i <= 3; i++) {
      h.checks.finish("checkpoint-1", "fail", `red ${i}`);
      await h.loop.settled();
      if (i < 3) {
        const id = `T00${i + 1}`;
        h.write("docs/features/demo/TASKS.md", readFileSync(join(h.feat, "TASKS.md"), "utf8").replace("Checkpoint:", `${tl(id)}\nCheckpoint:`));
        h.loop.taskAdded(CHAT);
        await h.loop.settled();
        await h.turn("worker-a", { [`src/${id}.ts`]: "x\n" });
        h.checks.finish(id, "pass");
        await h.loop.settled();
      }
    }
    expect(h.loop.buildStatus(CHAT)).toEqual({ status: "stopped", reasons: ["checkpoint"] });

    // Not halted, but stopped on its checkpoint: Resume runs it again.
    expect(await resumeChat(h.deps, CHAT)).toBe(true);
    await h.loop.settled();
    expect(h.loop.buildStatus(CHAT).status).toBe("running");
    expect(h.st().checkpoints["1"]?.fails).toBe(0);
    expect(h.checks.pending("checkpoint-1")).toHaveLength(1);
    expect(h.flagCalls).toHaveLength(0);

    // Halted and stopped on a checkpoint: one Resume clears both.
    h.checks.finish("checkpoint-1", "fail", "red 4");
    await h.loop.settled();
    h.loop.checkpointUndecided(CHAT);
    expect(h.loop.buildStatus(CHAT).status).toBe("stopped");
    await haltChat(h.deps, CHAT);
    expect(await resumeChat(h.deps, CHAT)).toBe(true);
    await h.loop.settled();
    expect(h.halted[CHAT]).toBe(false);
    expect(h.loop.buildStatus(CHAT).status).toBe("running");
    expect(h.checks.pending("checkpoint-1")).toHaveLength(1);
  });
});

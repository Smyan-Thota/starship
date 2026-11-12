import { afterEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { recoverEngine } from "../src/restart.ts";
import { BuildLoop } from "../src/run/loop.ts";
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
  async ensure(_c: string, spec: AgentSpec): Promise<void> {
    if (!this.statuses.has(spec.id)) this.statuses.set(spec.id, "idle");
  }
  async send(_c: string, agent: string, line: string): Promise<void> {
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
  jobs: { job: Job; done: boolean; res: (r: CheckResult) => void }[] = [];
  enqueue(job: Job): Promise<CheckResult> {
    return new Promise((res) => {
      this.jobs = [...this.jobs, { job, done: false, res }];
    });
  }
  drop(): number {
    return 0;
  }
  pending(name?: string): Job[] {
    return this.jobs.filter((j) => !j.done && (name === undefined || j.job.name === name)).map((j) => j.job);
  }
  finish(name: string, outcome: CheckResult["outcome"]): void {
    const j = this.jobs.find((x) => !x.done && x.job.name === name);
    if (!j) throw new Error(`no waiting job named ${name}`);
    j.done = true;
    mkdirSync(dirname(j.job.logPath), { recursive: true });
    writeFileSync(j.job.logPath, "");
    j.res({ id: j.job.id, outcome, exit: outcome === "pass" ? 0 : 1, durationMs: 1, logPath: j.job.logPath });
  }
}

const PLAN = ["# PLAN", "", "## Goal", "", "A goal.", "", "## In scope", "", "1. Alpha", "", "## Out of scope", "", "- Gamma", "", "## Data", "", "## Interfaces", "", "## Errors", "", "## Edge cases", "", "## Tests", "", "## Rollout", ""].join("\n");
const task = (id: string, p: boolean) => `- [ ] ${id}${p ? " [P]" : ""} Do ${id} — \`src/${id}.ts\` — verify: \`bun test ${id}\` (in scope #1)`;
const tasksMd = (p: boolean) => ["# TASKS", "", "## Phase 1 — Part 1", "", task("T001", p), task("T002", p), ""].join("\n");

function git(cwd: string, ...args: string[]): string {
  const r = runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A chat on disk. It outlives every engine object: a test "stops the engine" by building a new `World`. */
interface Disk {
  wt: string;
  feat: string;
  chat: { halted: boolean };
}

/** Everything the engine holds in memory. Dropping it is the engine stopping. */
interface World {
  loop: BuildLoop;
  agents: FakeAgents;
  checks: FakeChecks;
}

let disk: Disk;
afterEach(() => drop(disk.wt));

function mkDisk(parallel: boolean): Disk {
  const wt = tempDir("starship-restart-");
  git(wt, "init", "-q", "-b", "main");
  git(wt, "config", "user.name", "Test");
  git(wt, "config", "user.email", "test@example.com");
  git(wt, "config", "commit.gpgsign", "false");
  const write = (rel: string, text: string) => {
    mkdirSync(dirname(join(wt, rel)), { recursive: true });
    writeFileSync(join(wt, rel), text);
  };
  write("README.md", "demo\n");
  git(wt, "add", "README.md");
  git(wt, "commit", "-q", "-m", "first");
  write("docs/features/demo/SPEC.md", "# SPEC\n\n## Problem\n\nA problem.\n\n## Scope\n\n- one\n");
  write("docs/features/demo/PLAN.md", PLAN);
  write("docs/features/demo/TASKS.md", tasksMd(parallel));
  write("docs/features/demo/ACCEPTANCE.md", "# Acceptance\n\n## Behavior\n\n- Alpha works.\n");
  const excl = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
  mkdirSync(dirname(excl), { recursive: true });
  writeFileSync(excl, "docs/features/demo/run/\n");
  disk = { wt, feat: join(wt, "docs", "features", "demo"), chat: { halted: false } };
  return disk;
}

/** New objects over the same folders, with agents that are still running (idle, or `working` where a test says so). */
function world(d: Disk, workers = 2): World {
  const agents = new FakeAgents();
  const checks = new FakeChecks();
  const specs: AgentSpec[] = Array.from({ length: workers }, (_, i) => ({ id: `worker-${String.fromCharCode(97 + i)}`, role: "worker", tool: "claude", model: "m", cwd: d.wt, promptFile: null }));
  const loop = new BuildLoop({
    agents,
    checks,
    clock: { now: () => Date.UTC(2026, 10, 11, 12, 0, 0) },
    publish: () => {},
    chat: () => ({ worktree: d.wt, featureDir: d.feat, slug: "demo", halted: d.chat.halted, heavy: () => false }),
    workers: () => specs,
    orchestrator: { escalated: () => {}, checkpointFailed: () => {} },
  });
  return { loop, agents, checks };
}

/** What the engine does at start, over a World, with the parts outside the loop stubbed and logged. */
async function restart(w: World, log: string[] = []): Promise<{ chats: number; rechecked: string[] }> {
  const r = await recoverEngine({
    chats: () => [{ id: CHAT, featureDir: disk.feat, halted: disk.chat.halted }],
    rebuildSessions: async () => {
      log.push("rebuildSessions");
    },
    recoverChat: async () => {
      log.push("recoverChat");
    },
    loop: w.loop,
  });
  await w.loop.settled();
  return r;
}

async function turn(w: World, agent: string, files: Record<string, string> = {}): Promise<void> {
  w.agents.statuses.set(agent, "working");
  w.loop.handle({ type: "turnStart", chat: CHAT, agent, prompt: lineTo(w.agents, agent), fromTerminal: false });
  for (const [rel, text] of Object.entries(files)) {
    mkdirSync(dirname(join(disk.wt, rel)), { recursive: true });
    writeFileSync(join(disk.wt, rel), text);
  }
  w.agents.statuses.set(agent, "idle");
  w.loop.handle({ type: "turnEnd", chat: CHAT, agent, reply: "done", fromTerminal: false });
  await w.loop.settled();
}

const state = () => readRunState(disk.feat);
const commits = () => Number(git(disk.wt, "rev-list", "--count", "HEAD").trim());
const subjects = () => git(disk.wt, "log", "--format=%s").trim().split("\n");

describe("D19: the engine stops between a passed check and its commit", () => {
  test("D19: after a restart the commit is made once, and a second restart makes none", async () => {
    mkDisk(false);
    const a = world(disk);
    a.loop.start(CHAT);
    await a.loop.settled();
    await turn(a, "worker-a", { "src/T001.ts": "export const a = 1;\n" });
    // The commit cannot finish: git holds a lock. The engine stops with the commit pending.
    const lock = join(disk.wt, ".git", "index.lock");
    writeFileSync(lock, "");
    a.checks.finish("T001", "pass");
    await a.loop.settled();
    expect(state().pendingCommit).toEqual({ task: "T001", text: "Do T001", files: ["src/T001.ts"] });
    expect(state().tasks.T001?.state).toBe("verified");
    const before = commits();
    rmSync(lock);

    // The engine stops: every object is dropped. New objects over the same folders.
    const b = world(disk);
    const first = await restart(b);
    expect(first.rechecked).toEqual([]);
    expect(state().pendingCommit).toBeNull();
    expect(commits()).toBe(before + 1);
    expect(subjects().filter((s) => s === "T001: Do T001")).toHaveLength(1);

    const c = world(disk);
    await restart(c);
    await restart(c);
    expect(commits()).toBe(before + 1);
    expect(subjects().filter((s) => s === "T001: Do T001")).toHaveLength(1);
  });
});

describe("D16 and F4: checks and prompts after a restart", () => {
  test("D16: a task that was checking has its check queued again once, and a task that was working is not sent its prompt again", async () => {
    mkDisk(true);
    const a = world(disk);
    a.loop.start(CHAT);
    await a.loop.settled();
    expect(a.agents.sent.map((s) => s.agent).sort()).toEqual(["worker-a", "worker-b"]);
    await turn(a, "worker-a", { "src/T001.ts": "x\n" }); // T001 is checking, its check is in the old queue
    a.agents.statuses.set("worker-b", "working");
    a.loop.handle({ type: "turnStart", chat: CHAT, agent: "worker-b", prompt: lineTo(a.agents, "worker-b"), fromTerminal: false });
    expect(state().tasks.T001?.state).toBe("checking");
    expect(state().tasks.T002?.state).toBe("working");
    expect(a.checks.pending("T001")).toHaveLength(1);
    const sentBefore = [...state().sent];

    // The engine stops. The agents keep running: worker-b is still in its turn.
    const b = world(disk);
    b.agents.statuses.set("worker-a", "idle");
    b.agents.statuses.set("worker-b", "working");
    const r = await restart(b);

    expect(r.rechecked).toEqual([`${CHAT}/T001`]);
    expect(b.checks.pending("T001")).toHaveLength(1);
    expect(b.checks.pending("T002")).toHaveLength(0);
    expect(b.agents.sent).toEqual([]);
    expect(state().sent).toEqual(sentBefore);
    expect(state().tasks.T001?.state).toBe("checking");
    expect(state().tasks.T002?.state).toBe("working");

    // The queued check ends as a pass: the task is verified and committed, as if the engine never stopped.
    b.checks.finish("T001", "pass");
    await b.loop.settled();
    expect(state().tasks.T001?.state).toBe("verified");
    expect(subjects()[0]).toBe("T001: Do T001");
  });

  test("D16: a prompt that was recorded and never sent goes out once after the restart, and one that was sent never goes out again", async () => {
    mkDisk(true);
    const a = world(disk);
    a.loop.start(CHAT);
    await a.loop.settled();
    expect(state().sent).toEqual(["worker-a-T001-v1", "worker-b-T002-v1"]);
    // The engine stopped after it recorded the prompt of T002 and before it pasted it.
    writeFileSync(
      join(disk.feat, "run", "state.json"),
      JSON.stringify({ ...state(), sent: ["worker-a-T001-v1"] }, null, 2),
    );
    const b = world(disk);
    await restart(b);
    expect(b.agents.sent.map((s) => s.line)).toEqual([expect.stringContaining("Task T002")]);
    expect(state().sent).toEqual(["worker-a-T001-v1", "worker-b-T002-v1"]);
    const c = world(disk);
    await restart(c);
    expect(c.agents.sent).toEqual([]);
  });

  test("F4: every queued check is queued again, each once, and a second look on the same objects adds none", async () => {
    mkDisk(true);
    const a = world(disk);
    a.loop.start(CHAT);
    await a.loop.settled();
    await turn(a, "worker-a", { "src/T001.ts": "x\n" });
    await turn(a, "worker-b", { "src/T002.ts": "x\n" });
    expect(a.checks.pending().map((j) => j.name)).toEqual(["T001", "T002"]);

    const b = world(disk);
    const r = await restart(b);
    expect(r.rechecked).toEqual([`${CHAT}/T001`, `${CHAT}/T002`]);
    expect(b.checks.pending().map((j) => j.name)).toEqual(["T001", "T002"]);
    // A run number that the old engine used is never used again: the log of the old run stays.
    const runs = b.checks.pending().map((j) => j.logPath.split("/").pop());
    expect(runs).toEqual(["T001-2.log", "T002-2.log"]);

    const second = await restart(b);
    expect(second.rechecked).toEqual([`${CHAT}/T001`, `${CHAT}/T002`]);
    expect(b.checks.pending()).toHaveLength(2);
  });
});

describe("restart order and halt", () => {
  test("A7: the conversations are recovered after the sessions and after the loop", async () => {
    mkDisk(false);
    const a = world(disk);
    a.loop.start(CHAT);
    await a.loop.settled();
    await turn(a, "worker-a", { "src/T001.ts": "x\n" });
    const lock = join(disk.wt, ".git", "index.lock");
    writeFileSync(lock, "");
    a.checks.finish("T001", "pass");
    await a.loop.settled();
    rmSync(lock);

    const b = world(disk);
    const log: string[] = [];
    const seen: { pending: boolean; subject: string }[] = [];
    await recoverEngine({
      chats: () => [{ id: CHAT, featureDir: disk.feat, halted: false }],
      rebuildSessions: async () => {
        log.push("rebuildSessions");
      },
      recoverChat: async () => {
        log.push("recoverChat");
        // The loop is already recovered: the pending commit is finished.
        seen.push({ pending: state().pendingCommit !== null, subject: subjects()[0] ?? "" });
      },
      loop: {
        kick: (c) => {
          log.push("kick");
          b.loop.kick(c);
        },
        recheck: (c) => {
          log.push("recheck");
          return b.loop.recheck(c);
        },
        buildStatus: (c) => b.loop.buildStatus(c),
      },
      resumed: () => {
        log.push("resumed");
      },
    });
    expect(log).toEqual(["rebuildSessions", "kick", "recheck", "resumed", "recoverChat"]);
    expect(seen).toEqual([{ pending: false, subject: "T001: Do T001" }]);
    await b.loop.settled();
  });

  test("A7: a halted chat gets no kick-off and no recheck, keeps its pending commit and its checks, and the conversations are still recovered", async () => {
    mkDisk(true);
    const a = world(disk);
    a.loop.start(CHAT);
    await a.loop.settled();
    await turn(a, "worker-a", { "src/T001.ts": "x\n" }); // checking
    await turn(a, "worker-b", { "src/T002.ts": "x\n" });
    const lock = join(disk.wt, ".git", "index.lock");
    writeFileSync(lock, "");
    a.checks.finish("T002", "pass"); // pending commit
    await a.loop.settled();
    rmSync(lock);
    expect(state().pendingCommit?.task).toBe("T002");
    const before = commits();
    const sentBefore = [...state().sent];

    disk.chat.halted = true;
    const b = world(disk);
    const log: string[] = [];
    const r = await restart(b, log);
    expect(r.rechecked).toEqual([]);
    expect(r.chats).toBe(1);
    expect(b.checks.pending()).toHaveLength(0);
    expect(b.agents.sent).toEqual([]);
    expect(state().pendingCommit?.task).toBe("T002");
    expect(commits()).toBe(before);
    expect(state().sent).toEqual(sentBefore);
    expect(log).toEqual(["rebuildSessions", "recoverChat"]);
    expect(readFileSync(join(disk.feat, "TASKS.md"), "utf8")).toContain("- [x] T002");
  });

  test("D16: a chat with no feature folder, and a build that is not running, are left alone, and the other chats still recover", async () => {
    mkDisk(false);
    const calls: string[] = [];
    const r = await recoverEngine({
      chats: () => [
        { id: "no-folder", featureDir: null, halted: false },
        { id: "stopped", featureDir: "/x", halted: false },
        { id: "broken", featureDir: "/y", halted: false },
        { id: "running", featureDir: "/z", halted: false },
      ],
      rebuildSessions: async () => {},
      recoverChat: async () => {
        calls.push("recoverChat");
      },
      loop: {
        kick: (c) => calls.push(`kick ${c}`),
        recheck: (c) => {
          calls.push(`recheck ${c}`);
          return ["T009"];
        },
        buildStatus: (c) => {
          if (c === "broken") throw new Error("state.json is not JSON");
          return { status: c === "stopped" ? "stopped" : "running" };
        },
      },
      resumed: (c) => calls.push(`resumed ${c}`),
    });
    expect(calls).toEqual(["resumed stopped", "kick running", "recheck running", "resumed running", "recoverChat"]);
    expect(r).toEqual({ chats: 4, rechecked: ["running/T009"] });
  });
});

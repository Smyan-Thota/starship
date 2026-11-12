/**
 * The whole engine through the real HTTP server, with the fake agent in real tmux sessions.
 * Every session of this file starts with `sst-` plus a random part, and afterAll kills them and checks none is left.
 * STARSHIP_HOME and FAKE_SESSIONS_DIR are temp folders. No real claude or codex starts.
 */
import { afterAll, afterEach, describe, expect, setDefaultTimeout, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kill, list } from "../src/agents/tmux.ts";
import { routes } from "../src/api.ts";
import { paths } from "../src/config.ts";
import { type Engine, createEngine } from "../src/engine.ts";
import { addRepo } from "../src/repos.ts";
import { readRunState } from "../src/run/state.ts";
import { type EngineServer, startServer } from "../src/server.ts";
import type { ChatState, EngineEvent } from "../src/types.ts";
import { appendHookEvent } from "../src/hooks.ts";
import { main as hookMain } from "../src/hook-entry.ts";
import { appendNote } from "../src/folder/notes.ts";
import { updateRunState } from "../src/run/state.ts";
import type { AgentEvent } from "../src/run/ports.ts";
import { drop, fixture, tempDir, tempHome } from "./helpers.ts";

/** A build waits for real processes: tmux, the fake agent and the hook program. */
setDefaultTimeout(90_000);

const FAKE = join(import.meta.dir, "fake-agent.ts");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const rand = () => Math.random().toString(36).slice(2, 10);
const prefixes: string[] = [];

function killMine(): void {
  for (const p of prefixes) for (const n of list(p)) kill(n);
}
afterAll(() => {
  killMine();
  expect(prefixes.flatMap((p) => list(p))).toEqual([]);
});

async function waitFor<T>(what: string, check: () => T | null | undefined | false | Promise<T | null | undefined | false>, limit = 30_000): Promise<T> {
  const end = Date.now() + limit;
  for (;;) {
    const v = await check();
    if (v) return v;
    if (Date.now() > end) throw new Error(`timed out waiting for ${what}`);
    await Bun.sleep(40);
  }
}

// ───────────────────────────── the rig ─────────────────────────────

interface Rig {
  home: string;
  /** FAKE_SESSIONS_DIR: where the fake agent writes its input log. */
  fakeDir: string;
  engine: Engine;
  server: EngineServer;
  published: EngineEvent[];
  api: (path: string, init?: RequestInit) => Promise<Response>;
  get: <T>(path: string) => Promise<T>;
  post: (path: string, body?: unknown) => Promise<Response>;
  state: (id: string) => Promise<ChatState>;
  /** Runs the real CLI as an agent would. */
  cli: (env: Record<string, string>, stdin: string | undefined, ...args: string[]) => Promise<{ code: number; out: string; err: string }>;
  stop: () => void;
}

const rigs: Rig[] = [];
const dirs: string[] = [];
const homes: ReturnType<typeof tempHome>[] = [];

afterEach(() => {
  for (const r of rigs.splice(0)) r.stop();
  killMine();
  for (const h of homes.splice(0)) h.restore();
  for (const d of dirs.splice(0)) drop(d);
});

async function boot(config?: Record<string, unknown>, pollMs = 100, extraEnv: Record<string, string> = {}, extra: { roleTurnMs?: number } = {}): Promise<Rig> {
  const home = tempHome();
  homes.push(home);
  const fakeDir = tempDir("starship-fake-sessions-");
  dirs.push(fakeDir);
  if (config) writeFileSync(paths.config(), JSON.stringify(config));
  const prefix = `sst-${rand()}-`;
  prefixes.push(prefix);
  const published: EngineEvent[] = [];
  let server: EngineServer | undefined;
  const emit = (e: EngineEvent) => {
    published.push(e);
    server?.publish(e);
  };
  const engine = createEngine({
    publish: emit,
    bins: { claude: [process.execPath, FAKE, "--as", "claude"], codex: [process.execPath, FAKE, "--as", "codex"] },
    prefix,
    env: { FAKE_SESSIONS_DIR: fakeDir, ...extraEnv },
    codexSessionsDir: join(fakeDir, "sessions"),
    pollMs,
    stallMs: 60_000,
    readyMs: 20_000,
    ...(extra.roleTurnMs !== undefined ? { roleTurnMs: extra.roleTurnMs } : {}),
    self: [process.execPath, CLI],
  });
  const started = startServer({
    routes: routes({ publish: emit, engine, terminal: (_s, o) => ({ app: o.app ?? "terminal" }) }),
    portFrom: 20000 + Math.floor(Math.random() * 20000),
  });
  server = started;
  await engine.start();
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${started.info.token}`);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(`${started.url}${path}`, { ...init, headers });
  };
  const rig: Rig = {
    home: home.dir,
    fakeDir,
    engine,
    server: started,
    published,
    api,
    get: async <T>(path: string) => {
      const res = await api(path);
      if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    },
    post: (path, body) => api(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    state: (id) => rig.get<ChatState>(`/api/chats/${id}`),
    cli: async (env, stdin, ...args) => {
      const p = Bun.spawn([process.execPath, CLI, ...args], {
        env: { ...process.env, STARSHIP_HOME: home.dir, ...env },
        stdin: stdin === undefined ? "ignore" : new Blob([stdin]),
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    },
    stop: () => {
      engine.stop();
      started.stop();
    },
  };
  rigs.push(rig);
  return rig;
}

// ───────────────────────────── a repo with a small valid plan ─────────────────────────────

const SPEC = "# SPEC\n\n## Problem\n\nA problem.\n\n## Scope\n\n- one\n";
const PLAN = ["# PLAN", "", "## Goal", "", "A goal.", "", "## In scope", "", "1. Alpha", "", "## Out of scope", "", "- Gamma", "", "## Data", "", "## Interfaces", "", "## Errors", "", "## Edge cases", "", "## Tests", "", "## Rollout", ""].join("\n");
const ACCEPTANCE = "# Acceptance\n\n## Behavior\n\n- Alpha works.\n";

/** A task whose check makes its own file, so the engine has something to commit. */
const task = (id: string, wait = 0) =>
  `- [ ] ${id} Make ${id} — \`src/${id}.txt\` — verify: \`${wait ? `sleep ${wait} && ` : ""}mkdir -p src && echo ${id} > src/${id}.txt && test -f src/${id}.txt\` (in scope #1)`;
const tasksMd = (...lines: string[]) => ["# TASKS", "", "## Phase 1 — Part 1", "", ...lines, ""].join("\n");

function git(cwd: string, ...args: string[]): string {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
  return r.stdout.toString().trim();
}

function gitRepo(): string {
  const dir = tempDir("starship-repo-");
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# Repo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}

/** A chat on a new repo, with the plan files written in its feature folder. */
async function planned(r: Rig, tasks: string): Promise<{ id: string; dir: string; wt: string }> {
  addRepo(gitRepo(), { name: "demo" });
  const res = await r.post("/api/chats", { title: "Build it", repo: "demo" });
  expect(res.status).toBe(200);
  const s = (await res.json()) as ChatState;
  const dir = s.chat.featureDir ?? "";
  writeFileSync(join(dir, "SPEC.md"), SPEC);
  writeFileSync(join(dir, "PLAN.md"), PLAN);
  writeFileSync(join(dir, "TASKS.md"), tasks);
  writeFileSync(join(dir, "ACCEPTANCE.md"), ACCEPTANCE);
  return { id: s.chat.id, dir, wt: s.chat.worktree ?? "" };
}

const taskState = async (r: Rig, id: string, t: string) => (await r.state(id)).tasks?.phases.flatMap((p) => p.tasks).find((x) => x.id === t)?.state;
const noteStatus = async (r: Rig, id: string, n: number) => (await r.state(id)).notes.find((x) => x.n === n)?.status;

// ───────────────────────────── tests ─────────────────────────────

describe("a message", () => {
  test("the owner's message is pasted to the admin agent, and its reply shows in the chat", async () => {
    const r = await boot();
    const created = (await (await r.post("/api/chats", { title: "Say hi" })).json()) as ChatState;
    const id = created.chat.id;
    const res = await r.post(`/api/chats/${id}/messages`, { id: "m1", text: "say hello" });
    expect(res.status).toBe(200);
    const s = await waitFor("the reply", async () => {
      const x = await r.state(id);
      return x.messages.some((m) => m.who === "admin" && m.text === "hello") && x;
    });
    expect(s.messages.find((m) => m.id === "m1")).toMatchObject({ who: "you", text: "say hello", state: "answered" });
    // The agent is in the state, from the sessions: its tool, model and tmux session name.
    const admin = s.agents.find((a) => a.id === "admin");
    expect(admin).toMatchObject({ role: "admin", tool: "claude", model: "opus", status: "idle" });
    expect(admin?.tmux.startsWith("sst-")).toBe(true);
    // The role prompt file was written for it.
    expect(readFileSync(join(paths.chat(id), "agents", "admin.prompt.md"), "utf8")).toContain("admin agent");
    // The same id twice is the same message.
    expect((await r.post(`/api/chats/${id}/messages`, { id: "m1", text: "say hello" })).status).toBe(200);
    expect((await r.state(id)).messages.filter((m) => m.who === "you")).toHaveLength(1);
    expect((await r.post(`/api/chats/${id}/messages`, { id: "m2" })).status).toBe(400);
    expect((await r.post("/api/chats/nope/messages", { id: "m3", text: "x" })).status).toBe(404);
  });
});

describe("a turn with several Stop events", () => {
  test("the admin message of the turn holds every reply, in order, and the owner's message is answered once", async () => {
    const r = await boot();
    const created = (await (await r.post("/api/chats", { title: "Hook" })).json()) as ChatState;
    const id = created.chat.id;
    expect((await r.post(`/api/chats/${id}/messages`, { id: "m1", text: "block 1500 the fresh-eyes read is running" })).status).toBe(200);
    const s = await waitFor("the reply", async () => {
      const x = await r.state(id);
      return x.messages.some((m) => m.who === "admin") && x;
    });
    await Bun.sleep(1500);
    const end = await r.state(id);
    expect(end.messages.filter((m) => m.who === "admin").map((m) => m.text)).toEqual(["first\n\nthe fresh-eyes read is running"]);
    expect(s.messages.find((m) => m.id === "m1")?.state).toBe("answered");
    expect(end.messages.find((m) => m.id === "m1")?.state).toBe("answered");
  });
});

describe("Pause and Resume of the admin agent in the middle of a turn", () => {
  /** The fake's `slow` turn gives no Stop before Escape. The fake's `block` turn gives its first Stop at once, as the owner's Stop hook does. */
  const cases = [
    { word: "slow 6000 the story", replies: ["ok: continue"] },
    { word: "block 6000 the story", replies: ["first\n\nok: continue"] },
  ];
  for (const { word, replies } of cases) {
    test(`${word.split(" ")[0]}: the owner's message ends answered by the reply after Resume; one owner line; "continue" never shows; nothing is pasted twice`, async () => {
      const r = await boot();
      const created = (await (await r.post("/api/chats", { title: "Story" })).json()) as ChatState;
      const id = created.chat.id;
      expect((await r.post(`/api/chats/${id}/messages`, { id: "a2", text: word })).status).toBe(200);
      await waitFor("the message sent", async () => (await r.state(id)).messages.find((m) => m.id === "a2")?.state === "sent");
      await Bun.sleep(1000);
      expect((await r.post(`/api/chats/${id}/agents/admin/pause`)).status).toBe(200);
      expect((await r.state(id)).agents.find((a) => a.id === "admin")?.status).toBe("paused");
      await Bun.sleep(1000);
      expect((await r.post(`/api/chats/${id}/agents/admin/resume`)).status).toBe(200);
      await waitFor("the reply after Resume", async () => (await r.state(id)).messages.some((m) => m.who === "admin" && m.text.endsWith("ok: continue")));
      await Bun.sleep(1500); // a late event would show now
      const end = await r.state(id);
      expect(end.messages.find((m) => m.id === "a2")?.state).toBe("answered");
      expect(end.messages.filter((m) => m.who === "you")).toHaveLength(1);
      expect(end.messages.some((m) => m.fromTerminal)).toBe(false);
      expect(end.messages.filter((m) => m.who === "admin").map((m) => m.text)).toEqual(replies);
      expect(end.agents.find((a) => a.id === "admin")?.status).toBe("idle");
      // The fake logs what it got: the owner's line once, "continue" once.
      const pasted = readFileSync(join(r.fakeDir, "fake-input.log"), "utf8")
        .split("\n")
        .map((l) => l.split("\t"))
        .filter((c) => c[3] === "paste")
        .map((c) => c[4]);
      expect(pasted.filter((t) => t === word)).toHaveLength(1);
      expect(pasted.filter((t) => t === "continue")).toHaveLength(1);
    });
  }
});

describe("Pause and Resume of a worker in the middle of its task turn", () => {
  const pastesOf = (r: Rig): string[] => {
    const f = join(r.fakeDir, "fake-input.log");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .map((l) => l.split("\t"))
      .filter((c) => c[3] === "paste")
      .map((c) => c[4] ?? "");
  };

  for (const tool of ["claude", "codex"] as const) {
    test(`${tool}: the task is not lost; the turn of "continue T001" is the task's turn, and the task goes to checking at its end`, async () => {
      const cfg = tool === "claude" ? { roles: { worker: { tool: "claude", model: "sonnet" } } } : undefined;
      const r = await boot(cfg, 100, { FAKE_TURN_MS: "4000" });
      const c = await planned(r, tasksMd(task("T001")));
      expect((await r.post(`/api/chats/${c.id}/stage`, { stage: "build" })).status).toBe(200);
      const status = async () => (await r.state(c.id)).agents.find((a) => a.id === "worker-a")?.status;
      await waitFor("the task line pasted", () => pastesOf(r).some((t) => t.startsWith("Task T001:")));
      await waitFor("the worker working", async () => (await status()) === "working");
      await Bun.sleep(1000);
      expect((await r.post(`/api/chats/${c.id}/agents/worker-a/pause`)).status).toBe(200);
      expect(await status()).toBe("paused");
      await Bun.sleep(1000);
      expect((await r.post(`/api/chats/${c.id}/agents/worker-a/resume`)).status).toBe(200);
      await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done", 40_000);
      const run = readRunState(c.dir).tasks.T001;
      expect(run).toMatchObject({ state: "verified", attempts: 0, runs: 1 });
      expect(pastesOf(r).filter((t) => t === "continue T001")).toHaveLength(1);
      expect(pastesOf(r).filter((t) => t.startsWith("Task T001:"))).toHaveLength(1);
    });
  }
});

describe("a build", () => {
  test("two fake tasks run to the end: each verified, boxes checked, one commit each, the build done", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001"), task("T002")));
    const res = await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    expect(res.status).toBe(200);
    expect((await r.state(c.id)).chat.stage).toBe("build");

    const s = await waitFor("the build to end", async () => {
      const x = await r.state(c.id);
      return x.build.status === "done" && x;
    });
    expect(s.tasks?.phases.flatMap((p) => p.tasks).map((t) => [t.id, t.state, t.done])).toEqual([
      ["T001", "verified", true],
      ["T002", "verified", true],
    ]);
    const md = readFileSync(join(c.dir, "TASKS.md"), "utf8");
    expect(md).toContain("- [x] T001");
    expect(md).toContain("- [x] T002");
    const log = git(c.wt, "log", "--format=%s").split("\n");
    expect(log.filter((l) => l.startsWith("T001:"))).toHaveLength(1);
    expect(log.filter((l) => l.startsWith("T002:"))).toHaveLength(1);
    for (const t of ["T001", "T002"]) {
      const hash = git(c.wt, "log", `--grep=^${t}:`, "-1", "--format=%H");
      expect(git(c.wt, "show", "--name-only", "--format=", hash)).toBe(`src/${t}.txt`);
    }
    // The workers ran as agents of the chat, and a Codex worker got its role line first.
    const workers = s.agents.filter((a) => a.role === "worker");
    expect(workers.length).toBeGreaterThan(0);
    expect(workers[0]).toMatchObject({ tool: "codex" });
    const roleLine = readFileSync(join(paths.chat(c.id), "agents", "worker-a.json"), "utf8");
    expect(roleLine).toContain("worker-a.prompt.md");
    const sent = readRunState(c.dir).sent;
    expect(sent.some((x) => x.startsWith("worker-"))).toBe(true);
    // The admin agent was told about the stage.
    expect(r.published.some((e) => e.type === "chat" && e.id === c.id)).toBe(true);
  });

  test("a plan that is not valid is refused with its problems, and the stage stays", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    writeFileSync(join(c.dir, "SPEC.md"), "# nothing\n");
    const res = await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    expect(res.status).toBe(409);
    const body = (await res.json()) as { error: string; problems: unknown[] };
    expect(body.error).toBe("The plan is not valid");
    expect(body.problems.length).toBeGreaterThan(0);
    expect((await r.state(c.id)).chat.stage).not.toBe("build");
    // Review needs a build that is done.
    const rev = await r.post(`/api/chats/${c.id}/stage`, { stage: "review" });
    expect(rev.status).toBe(409);
    expect(((await rev.json()) as { error: string }).error).toBe("The build is not done");
    expect((await r.post(`/api/chats/${c.id}/fixes/send`)).status).toBe(409);
    expect((await r.post(`/api/chats/${c.id}/stage`, { stage: "later" })).status).toBe(400);
  });

  test("Halt and Resume through the routes; a note waits while halted, is delivered at a boundary, and is read after starship note ack", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001", 2), task("T002")));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    // T001 is in its check, which waits 2 seconds.
    await waitFor("T001 checking", async () => (await taskState(r, c.id, "T001")) === "checking");

    const halted = await r.post(`/api/chats/${c.id}/halt`);
    expect(halted.status).toBe(200);
    expect(((await halted.json()) as { halted: boolean }).halted).toBe(true);
    expect((await r.state(c.id)).chat.halted).toMatch(/^\d\d:\d\d$/);
    // A second Halt changes nothing.
    expect(((await (await r.post(`/api/chats/${c.id}/halt`)).json()) as { halted: boolean }).halted).toBe(false);

    // The note is recorded as held: the chat is halted.
    const noted = await r.post(`/api/chats/${c.id}/notes`, { to: "orchestrator", said: "add a doc", note: "Also write a short doc." });
    expect(noted.status).toBe(200);
    expect(await noteStatus(r, c.id, 1)).toBe("held");
    // Nothing moves while it is halted.
    await Bun.sleep(2500);
    expect(await taskState(r, c.id, "T001")).toBe("checking");
    expect(await taskState(r, c.id, "T002")).toBe("queued");

    const resumed = await r.post(`/api/chats/${c.id}/resume`);
    expect(resumed.status).toBe(200);
    expect((await r.state(c.id)).chat.halted).toBeNull();

    // The note goes to the orchestrator (a fake). The orchestrator confirms it with the real CLI.
    const agentEnv = { STARSHIP_CHAT: c.id, STARSHIP_AGENT: "orchestrator" };
    let acked = false;
    await waitFor("note 1 read", async () => {
      if (await noteStatus(r, c.id, 1).then((x) => x === "read")) return true;
      if (!acked && readRunState(c.dir).notes["1"]?.reading) {
        acked = true;
        const a = await r.cli(agentEnv, undefined, "note", "ack", "1");
        expect(a.err).toBe("");
        expect(a.code).toBe(0);
      }
      return false;
    }, 40_000);
    expect(readRunState(c.dir).notes["1"]?.deliveries).toBeGreaterThanOrEqual(1);
    // The orchestrator agent exists in the chat and took the note line.
    const orch = JSON.parse(readFileSync(join(paths.chat(c.id), "agents", "orchestrator.json"), "utf8")) as { lastPasted: string; role: string };
    expect(orch.role).toBe("orchestrator");
    expect(orch.lastPasted).toContain("starship note ack 1");

    const s = await waitFor("the build to end", async () => {
      const x = await r.state(c.id);
      return x.build.status === "done" && x;
    });
    expect(s.tasks?.verified).toBe(2);
    // Undo of a note that was read is refused.
    const undo = await r.post(`/api/chats/${c.id}/notes/1/undo`);
    expect(undo.status).toBe(409);
    expect(((await undo.json()) as { error: string }).error).toBe("Already read");
  });
});

describe("a question", () => {
  test("a worker's question parks its task and reaches the admin agent; the answer goes back to the worker", async () => {
    // A Claude worker, because Claude Code reports the start of a turn.
    const r = await boot({ roles: { worker: { tool: "claude", model: "fake" } } });
    const c = await planned(r, tasksMd(task("T001")));
    // The worker is in a turn on T001: its session runs, and the loop's state says so.
    await r.engine.agents.ensure(c.id, { id: "worker-a", role: "worker", tool: "claude", model: "fake", cwd: c.wt, promptFile: null });
    mkdirSync(join(c.dir, "run"), { recursive: true });
    writeFileSync(
      join(c.dir, "run", "state.json"),
      JSON.stringify({ build: { status: "running", reason: null, startedAt: null }, tasks: { T001: { state: "working", agent: "worker-a", attempts: 0, escalations: 0, runs: 0, parkedBy: null } }, notes: {}, checkpoints: {}, pendingCommit: null, sent: [], outside: [], dropped: [], lastFixSent: 0 }),
    );
    expect(await taskState(r, c.id, "T001")).toBe("working");

    const asked = await r.post(`/api/chats/${c.id}/questions`, { task: "T001", text: "Which name?", agent: "worker-a" });
    expect(asked.status).toBe(200);
    expect(await taskState(r, c.id, "T001")).toBe("parked");
    // The admin agent got one line about it.
    const s = await waitFor("the admin line", async () => {
      const x = await r.state(c.id);
      return x.messages.some((m) => m.who === "admin" && m.text.includes("worker-a asks Q1 about T001")) && x;
    });
    expect(s.needs.some((n) => n.kind === "question")).toBe(true);

    const answered = await r.post(`/api/chats/${c.id}/questions/Q1/answer`, { text: "Use the short name." });
    expect(answered.status).toBe(200);
    // The answer is a file, and the worker got one line that points at it.
    const worker = () => JSON.parse(readFileSync(join(paths.chat(c.id), "agents", "worker-a.json"), "utf8")) as { lastPasted: string };
    await waitFor("the answer line", () => worker().lastPasted?.includes("Answer to Q1 about T001"));
    expect(readFileSync(join(c.dir, "run", "inbox", "answer-q1.md"), "utf8")).toContain("Use the short name.");
    expect(readRunState(c.dir).sent).toContain("answer-q1");
    // The worker's turn on that line ends, so the task goes to its check and passes.
    await waitFor("T001 verified", async () => (await taskState(r, c.id, "T001")) === "verified");
  });
});

describe("the guard and the starship command", () => {
  test("a worker's heavy command gets a deny answer from `starship hook claude`; a light one gets nothing", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.engine.agents.ensure(c.id, { id: "worker-a", role: "worker", tool: "claude", model: "fake", cwd: c.wt, promptFile: null });
    const env = { STARSHIP_CHAT: c.id, STARSHIP_AGENT: "worker-a" };
    const input = (command: string) => JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s1", cwd: c.wt, tool_name: "Bash", tool_input: { command } });

    const heavy = await r.cli(env, input("yarn typecheck"), "hook", "claude");
    expect(heavy.code).toBe(0);
    const answer = JSON.parse(heavy.out) as { hookSpecificOutput: { permissionDecision: string; permissionDecisionReason: string } };
    expect(answer.hookSpecificOutput.permissionDecision).toBe("deny");
    expect(answer.hookSpecificOutput.permissionDecisionReason).toContain("heavy command");

    const light = await r.cli(env, input("ls src"), "hook", "claude");
    expect(light).toMatchObject({ code: 0, out: "" });
    // A write in the feature folder is refused for a worker too.
    const write = await r.cli(env, JSON.stringify({ hook_event_name: "PreToolUse", cwd: c.wt, tool_name: "Write", tool_input: { file_path: join(c.dir, "TASKS.md"), content: "x" } }), "hook", "claude");
    expect(JSON.parse(write.out).hookSpecificOutput.permissionDecision).toBe("deny");
    // The events are logged for the engine, and a bad input allows and prints nothing.
    expect(readFileSync(join(paths.chat(c.id), "events.jsonl"), "utf8").split("\n").filter((l) => l.includes("PreToolUse")).length).toBeGreaterThanOrEqual(3);
    const bad = await r.cli(env, "not json", "hook", "claude");
    expect(bad).toMatchObject({ code: 0, out: "" });
    // An agent that is not known to the chat is allowed: the guard never breaks a tool.
    expect((await r.cli({ STARSHIP_CHAT: c.id, STARSHIP_AGENT: "nobody" }, input("yarn typecheck"), "hook", "claude")).out).toBe("");
  });

  test("the engine writes <home>/bin/starship, which runs this program; `starship status` with input is the status line", async () => {
    const r = await boot();
    const script = join(r.home, "bin", "starship");
    expect(existsSync(script)).toBe(true);
    expect(statSync(script).mode & 0o111).not.toBe(0);
    const text = readFileSync(script, "utf8");
    expect(text.split("\n").filter(Boolean)).toHaveLength(2);
    expect(text).toContain(CLI);
    const p = Bun.spawn([script, "status", "--json"], { env: { ...process.env, STARSHIP_HOME: r.home }, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
    expect(JSON.parse(await new Response(p.stdout).text())).toMatchObject({ running: true, port: r.server.info.port });
    await p.exited;
    const line = await r.cli({}, JSON.stringify({ model: { id: "x" } }), "status");
    expect(line).toMatchObject({ code: 0, out: "starship\n" });
    expect(JSON.parse(readFileSync(join(r.home, "usage", "claude-status.json"), "utf8"))).toEqual({ model: { id: "x" } });
    // An agent's session has the folder first in its PATH, and the chat and agent in its environment.
    const cwd = tempDir("starship-work-");
    dirs.push(cwd);
    await r.engine.agents.ensure("c1", { id: "worker-a", role: "worker", tool: "claude", model: "fake", cwd, promptFile: null });
    const name = r.engine.tmuxOf("c1", "worker-a");
    const show = (v: string) => Bun.spawnSync(["tmux", "show-environment", "-t", `=${name}`, v], { stdout: "pipe" }).stdout.toString().trim();
    expect(show("PATH").startsWith(`PATH=${join(r.home, "bin")}:`)).toBe(true);
    expect(show("STARSHIP_CHAT")).toBe("STARSHIP_CHAT=c1");
    expect(show("STARSHIP_AGENT")).toBe("STARSHIP_AGENT=worker-a");
    expect(show("STARSHIP_HOME")).toBe(`STARSHIP_HOME=${r.home}`);
  });
});

// ───────────────────────────── routes and commands ─────────────────────────────

const spec = (id: string, role: "worker" | "orchestrator" | "admin", cwd: string, tool: "claude" | "codex" = "claude") => ({ id, role, tool, model: "fake", cwd, promptFile: null });

describe("check and task commands", () => {
  test("starship check runs the verify command through the queue, prints the outcome and the log tail, and checks nothing off", async () => {
    const r = await boot();
    const c = await planned(
      r,
      tasksMd(task("T001"), "- [ ] T002 Break it — `src/T002.txt` — verify: `echo boom && exit 3` (in scope #1)", "- [ ] T003 Write prose — `src/T003.txt` — verify: a person looks at it (in scope #1)"),
    );
    const env = { STARSHIP_CHAT: c.id, STARSHIP_AGENT: "worker-a" };

    const ok = await r.cli(env, undefined, "check", "T001");
    expect(ok).toMatchObject({ code: 0, err: "" });
    expect(ok.out).toBe("T001 pass (exit 0)\n");
    expect(readFileSync(join(c.wt, "src", "T001.txt"), "utf8")).toBe("T001\n");
    // Not checked off, not an attempt, and the run counter went up.
    expect(readFileSync(join(c.dir, "TASKS.md"), "utf8")).toContain("- [ ] T001");
    expect(readRunState(c.dir).tasks.T001).toMatchObject({ state: "queued", attempts: 0, runs: 1 });
    expect(existsSync(join(c.dir, "run", "logs", "T001-1.log"))).toBe(true);

    const bad = await r.cli(env, undefined, "check", "T002");
    expect(bad.code).toBe(1);
    expect(bad.out).toContain("T002 fail (exit 3)");
    expect(bad.out).toContain("boom");
    expect(readRunState(c.dir).tasks.T002).toMatchObject({ attempts: 0, runs: 1 });
    await r.cli(env, undefined, "check", "T001");
    expect(readRunState(c.dir).tasks.T001?.runs).toBe(2);

    // The route answers the same.
    const res = await r.post(`/api/chats/${c.id}/check`, { task: "T002" });
    expect(await res.json()).toMatchObject({ outcome: "fail", exit: 3, tail: "boom" });
    expect((await r.post(`/api/chats/${c.id}/check`, { task: "T999" })).status).toBe(404);
    expect((await r.post(`/api/chats/${c.id}/check`, { task: "T003" })).status).toBe(400);
    expect((await r.post(`/api/chats/${c.id}/check`, {})).status).toBe(400);
    expect((await r.cli(env, undefined, "check", "T999")).code).toBe(1);

    // A halted chat runs no check.
    expect((await r.cli({}, undefined, "chat", "halt", c.id)).out).toBe(`${c.id} halted\n`);
    const refused = await r.cli(env, undefined, "check", "T001");
    expect(refused).toMatchObject({ code: 1, out: "" });
    expect(refused.err).toContain("The chat is halted");
    expect((await r.cli({}, undefined, "chat", "resume", c.id)).out).toBe(`${c.id} resumed\n`);
    expect((await r.cli(env, undefined, "check", "T001")).code).toBe(0);
  });

  test("starship task add, edit, split and drop write TASKS.md for the orchestrator, and refuse a worker", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001"), task("T002")));
    await r.engine.agents.ensure(c.id, spec("orchestrator", "orchestrator", c.wt));
    await r.engine.agents.ensure(c.id, spec("worker-a", "worker", c.wt));
    const orch = { STARSHIP_CHAT: c.id, STARSHIP_AGENT: "orchestrator" };
    const md = () => readFileSync(join(c.dir, "TASKS.md"), "utf8");

    const added = await r.cli(orch, undefined, "task", "add", "--phase", "1", "--text", "Third thing", "--files", "src/a.txt,src/b.txt", "--verify", "true", "--parallel");
    expect(added).toMatchObject({ code: 0, err: "", out: "T003 added\n" });
    expect(md()).toMatch(/- \[ \] T003 \[P\] Third thing — `src\/a\.txt`, `src\/b\.txt` — verify: `true`/);

    const edited = await r.cli(orch, undefined, "task", "edit", "T003", "--text", "Third, changed");
    expect(edited).toMatchObject({ code: 0, out: "T003 edited\n" });
    expect(md()).toContain("Third, changed");

    const split = await r.cli(orch, undefined, "task", "split", "T003", "--into", "Part one", "Part two");
    expect(split.err).toBe("");
    expect(split.code).toBe(0);
    expect(md()).not.toContain("T003");
    expect(md()).toContain("Part one");
    expect(md()).toContain("Part two");
    expect(readRunState(c.dir).tasks.T003?.state).toBe("dropped");

    const dropped = await r.cli(orch, undefined, "task", "drop", "T002", "--reason", "not needed");
    expect(dropped.err).toBe("");
    expect(dropped.code).toBe(0);
    expect(md()).not.toContain("T002");

    // A worker may not. An unknown agent is a 404. A missing field is a 400.
    const worker = await r.cli({ STARSHIP_CHAT: c.id, STARSHIP_AGENT: "worker-a" }, undefined, "task", "retry", "T001");
    expect(worker.code).toBe(1);
    expect(worker.err).toContain("worker");
    expect((await r.post(`/api/chats/${c.id}/tasks`, { command: "retry", id: "T001", agent: "nobody" })).status).toBe(404);
    expect((await r.post(`/api/chats/${c.id}/tasks`, { command: "add", agent: "orchestrator" })).status).toBe(400);
    expect((await r.post(`/api/chats/${c.id}/tasks`, { command: "fly", agent: "orchestrator" })).status).toBe(400);
    expect((await r.cli(orch, undefined, "task", "add", "--phase", "1")).code).toBe(2);
    expect((await r.cli(orch, undefined, "task", "block", "T001", "--reason", "needs the owner")).code).toBe(1);
  });
});

describe("agents, stages and the other routes", () => {
  test("pause, resume, restart, model and terminal on one agent, and the stage line to the admin agent", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.engine.agents.ensure(c.id, spec("worker-a", "worker", c.wt));
    const agent = async () => (await r.state(c.id)).agents.find((a) => a.id === "worker-a");
    const base = `/api/chats/${c.id}/agents/worker-a`;
    expect(await agent()).toMatchObject({ status: "idle", tool: "claude", model: "fake" });

    expect((await r.post(`${base}/pause`)).status).toBe(200);
    expect((await agent())?.status).toBe("paused");
    expect((await r.post(`${base}/resume`)).status).toBe(200);
    await waitFor("worker idle again", async () => (await agent())?.status === "idle");

    const restarted = await r.post(`${base}/restart`);
    expect(restarted.status).toBe(200);
    expect(await agent()).toMatchObject({ status: "idle", tool: "claude" });

    const moved = await r.post(`${base}/model`, { tool: "codex", model: "gpt-x" });
    expect(moved.status).toBe(200);
    expect(await agent()).toMatchObject({ status: "idle", tool: "codex", model: "gpt-x" });
    expect((await r.post(`${base}/model`, { tool: "gpt" })).status).toBe(400);
    expect((await r.post(`${base}/model`, {})).status).toBe(400);

    const term = await r.post(`${base}/terminal`);
    expect(await term.json()).toMatchObject({ ok: true, session: (await agent())?.tmux, app: "iterm" });
    expect((await r.post(`/api/chats/${c.id}/agents/nobody/pause`)).status).toBe(404);
    expect((await r.post(`/api/chats/${c.id}/agents/nobody/terminal`)).status).toBe(404);

    // The commands of the CLI go to the same routes.
    expect((await r.cli({}, undefined, "agent", "pause", c.id, "worker-a")).out).toBe("worker-a paused\n");
    expect((await agent())?.status).toBe("paused");
    expect((await r.cli({}, undefined, "agent", "resume", c.id, "worker-a")).out).toBe("worker-a resumed\n");
    expect((await r.cli({}, undefined, "agent", "restart", c.id, "worker-a")).out).toBe("worker-a restarted\n");
    expect((await r.cli({}, undefined, "term", c.id, "worker-a")).out).toBe(`opened ${(await agent())?.tmux}\n`);
    expect((await r.cli({}, undefined, "agent", "pause", c.id, "nobody")).code).toBe(1);

    // A chat on a repo with no map starts in Map. A stage that only changes the stage tells the admin agent once.
    expect((await r.state(c.id)).chat.stage).toBe("map");
    expect((await r.post(`/api/chats/${c.id}/stage`, { stage: "plan" })).status).toBe(200);
    expect((await r.state(c.id)).chat.stage).toBe("plan");
    await waitFor("the stage line", async () => (await r.state(c.id)).messages.some((m) => m.who === "admin" && m.text === "ok: The chat is now in the plan stage."));
    expect((await r.post(`/api/chats/${c.id}/stage`, { stage: "plan" })).status).toBe(200);
    expect(readFileSync(join(paths.chat(c.id), "messages.jsonl"), "utf8").split("\n").filter((l) => l.includes("in the plan stage"))).toHaveLength(1);
    const noStage = (await (await r.post("/api/chats", { title: "No repo" })).json()) as ChatState;
    expect((await r.post(`/api/chats/${noStage.chat.id}/stage`, { stage: "plan" })).status).toBe(409);
  });

  test("usage, code, map overlay, hook and undo", async () => {
    const r = await boot(undefined, 60_000);
    const c = await planned(r, tasksMd(task("T001")));

    const usage = await r.get<{ tools: { tool: string }[]; moves: unknown[]; switchOn: boolean; thresholdPct: number }>("/api/usage");
    expect(usage).toMatchObject({ switchOn: true, thresholdPct: 90, moves: [] });
    expect(usage.tools.map((t) => t.tool)).toEqual(["claude", "codex"]);

    // Code: a file of the worktree, and nothing outside it.
    const code = await r.get<{ text: string; info: { path: string } }>(`/api/chats/${c.id}/code?path=README.md`);
    expect(code).toMatchObject({ text: "# Repo\n", info: { path: "README.md" } });
    expect((await r.api(`/api/chats/${c.id}/code?path=../../x`)).status).toBe(400);
    expect((await r.api(`/api/chats/${c.id}/code?path=/etc/passwd`)).status).toBe(400);
    expect((await r.api(`/api/chats/${c.id}/code?path=nope.txt`)).status).toBe(400);
    expect((await r.api(`/api/chats/${c.id}/code`)).status).toBe(400);
    const outside = tempDir("starship-outside-");
    dirs.push(outside);
    writeFileSync(join(outside, "secret.txt"), "secret\n");
    Bun.spawnSync(["ln", "-s", join(outside, "secret.txt"), join(c.wt, "link.txt")]);
    expect((await r.api(`/api/chats/${c.id}/code?path=link.txt`)).status).toBe(400);
    writeFileSync(join(c.wt, "big.txt"), "x".repeat(1_100_000));
    expect(await r.get(`/api/chats/${c.id}/code?path=big.txt`)).toMatchObject({ text: null });
    expect((await r.api("/api/chats/nope/code?path=a")).status).toBe(404);

    // The map overlay is checked against the repo map, written only when it has no error, and refused with its errors.
    const overlay = join(outside, "overlay.json");
    writeFileSync(overlay, JSON.stringify({ lit: { nope: ["x"] } }));
    expect((await r.post(`/api/chats/${c.id}/map/overlay`, { file: overlay })).status).toBe(409);
    expect((await r.post("/api/repos/demo/map/import", { file: fixture("maps", "starship.json") })).status).toBe(200);
    const bad = await r.post(`/api/chats/${c.id}/map/overlay`, { file: overlay });
    expect(bad.status).toBe(400);
    expect(((await bad.json()) as { errors: string[] }).errors.join("\n")).toContain("nope");
    expect(existsSync(join(c.dir, "run", "map-overlay.json"))).toBe(false);
    const map = JSON.parse(readFileSync(fixture("maps", "starship.json"), "utf8")) as { boxes: { id: string; chips: string[] }[] };
    const box = map.boxes.find((b) => b.chips.length > 0);
    if (!box || !box.chips[0]) throw new Error("the sample map has no chip");
    writeFileSync(overlay, JSON.stringify({ lit: { [box.id]: [box.chips[0]] }, steps: [] }));
    const env = { STARSHIP_CHAT: c.id };
    const done = await r.cli(env, undefined, "map", "overlay", overlay);
    expect(done).toMatchObject({ code: 0, out: "overlay written\n" });
    expect(JSON.parse(readFileSync(join(c.dir, "run", "map-overlay.json"), "utf8"))).toMatchObject({ lit: { [box.id]: [box.chips[0]] } });
    writeFileSync(overlay, JSON.stringify({ lit: { nope: ["x"] } }));
    const refused = await r.cli(env, undefined, "map", "overlay", overlay);
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("nope");
    expect((await r.post(`/api/chats/${c.id}/map/overlay`, { file: "relative.json" })).status).toBe(400);

    // The hook route applies the new hook lines at once. The poll loop is an hour away.
    const seen: AgentEvent[] = [];
    r.engine.sessions.on((e) => seen.push(e));
    const stop = JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: "/x", cwd: c.wt, last_assistant_message: "hi" });
    appendHookEvent(c.id, { agent: "worker-a", tool: "claude", raw: stop });
    expect(seen).toEqual([]);
    expect((await r.post("/api/hook", { chat: c.id })).status).toBe(200);
    expect(seen.map((e) => e.type)).toEqual(["turnEnd"]);
    expect(readFileSync(join(paths.chat(c.id), "events.applied"), "utf8").trim()).toBe("1");
    expect((await r.post("/api/hook", { chat: c.id })).status).toBe(200);
    expect(seen).toHaveLength(1);
    expect((await r.post("/api/hook", { chat: "nope" })).status).toBe(404);
    expect((await r.post("/api/hook", {})).status).toBe(400);

    // Undo: an orchestrator note that waits for the build, a fixes note, and a plan note that is read already.
    const note = async (to: string) => ((await (await r.post(`/api/chats/${c.id}/notes`, { to, said: "s", note: `A note to ${to}.` })).json()) as { n: number }).n;
    const orchestrator = await note("orchestrator");
    const fixes = await note("fixes");
    const plan = await note("plan");
    expect(await r.cli({}, undefined, "note", "ack", String(orchestrator), "--chat", c.id)).toMatchObject({ code: 0 });
    expect((await r.post(`/api/chats/${c.id}/notes/${orchestrator}/undo`)).status).toBe(200);
    expect(await noteStatus(r, c.id, orchestrator)).toBe("undone");
    expect((await r.post(`/api/chats/${c.id}/notes/${fixes}/undo`)).status).toBe(200);
    expect(await noteStatus(r, c.id, fixes)).toBe("undone");
    expect(readFileSync(join(c.dir, "run", "review", "fixes.md"), "utf8")).not.toContain("A note to fixes.");
    const readAlready = await r.post(`/api/chats/${c.id}/notes/${plan}/undo`);
    expect(readAlready.status).toBe(409);
    expect(((await readAlready.json()) as { error: string }).error).toBe("Already read");
    expect((await r.post(`/api/chats/${c.id}/notes/${fixes}/undo`)).status).toBe(409);
    expect((await r.post(`/api/chats/${c.id}/notes/99/undo`)).status).toBe(404);
    expect((await r.post(`/api/chats/${c.id}/notes/ack`, { numbers: [] })).status).toBe(400);
  });
});

describe("review", () => {
  test("after a done build the review starts two reviewers; a reviewer that finds nothing is recorded; the fix list goes back to Build", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");

    const res = await r.post(`/api/chats/${c.id}/stage`, { stage: "review" });
    expect(res.status).toBe(200);
    const s = await waitFor("two reviewers", async () => {
      const x = await r.state(c.id);
      return x.agents.filter((a) => a.role === "reviewer" && (a.status === "idle" || a.status === "working")).length >= 2 && x;
    });
    expect(s.chat.stage).toBe("review");
    expect(s.agents.map((a) => a.id)).toEqual(expect.arrayContaining(["reviewer-1", "reviewer-2"]));
    // No app address is set in the repo, so there is no card runner.
    expect(s.agents.some((a) => a.id === "card-runner")).toBe(false);

    const none = await r.cli({ STARSHIP_CHAT: c.id, STARSHIP_AGENT: "reviewer-1" }, undefined, "finding", "none");
    expect(none).toMatchObject({ code: 0, out: "reviewer-1 found nothing\n" });
    expect((await r.state(c.id)).review?.none).toEqual(["reviewer-1"]);

    // A finding, accepted by the owner, goes to Build as one new phase with its own fix task.
    const f = await r.post(`/api/chats/${c.id}/findings`, { sev: "high", where: "src/T001.txt:1", text: "Wrong word.", reviewer: "reviewer-2" });
    expect(f.status).toBe(200);
    expect((await r.post(`/api/chats/${c.id}/findings/1/accept`)).status).toBe(200);
    const sent = await r.post(`/api/chats/${c.id}/fixes/send`);
    expect(sent.status).toBe(200);
    expect(await sent.json()).toMatchObject({ ok: true, sent: 1 });
    const after = await r.state(c.id);
    expect(after.chat.stage).toBe("build");
    expect(after.build.lastFixSent).toBe(1);
    expect(readFileSync(join(c.dir, "TASKS.md"), "utf8")).toContain("Fixes");
  });
});

// ───────────────────────────── the gaps ─────────────────────────────

/** Changes the repo file that `addRepo` made, the way the owner would by hand. */
function editRepo(name: string, change: (repo: Record<string, unknown>) => void): void {
  const file = paths.repo(name);
  const repo = JSON.parse(readFileSync(file, "utf8")) as Record<string, unknown>;
  change(repo);
  writeFileSync(file, JSON.stringify(repo, null, 2));
}

describe("A9: a turn with no reply text", () => {
  test("shows Done and the files that changed in the chat's worktree; a chat with no repo shows Done alone", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    writeFileSync(join(c.wt, "notes.txt"), "the admin agent wrote this\n");
    expect((await r.post(`/api/chats/${c.id}/messages`, { id: "m1", text: "empty" })).status).toBe(200);
    const s = await waitFor("Done", async () => {
      const x = await r.state(c.id);
      return x.messages.some((m) => m.who === "admin" && m.text === "Done") && x;
    });
    const done = s.messages.find((m) => m.who === "admin");
    expect(done?.files).toContain("notes.txt");
    // The engine's own run files are not in the list.
    expect(done?.files?.some((f) => f.includes("/run/"))).toBe(false);

    const loose = (await (await r.post("/api/chats", { title: "No repo" })).json()) as ChatState;
    await r.post(`/api/chats/${loose.chat.id}/messages`, { id: "m1", text: "empty" });
    const t = await waitFor("Done without files", async () => {
      const x = await r.state(loose.chat.id);
      return x.messages.some((m) => m.who === "admin" && m.text === "Done") && x;
    });
    expect(t.messages.find((m) => m.who === "admin")?.files ?? []).toEqual([]);
  });
});

describe("B9: the needs list", () => {
  test("a note that the engine stopped delivering shows once through the route", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    mkdirSync(join(c.dir, "run"), { recursive: true });
    writeFileSync(join(c.dir, "run", "handoffs.md"), appendNote("", { at: "2026-11-11 10:00", stage: "build", to: "orchestrator", said: "s", note: "Do it." }).text);
    updateRunState(c.dir, (st) => {
      st.notes["1"] = { deliveries: 3, reading: false };
    });
    expect(r.engine.notes.needsYou(c.id).map((n) => n.n)).toEqual([1]);
    const s = await r.state(c.id);
    expect(s.needs.filter((n) => n.kind === "note").map((n) => n.text)).toEqual(["Note 1 was never confirmed: Do it."]);
    expect((await r.get<{ id: string; needsYou: number }[]>("/api/chats")).find((x) => x.id === c.id)?.needsYou).toBe(s.needs.length);
  });
});

describe("the repo setting commitPlanFiles", () => {
  test("false: a build commits each task and no plan file", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    editRepo("demo", (repo) => {
      repo.commitPlanFiles = false;
    });
    expect((await r.post(`/api/chats/${c.id}/stage`, { stage: "build" })).status).toBe(200);
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    const log = git(c.wt, "log", "--format=%s").split("\n");
    expect(log.some((l) => l.startsWith("T001:"))).toBe(true);
    expect(log.some((l) => l.startsWith("plan:"))).toBe(false);
    expect(git(c.wt, "ls-files", "docs")).toBe("");
  });

  test("not set: the plan files are committed at the start", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    expect(git(c.wt, "log", "--format=%s").split("\n").some((l) => l.startsWith("plan:"))).toBe(true);
  });
});

describe("the run queue's conflict pairs", () => {
  test("a pair that the owner adds to the repo after the engine started counts from the next check", async () => {
    const r = await boot();
    const first = "- [ ] T001 Slow — `src/a.txt` — verify: `echo s > t1.start && sleep 1 && echo e > t1.end` (in scope #1)";
    const second = "- [ ] T002 After it — `src/b.txt` — verify: `test -f t1.end` (in scope #1)";
    const c = await planned(r, tasksMd(first, second));
    editRepo("demo", (repo) => {
      repo.conflicts = [["T001", "T002"]];
    });
    const [a, b] = await Promise.all([r.engine.runCheck(c.id, "T001"), r.engine.runCheck(c.id, "T002")]);
    expect(a.outcome).toBe("pass");
    // T002 only passes when it started after T001 ended: the pair held it back.
    expect(b.outcome).toBe("pass");
  });
});

describe("the run queue's conflict pairs, with a repo file that cannot be read", () => {
  test("the pairs of the other repos still count", async () => {
    const r = await boot();
    const first = "- [ ] T001 Slow — `src/a.txt` — verify: `echo s > t1.start && sleep 1 && echo e > t1.end` (in scope #1)";
    const second = "- [ ] T002 After it — `src/b.txt` — verify: `test -f t1.end` (in scope #1)";
    const c = await planned(r, tasksMd(first, second));
    editRepo("demo", (repo) => {
      repo.conflicts = [["T001", "T002"]];
    });
    // One file sorts before demo.json and one after it: whatever order the folder is read in, one comes first.
    writeFileSync(join(paths.repos(), "aaa.json"), "{ not json");
    writeFileSync(join(paths.repos(), "zzz.json"), JSON.stringify({ name: 7 }));
    const [a, b] = await Promise.all([r.engine.runCheck(c.id, "T001"), r.engine.runCheck(c.id, "T002")]);
    expect([a.outcome, b.outcome]).toEqual(["pass", "pass"]);
  });
});

describe("G6: the context use of a worker", () => {
  test("a Claude Code worker at 90 percent restarts, with a pickup line, when its task ends", async () => {
    const r = await boot({ roles: { worker: { tool: "claude", model: "fake" } } }, 100, { FAKE_CONTEXT_PCT: "90" });
    const c = await planned(r, tasksMd(task("T001", 1)));
    const started: boolean[] = [];
    r.engine.sessions.on((e) => {
      if (e.type === "started" && e.agent === "worker-a") started.push(e.resumed);
    });
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    const lastPasted = () => (JSON.parse(readFileSync(join(paths.chat(c.id), "agents", "worker-a.json"), "utf8")) as { lastPasted: string | null }).lastPasted ?? "";
    await waitFor("the pickup line", () => lastPasted().startsWith(`You are the new worker-a of chat ${c.id}.`));
    // The new session has the same tool, and the old conversation resumed.
    expect(started).toEqual([false, true]);
    expect(readFileSync(join(paths.chat(c.id), "agents", "worker-a.status.json"), "utf8")).toContain('"used_percentage":90');
    expect(r.engine.sessions.contextPct(c.id, "worker-a")).toBe(90);
    expect((await r.get<{ moves: unknown[] }>("/api/usage")).moves).toEqual([]);
  });

  test("a Claude Code worker under the limit is left alone", async () => {
    const r = await boot({ roles: { worker: { tool: "claude", model: "fake" } } }, 100, { FAKE_CONTEXT_PCT: "40" });
    const c = await planned(r, tasksMd(task("T001", 1)));
    const started: boolean[] = [];
    r.engine.sessions.on((e) => {
      if (e.type === "started" && e.agent === "worker-a") started.push(e.resumed);
    });
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    await r.engine.usage.idle();
    expect(started).toEqual([false]);
  });
});

describe("G1: the Codex sandbox flags", () => {
  /** The command that started the tmux session, as tmux keeps it. */
  const startCommand = (name: string): string => {
    const p = Bun.spawnSync(["tmux", "display-message", "-p", "-t", `=${name}:`, "#{pane_start_command}"], { stdout: "pipe", stderr: "pipe" });
    return p.stdout.toString();
  };

  test("a Codex worker starts with the codexArgs of the config, the default being workspace-write and never ask; the fake agent runs the build with them", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    const worker = (await r.state(c.id)).agents.find((a) => a.id === "worker-a");
    expect(worker?.tool).toBe("codex");
    const cmd = startCommand(r.engine.tmuxOf(c.id, "worker-a"));
    expect(cmd).toContain("workspace-write");
    expect(cmd).toMatch(/-s\W+workspace-write\W+-a\W+never/);
  });

  test("a config with codexArgs [] gives a Codex worker none of the flags", async () => {
    const r = await boot({ codexArgs: [] });
    const c = await planned(r, tasksMd(task("T001")));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    const cmd = startCommand(r.engine.tmuxOf(c.id, "worker-a"));
    expect(cmd).toContain("--as");
    expect(cmd).not.toContain("workspace-write");
    expect(cmd).not.toMatch(/\W-s\W/);
  });

  test("the other flags of the config reach the Codex start too", async () => {
    const r = await boot({ codexArgs: ["-s", "read-only"] });
    const c = await planned(r, tasksMd(task("T001")));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    const cmd = startCommand(r.engine.tmuxOf(c.id, "worker-a"));
    expect(cmd).toContain("read-only");
    expect(cmd).not.toContain("workspace-write");
  });
});

describe("G3: stallMin and maxWorkers", () => {
  test("stallMin of the config is the sessions' stall limit when the options name none; an option wins", async () => {
    const home = tempHome();
    homes.push(home);
    writeFileSync(paths.config(), JSON.stringify({ stallMin: 3 }));
    const prefix = `sst-${rand()}-`;
    prefixes.push(prefix);
    const make = (extra: { stallMs?: number }) => createEngine({ publish: () => {}, prefix, self: [process.execPath, CLI], ...extra });
    const a = make({});
    expect(a.sessions.stallLimitMs).toBe(3 * 60_000);
    a.stop();
    const b = make({ stallMs: 1234 });
    expect(b.sessions.stallLimitMs).toBe(1234);
    b.stop();
    rmSync(paths.config());
    const d = make({});
    expect(d.sessions.stallLimitMs).toBe(10 * 60_000);
    d.stop();
  });

  /** Two tasks that may run at the same time: they list different files and both are [P]. */
  const two = () => tasksMd(task("T001", 2).replace("- [ ] T001", "- [ ] T001 [P]"), task("T002", 2).replace("- [ ] T002", "- [ ] T002 [P]"));
  const workersOf = async (r: Rig, id: string) => (await r.state(id)).agents.filter((a) => a.role === "worker").map((a) => a.id).sort();

  test("with workers 2 both workers take a task at once; with maxWorkers 1 only worker-a exists and the tasks run one after the other", async () => {
    const wide = await boot({ workers: 2 });
    const cw = await planned(wide, two());
    await wide.post(`/api/chats/${cw.id}/stage`, { stage: "build" });
    await waitFor("both workers", async () => (await workersOf(wide, cw.id)).length === 2);
    await waitFor("the build to end", async () => (await wide.state(cw.id)).build.status === "done");
    expect(await workersOf(wide, cw.id)).toEqual(["worker-a", "worker-b"]);
  });

  test("maxWorkers 1 caps the default workers: one worker, and the build still ends", async () => {
    const r = await boot({ maxWorkers: 1 });
    const c = await planned(r, two());
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    expect(await workersOf(r, c.id)).toEqual(["worker-a"]);
  });
});

describe("G4: the hook tells the engine at once", () => {
  const stopInput = (cwd: string) => JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: "/x", cwd, last_assistant_message: "hi" });

  /** Runs `main` of hook-entry in this process with the agent's env, and gives how long it took. */
  async function runHook(chat: string, cwd: string): Promise<number> {
    const before = { chat: process.env.STARSHIP_CHAT, agent: process.env.STARSHIP_AGENT };
    process.env.STARSHIP_CHAT = chat;
    process.env.STARSHIP_AGENT = "worker-a";
    try {
      const t0 = performance.now();
      const out = await hookMain(["hook", "claude"], stopInput(cwd));
      expect(out).toBe("");
      return performance.now() - t0;
    } finally {
      for (const [k, v] of [["STARSHIP_CHAT", before.chat], ["STARSHIP_AGENT", before.agent]] as const) {
        if (v === undefined) delete process.env[k];
        else process.env[k] = v;
      }
    }
  }

  test("with a running engine the event is applied before the hook ends, in under 300 ms; the poll loop is an hour away", async () => {
    const r = await boot(undefined, 3_600_000);
    const c = await planned(r, tasksMd(task("T001")));
    const seen: AgentEvent[] = [];
    r.engine.sessions.on((e) => seen.push(e));
    const ms = await runHook(c.id, c.wt);
    expect(seen.map((e) => e.type)).toEqual(["turnEnd"]);
    expect(ms).toBeLessThan(300);
    expect(readFileSync(join(paths.chat(c.id), "events.applied"), "utf8").trim()).toBe("1");
    // The window was told too.
    expect(r.published.some((e) => e.type === "chat" && e.id === c.id)).toBe(true);
  });

  test("the same through the real command: it exits 0 and the event is applied when it has ended", async () => {
    const r = await boot(undefined, 3_600_000);
    const c = await planned(r, tasksMd(task("T001")));
    const seen: AgentEvent[] = [];
    r.engine.sessions.on((e) => seen.push(e));
    const res = await r.cli({ STARSHIP_CHAT: c.id, STARSHIP_AGENT: "worker-a" }, stopInput(c.wt), "hook", "claude");
    expect(res.code).toBe(0);
    expect(seen.map((e) => e.type)).toEqual(["turnEnd"]);
  });

  test("with no engine the event is still logged and the hook ends 0, quickly", async () => {
    const home = tempHome();
    homes.push(home);
    const t0 = performance.now();
    const p = Bun.spawn([process.execPath, CLI, "hook", "claude"], {
      env: { ...process.env, STARSHIP_HOME: home.dir, STARSHIP_CHAT: "c1", STARSHIP_AGENT: "worker-a" },
      stdin: new Blob([stopInput("/")]),
      stdout: "pipe",
      stderr: "pipe",
    });
    const code = await p.exited;
    expect(code).toBe(0);
    expect(performance.now() - t0).toBeLessThan(2000);
    expect(readFileSync(join(paths.chat("c1"), "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(1);
  });

  test("an engine.json that points at nothing, or at a server that never answers, costs the hook at most about 300 ms and breaks nothing", async () => {
    const home = tempHome();
    homes.push(home);
    // A port with no listener.
    const closed = Bun.serve({ port: 0, fetch: () => new Response("x") });
    const deadPort = closed.port;
    await closed.stop(true);
    writeFileSync(paths.engine(), JSON.stringify({ pid: 1, port: deadPort, token: "t" }));
    expect(await runHook("c1", "/")).toBeLessThan(300);
    // A server that accepts and never answers.
    const hung = Bun.serve({ port: 0, fetch: () => new Promise<Response>(() => {}) });
    try {
      writeFileSync(paths.engine(), JSON.stringify({ pid: 1, port: hung.port, token: "t" }));
      const ms = await runHook("c1", "/");
      expect(ms).toBeGreaterThanOrEqual(250);
      expect(ms).toBeLessThan(700);
    } finally {
      await hung.stop(true);
    }
    // engine.json that is not JSON.
    writeFileSync(paths.engine(), "{ nope");
    expect(await runHook("c1", "/")).toBeLessThan(300);
    expect(readFileSync(join(paths.chat("c1"), "events.jsonl"), "utf8").trim().split("\n")).toHaveLength(3);
  });
});

describe("G5: AgentView.contextPct", () => {
  test("the chat state carries the context use of each agent from the sessions: a number after a turn, null before", async () => {
    const r = await boot({ roles: { worker: { tool: "claude", model: "fake" } } }, 100, { FAKE_CONTEXT_PCT: "40" });
    const c = await planned(r, tasksMd(task("T001", 1)));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    const agents = (await r.state(c.id)).agents;
    const worker = agents.find((a) => a.id === "worker-a");
    expect(worker?.contextPct).toBe(40);
    expect(worker?.contextPct).toBe(r.engine.sessions.contextPct(c.id, "worker-a"));
    // An agent with no turn yet has no number: null, not a missing field.
    const orchestrator = agents.find((a) => a.id === "orchestrator");
    if (orchestrator) expect(orchestrator.contextPct).toBeNull();
    expect(agents.every((a) => a.contextPct === null || typeof a.contextPct === "number")).toBe(true);
  });

  test("a Codex worker's number comes from its rollout", async () => {
    const r = await boot(undefined, 100, { FAKE_CONTEXT_PCT: "70" });
    const c = await planned(r, tasksMd(task("T001", 1)));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    const pct = (await r.state(c.id)).agents.find((a) => a.id === "worker-a")?.contextPct;
    expect(Math.round(pct ?? -1)).toBe(70);
  });
});

describe("G7: GET /api/chats/:id carries the role prompt of the admin agent", () => {
  test("a chat with a repo and a chat with none: prompts[0] of the admin is the role prompt file, byte for byte, as version 1", async () => {
    const r = await boot();
    const withRepo = await planned(r, tasksMd(task("T001")));
    const none = (await (await r.post("/api/chats", { title: "Just talk" })).json()) as ChatState;
    for (const id of [withRepo.id, none.chat.id]) {
      await r.post(`/api/chats/${id}/messages`, { id: "m1", text: "say hello" });
      const s = await waitFor("the admin agent", async () => {
        const x = await r.state(id);
        return x.agents.some((a) => a.id === "admin") && x;
      });
      const file = join(paths.chat(id), "agents", "admin.prompt.md");
      const admin = s.agents.find((a) => a.id === "admin");
      expect(admin?.prompts).toHaveLength(1);
      expect(admin?.prompts[0]?.v).toBe(1);
      expect(admin?.prompts[0]?.text).toBe(readFileSync(file, "utf8"));
      expect(admin?.prompts[0]?.text).toContain("admin agent");
      expect(admin?.prompts[0]?.file).toBe("agents/admin.prompt.md");
      expect((admin?.prompts[0]?.lines.length ?? 0) > 0).toBe(true);
    }
    // The stage line to the admin agent is a chat line: the prompt list does not grow.
    await r.post(`/api/chats/${withRepo.id}/stage`, { stage: "plan" });
    await Bun.sleep(500);
    expect((await r.state(withRepo.id)).agents.find((a) => a.id === "admin")?.prompts).toHaveLength(1);
  });
});

describe("a trust question: the needs list says it, and work goes on after the owner answers", () => {
  /** Only the TEST presses these keys, as the owner would. The engine never does. */
  function rawKeys(session: string, ...keys: string[]): void {
    const res = Bun.spawnSync(["tmux", "send-keys", "-t", `=${session}:`, ...keys]);
    if (res.exitCode !== 0) throw new Error(res.stderr.toString());
  }
  /** Claude Code's question defaults to "No, exit": Down, then Enter. Codex's: Enter continues. */
  const answer = (r: Rig, chat: string, agent: string, flavor: "claude" | "codex"): void => {
    const session = r.engine.tmuxOf(chat, agent);
    if (flavor === "claude") rawKeys(session, "Down");
    rawKeys(session, "Enter");
  };
  const trustNeed = (x: ChatState, agent: string) => x.needs.find((n) => n.kind === "trust" && n.agent === agent);

  for (const flavor of ["codex", "claude"] as const) {
    test(`(a) a build whose worker starts at the ${flavor} trust question: kind trust in the needs list; the owner answers; the build ends done`, async () => {
      const config = flavor === "claude" ? { roles: { worker: { tool: "claude", model: "sonnet" } } } : undefined;
      const r = await boot(config, 100, { FAKE_SCREEN: "trust" });
      const c = await planned(r, tasksMd(task("T001")));
      expect((await r.post(`/api/chats/${c.id}/stage`, { stage: "build" })).status).toBe(200);

      const s = await waitFor("the trust question in the needs list", async () => {
        const x = await r.state(c.id);
        return trustNeed(x, "worker-a") && x;
      });
      expect(trustNeed(s, "worker-a")).toMatchObject({ kind: "trust", text: "worker-a: trust question", agent: "worker-a" });
      expect(s.needs.some((n) => n.kind === "permission" && n.agent === "worker-a")).toBe(false);
      expect(s.agents.find((a) => a.id === "worker-a")).toMatchObject({ tool: flavor, status: "needsYou" });
      // It waits: after a few polls the worker still sits at the question and the build has not moved.
      await Bun.sleep(700);
      expect(s.build.status).not.toBe("done");
      expect((await r.state(c.id)).build.status).not.toBe("done");
      expect(trustNeed(await r.state(c.id), "worker-a")).toBeDefined();

      // The owner answers in the terminal. Nothing else is done.
      answer(r, c.id, "worker-a", flavor);
      const done = await waitFor("the build to end", async () => {
        const x = await r.state(c.id);
        return x.build.status === "done" && x;
      });
      expect(done.tasks?.phases.flatMap((p) => p.tasks).map((t) => [t.id, t.state])).toEqual([["T001", "verified"]]);
      expect(trustNeed(done, "worker-a")).toBeUndefined();
      expect(readRunState(c.dir).sent.some((x) => x.startsWith("worker-a-T001"))).toBe(true);
      if (flavor === "codex") {
        // The Codex worker got its role line first, then the task line.
        const screen = Bun.spawnSync(["tmux", "capture-pane", "-p", "-S", "-200", "-t", `=${r.engine.tmuxOf(c.id, "worker-a")}:`]).stdout.toString();
        const role = screen.indexOf("worker-a.prompt.md");
        const task1 = screen.indexOf("Task T001");
        expect(role).toBeGreaterThanOrEqual(0);
        expect(task1).toBeGreaterThan(role);
      }
    });

    test(`(b) the admin agent of a chat with a repo, at the ${flavor} trust question: a message is queued; after the owner answers it is answered`, async () => {
      const config = flavor === "codex" ? { roles: { admin: { tool: "codex", model: "" } } } : undefined;
      const r = await boot(config, 100, { FAKE_SCREEN: "trust" });
      const c = await planned(r, tasksMd(task("T001")));
      expect((await r.post(`/api/chats/${c.id}/messages`, { id: "m1", text: "say hello" })).status).toBe(200);

      const s = await waitFor("the admin's trust question", async () => {
        const x = await r.state(c.id);
        return trustNeed(x, "admin") && x;
      });
      expect(trustNeed(s, "admin")).toMatchObject({ kind: "trust", text: "admin: trust question" });
      await Bun.sleep(700);
      const waiting = await r.state(c.id);
      expect(waiting.messages.find((m) => m.id === "m1")).toMatchObject({ who: "you", state: "queued" });
      expect(waiting.messages.some((m) => m.who === "admin")).toBe(false);

      answer(r, c.id, "admin", flavor);
      const after = await waitFor("the answer", async () => {
        const x = await r.state(c.id);
        return x.messages.some((m) => m.who === "admin" && m.text === "hello") && x;
      });
      expect(after.messages.find((m) => m.id === "m1")).toMatchObject({ state: "answered" });
      expect(trustNeed(after, "admin")).toBeUndefined();
      expect(after.agents.find((a) => a.id === "admin")?.status).toBe("idle");
    });
  }

  /** The keys the fake agent got, from its input log: `<epoch ms>\t<flavor>\t<phase>\t<kind>\t<text>`. */
  const inputLog = (r: Rig, flavor: "claude" | "codex") => {
    const f = join(r.fakeDir, "fake-input.log");
    if (!existsSync(f)) return [];
    return readFileSync(f, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => {
        const [at, fl, phase, kind, text] = l.split("\t");
        return { at: Number(at), flavor: fl, phase: phase ?? "", kind: kind ?? "", text: text ?? "" };
      })
      .filter((e) => e.flavor === flavor);
  };
  /** The time (epoch ms) of the Codex notify event of the turn whose prompt holds `needle`. */
  const turnEndAt = (chat: string, needle: string): number | undefined => {
    const lines = readFileSync(join(paths.chat(chat), "events.jsonl"), "utf8").split("\n").filter((l) => l !== "");
    for (const l of lines) {
      const row = JSON.parse(l) as { at: number; agent: string; raw: string };
      const msgs = (JSON.parse(row.raw) as { "input-messages"?: string[] })["input-messages"] ?? [];
      if (row.agent === "worker-a" && (msgs[msgs.length - 1] ?? "").includes(needle)) return row.at;
    }
    return undefined;
  };

  test("FLAW 1 and 2: Codex shows the update question, a bare prompt, then the trust question. Nothing is pasted before the owner answers; then the role line and the task line go in once each, and one check runs after the real turn end", async () => {
    const r = await boot(undefined, 100, { FAKE_SCREEN: "update,trust" });
    const c = await planned(r, tasksMd(task("T001")));
    expect((await r.post(`/api/chats/${c.id}/stage`, { stage: "build" })).status).toBe(200);

    // The needs list shows the trust question of the worker.
    const s = await waitFor("the trust question in the needs list", async () => {
      const x = await r.state(c.id);
      return trustNeed(x, "worker-a") && x;
    });
    expect(trustNeed(s, "worker-a")).toMatchObject({ kind: "trust", text: "worker-a: trust question", agent: "worker-a" });
    expect(s.agents.find((a) => a.id === "worker-a")).toMatchObject({ tool: "codex", status: "needsYou" });

    // It waits. The only key the engine sent is the Escape that skipped the update question: no paste and no Enter.
    await Bun.sleep(1500);
    const waiting = await r.state(c.id);
    expect(trustNeed(waiting, "worker-a")).toBeDefined();
    expect(waiting.agents.find((a) => a.id === "worker-a")?.status).toBe("needsYou");
    expect(inputLog(r, "codex").map((e) => [e.phase, e.kind])).toEqual([["update", "esc"]]);
    expect(waiting.build.status).not.toBe("done");

    // The owner answers. Then the worker gets its role line, then its task line, each once, and the build ends.
    answer(r, c.id, "worker-a", "codex");
    const done = await waitFor("the build to end", async () => {
      const x = await r.state(c.id);
      return x.build.status === "done" && x;
    });
    expect(done.tasks?.phases.flatMap((p) => p.tasks).map((t) => [t.id, t.state])).toEqual([["T001", "verified"]]);
    expect(trustNeed(done, "worker-a")).toBeUndefined();

    const log = inputLog(r, "codex");
    const pastes = log.filter((e) => e.kind === "paste");
    expect(pastes).toHaveLength(2);
    expect(pastes[0]?.text).toContain("worker-a.prompt.md");
    expect(pastes[0]?.text).toContain("It is your role");
    expect(pastes[1]?.text).toMatch(/^Task T001: read .*worker-a-T001-v1\.md and do what it says\.$/);
    // The first Enter is the owner's. The engine's two Enters came after it, each after its paste.
    expect(log.filter((e) => e.kind === "enter").map((e) => e.phase)).toEqual(["trust", "main", "main"]);
    expect((log.find((e) => e.kind === "enter" && e.phase === "trust")?.at ?? 0)).toBeLessThan(pastes[0]?.at ?? 0);

    // FLAW 2: the worker's task did not go to `checking` on its own: no attempt, one check, after the worker's turn.
    const run = readRunState(c.dir).tasks.T001;
    expect(run?.attempts).toBe(0);
    expect(run?.runs).toBe(1);
    expect(existsSync(join(c.dir, "run", "logs", "T001-1.log"))).toBe(true);
    expect(existsSync(join(c.dir, "run", "logs", "T001-2.log"))).toBe(false);
    expect(readRunState(c.dir).sent.filter((x) => x.startsWith("worker-a-T001"))).toEqual(["worker-a-T001-v1"]);
    const turnEnd = turnEndAt(c.id, "Task T001");
    expect(turnEnd).toBeDefined();
    expect(statSync(join(c.wt, "src", "T001.txt")).mtimeMs).toBeGreaterThanOrEqual(turnEnd ?? Infinity); // the check made this file
  });

  test("FLAW 2: the turn of Codex's role line ends after the task line went in: it is not the task's turn, so no check runs before the task's own turn ends", async () => {
    // A turn takes 600 ms, and the engine waits only 50 ms for the role turn: the task line is pasted while the role turn runs.
    const r = await boot(undefined, 100, { FAKE_TURN_MS: "600" }, { roleTurnMs: 50 });
    const c = await planned(r, tasksMd(task("T001")));
    expect((await r.post(`/api/chats/${c.id}/stage`, { stage: "build" })).status).toBe(200);
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");

    const run = readRunState(c.dir).tasks.T001;
    expect(run).toMatchObject({ state: "verified", attempts: 0, runs: 1 });
    expect(existsSync(join(c.dir, "run", "logs", "T001-2.log"))).toBe(false);
    // The worker's own turn ends 600 ms after the role turn's end. The check must come after it, not after the role turn.
    const turnEnd = await waitFor("the notify of the task's turn", () => turnEndAt(c.id, "Task T001"), 5000);
    expect(statSync(join(c.wt, "src", "T001.txt")).mtimeMs).toBeGreaterThanOrEqual(turnEnd);
    // The two lines went in once each, role line first.
    const pastes = inputLog(r, "codex").filter((e) => e.kind === "paste");
    expect(pastes.map((e) => (e.text.includes("It is your role") ? "role" : e.text.slice(0, 10)))).toEqual(["role", "Task T001:"]);
  });

  test("a line for the orchestrator, sent while its trust question is up, goes in after the owner answers", async () => {
    const r = await boot(undefined, 100, { FAKE_SCREEN: "trust" });
    const c = await planned(r, tasksMd(task("T001")));
    const spec = { id: "orchestrator", role: "orchestrator" as const, tool: "claude" as const, model: "", cwd: c.wt, promptFile: null };
    await r.engine.agents.ensure(c.id, spec);
    expect(r.engine.agents.status(c.id, "orchestrator")).toBe("needsYou");
    await r.engine.agents.send(c.id, "orchestrator", "say the brief"); // does not throw: it waits for the answer
    const session = r.engine.tmuxOf(c.id, "orchestrator");
    const screen = () => Bun.spawnSync(["tmux", "capture-pane", "-p", "-S", "-200", "-t", `=${session}:`]).stdout.toString();
    await Bun.sleep(500);
    expect(screen()).not.toContain("say the brief");
    expect(screen()).toContain("No, exit");

    answer(r, c.id, "orchestrator", "claude");
    await waitFor("the line to reach the orchestrator", () => screen().includes("⏺ the brief"));
    await waitFor("the turn to end", () => r.engine.agents.status(c.id, "orchestrator") === "idle");
  });
});

describe("claudeArgs of the config", () => {
  const startCommand = (name: string): string =>
    Bun.spawnSync(["tmux", "display-message", "-p", "-t", `=${name}:`, "#{pane_start_command}"], { stdout: "pipe", stderr: "pipe" }).stdout.toString();

  test("every Claude Code agent starts with the claudeArgs of the config; none is the default", async () => {
    const r = await boot({ claudeArgs: ["--setting-sources", "project,local"] });
    const created = (await (await r.post("/api/chats", { title: "Args" })).json()) as ChatState;
    await r.post(`/api/chats/${created.chat.id}/messages`, { id: "m1", text: "say hello" });
    await waitFor("the reply", async () => (await r.state(created.chat.id)).messages.some((m) => m.who === "admin" && m.text === "hello"));
    const cmd = startCommand(r.engine.tmuxOf(created.chat.id, "admin"));
    expect(cmd).toContain("--settings");
    expect(cmd).toMatch(/--setting-sources\W+project,local/);

    const plain = await boot();
    const c2 = (await (await plain.post("/api/chats", { title: "Plain" })).json()) as ChatState;
    await plain.post(`/api/chats/${c2.chat.id}/messages`, { id: "m1", text: "say hello" });
    await waitFor("the reply", async () => (await plain.state(c2.chat.id)).messages.some((m) => m.who === "admin" && m.text === "hello"));
    expect(startCommand(plain.engine.tmuxOf(c2.chat.id, "admin"))).not.toContain("--setting-sources");
  });
});

describe("a Stop that does not end the turn", () => {
  test("a worker whose turn gives two Stop events: its check is queued only after the real end", async () => {
    const BLOCK = 3500;
    const r = await boot({ roles: { worker: { tool: "claude", model: "sonnet" } } }, 100, { FAKE_BLOCK_MS: String(BLOCK) });
    const c = await planned(r, tasksMd(task("T001")));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    let working = 0;
    let past = 0;
    await waitFor("the task past its turn", async () => {
      const st = await taskState(r, c.id, "T001");
      if (st === "working" && working === 0) working = Date.now();
      if (working > 0 && st !== "working" && st !== "assigned" && past === 0) past = Date.now();
      return past > 0;
    });
    // The first Stop came about a second after the turn began. The check waited for the second one.
    expect(past - working).toBeGreaterThan(BLOCK - 1500);
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
    expect(readFileSync(join(c.wt, "src", "T001.txt"), "utf8").trim()).toBe("T001");
  });
});

describe("G6b: Halt is not undone by a late event", () => {
  const worker = (wt: string) => ({ id: "worker-a", role: "worker" as const, tool: "claude" as const, model: "m", cwd: wt, promptFile: null });
  const statusOf = async (r: Rig, id: string, agent: string) => (await r.state(id)).agents.find((a) => a.id === agent)?.status;
  const lastPasted = (id: string, agent: string) => (JSON.parse(readFileSync(join(paths.chat(id), "agents", `${agent}.json`), "utf8")) as { lastPasted: string | null }).lastPasted;

  test("Halt during a slow turn: the agent shows halted, still halted 3 seconds later; Resume sends continue and it works again", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.engine.sessions.ensure(c.id, worker(c.wt));
    await r.engine.sessions.send(c.id, "worker-a", "slow 5000 x");
    await waitFor("working", async () => (await statusOf(r, c.id, "worker-a")) === "working");
    expect((await r.post(`/api/chats/${c.id}/halt`)).status).toBe(200);
    expect(await statusOf(r, c.id, "worker-a")).toBe("halted");
    await Bun.sleep(3000);
    expect(await statusOf(r, c.id, "worker-a")).toBe("halted");
    // The turn ended by Escape, and its hook event came in. The agent is still halted.
    await Bun.sleep(3000);
    expect(await statusOf(r, c.id, "worker-a")).toBe("halted");

    expect((await r.post(`/api/chats/${c.id}/resume`)).status).toBe(200);
    await waitFor("continue", () => lastPasted(c.id, "worker-a") === "continue");
    await waitFor("idle again", async () => (await statusOf(r, c.id, "worker-a")) === "idle");
  });

  test("Halt of a worker that is still starting: it shows halted, and the end of its start does not make it idle", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    const started = r.engine.sessions.ensure(c.id, worker(c.wt));
    await waitFor("starting", () => r.engine.sessions.status(c.id, "worker-a") === "starting");
    expect((await r.post(`/api/chats/${c.id}/halt`)).status).toBe(200);
    await started.catch(() => undefined);
    await Bun.sleep(1500);
    expect(await statusOf(r, c.id, "worker-a")).toBe("halted");
  });

  test("Halt while a build hands a task to a worker that is still starting: no prompt goes out, the worker stays halted, and Resume hands the task out", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.post(`/api/chats/${c.id}/stage`, { stage: "build" });
    await waitFor("worker-a starting", () => r.engine.sessions.status(c.id, "worker-a") === "starting");
    expect((await r.post(`/api/chats/${c.id}/halt`)).status).toBe(200);
    await Bun.sleep(3000);
    expect(await statusOf(r, c.id, "worker-a")).toBe("halted");
    expect(lastPasted(c.id, "worker-a")).toBeNull();
    expect(await taskState(r, c.id, "T001")).toBe("assigned");
    expect((await r.post(`/api/chats/${c.id}/resume`)).status).toBe(200);
    await waitFor("the build to end", async () => (await r.state(c.id)).build.status === "done");
  });

  test("a line sent to a halted agent is refused and changes nothing", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.engine.sessions.ensure(c.id, worker(c.wt));
    await r.post(`/api/chats/${c.id}/halt`);
    await expect(r.engine.sessions.send(c.id, "worker-a", "say hi")).rejects.toThrow(/halted/);
    expect(await statusOf(r, c.id, "worker-a")).toBe("halted");
    expect(lastPasted(c.id, "worker-a")).toBeNull();
  });

  test("a paused agent stays paused through Halt, and the admin agent is not halted", async () => {
    const r = await boot();
    const c = await planned(r, tasksMd(task("T001")));
    await r.engine.sessions.ensure(c.id, worker(c.wt));
    await r.engine.sessions.ensure(c.id, { id: "admin", role: "admin", tool: "claude", model: "m", cwd: c.wt, promptFile: null });
    await r.post(`/api/chats/${c.id}/agents/worker-a/pause`);
    expect(await statusOf(r, c.id, "worker-a")).toBe("paused");
    await r.post(`/api/chats/${c.id}/halt`);
    await Bun.sleep(1500);
    expect(await statusOf(r, c.id, "worker-a")).toBe("paused");
    expect(await statusOf(r, c.id, "admin")).toBe("idle");
  });
});

describe("the engine as a reviewer found it", () => {
  test("an agent event handler that throws does not stop the handlers after it", async () => {
    const r = await boot(undefined, 60_000);
    const c = await planned(r, tasksMd(task("T001")));
    r.engine.usage.onEvent = () => {
      throw new Error("the usage switch broke");
    };
    const before = r.published.filter((e) => e.type === "chat" && e.id === c.id).length;
    appendHookEvent(c.id, { agent: "worker-a", tool: "claude", raw: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: "/x", cwd: c.wt, last_assistant_message: "hi" }) });
    r.engine.sessions.applyNow(c.id);
    // The last step of the fan-out is the publish of the chat. It ran although a step before it threw.
    expect(r.published.filter((e) => e.type === "chat" && e.id === c.id).length).toBeGreaterThan(before);
  });

  test("a recovery that fails at the start does not keep the chats' builds from their look", async () => {
    const r = await boot(undefined, 60_000);
    const c = await planned(r, tasksMd(task("T001")));
    r.engine.chat.recover = async () => {
      throw new Error("the conversations did not recover");
    };
    const kicked: string[] = [];
    r.engine.loop.kick = (id) => {
      kicked.push(id);
    };
    await r.engine.start();
    expect(kicked).toContain(c.id);
  });

  test("stop() ends the engine's listeners: a hook event after it reaches no part", async () => {
    const r = await boot(undefined, 60_000);
    const created = (await (await r.post("/api/chats", { title: "Quiet" })).json()) as ChatState;
    const id = created.chat.id;
    r.engine.stop();
    const before = { published: r.published.length, messages: (await r.state(id)).messages.length };
    appendHookEvent(id, { agent: "admin", tool: "claude", raw: JSON.stringify({ hook_event_name: "Stop", session_id: "s1", transcript_path: "/x", cwd: "/", last_assistant_message: "after the stop" }) });
    r.engine.sessions.applyNow(id);
    expect(r.published.length).toBe(before.published);
    expect((await r.state(id)).messages.length).toBe(before.messages);
  });

  test("stop() ends a running check, so the next start does not run it twice", async () => {
    const r = await boot(undefined, 60_000);
    const c = await planned(r, tasksMd("- [ ] T001 Wait — `src/a.txt` — verify: `sleep 30` (in scope #1)"));
    const answer = r.engine.runCheck(c.id, "T001");
    await waitFor("the check to run", () => r.engine.queueItems(c.id).some((i) => i.state === "running"));
    const t0 = Date.now();
    r.engine.stop();
    expect((await answer).outcome).toBe("dropped");
    expect(Date.now() - t0).toBeLessThan(10_000);
    expect(r.engine.queueItems(c.id)).toEqual([]);
  });
});

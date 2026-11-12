import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { chmodSync, existsSync, mkdirSync, readFileSync, realpathSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import type { Subprocess } from "bun";
import { kill, list } from "../src/agents/tmux.ts";
import type { ChatSummary } from "../src/types.ts";
import { drop, fixture, repoRoot, tempDir } from "./helpers.ts";

const CLI = join(repoRoot, "engine", "src", "cli.ts");
const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

let home: string;
let procs: Subprocess[];
let dirs: string[];

beforeEach(() => {
  home = tempDir("starship-home-");
  procs = [];
  dirs = [];
});
afterEach(async () => {
  for (const p of procs) {
    p.kill("SIGKILL");
    await p.exited;
  }
  drop(home);
  for (const d of dirs) drop(d);
});

const env = () => ({ ...process.env, STARSHIP_HOME: home });

function run(...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, ...args], { env: env(), stdout: "pipe", stderr: "pipe", cwd: repoRoot });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function runAs(extra: Record<string, string>, ...args: string[]): { code: number; out: string; err: string } {
  const r = Bun.spawnSync(["bun", CLI, ...args], { env: { ...env(), ...extra }, stdout: "pipe", stderr: "pipe", cwd: repoRoot });
  return { code: r.exitCode ?? -1, out: r.stdout.toString(), err: r.stderr.toString() };
}

function daemon(...args: string[]): Subprocess<"ignore", "pipe", "pipe"> {
  const p = Bun.spawn(["bun", CLI, "daemon", ...args], { env: env(), stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: repoRoot });
  procs.push(p);
  return p;
}

async function waitFor<T>(what: string, f: () => T | null | undefined | false, ms = 5000): Promise<T> {
  const until = Date.now() + ms;
  while (Date.now() < until) {
    const v = f();
    if (v) return v;
    await Bun.sleep(25);
  }
  throw new Error(`timed out waiting for ${what}`);
}

const engineFile = () => join(home, "engine.json");
const readEngine = () => {
  try {
    return JSON.parse(readFileSync(engineFile(), "utf8")) as { pid: number; port: number; token: string };
  } catch {
    return null;
  }
};

async function firstLine(p: Subprocess<"ignore", "pipe", "pipe">): Promise<string> {
  const reader = p.stdout.getReader();
  let text = "";
  while (!text.includes("\n")) {
    const { value, done } = await reader.read();
    if (done) break;
    text += new TextDecoder().decode(value);
  }
  reader.releaseLock();
  return text.split("\n")[0] ?? "";
}

describe("cli", () => {
  test("status with no engine says not running", () => {
    expect(run("status")).toMatchObject({ code: 0, out: "not running\n" });
    expect(JSON.parse(run("status", "--json").out)).toEqual({ running: false });
  });

  test("status with a stale engine.json says not running", () => {
    writeFileSync(engineFile(), JSON.stringify({ pid: 999999, port: randomPort(), token: "x" }));
    expect(JSON.parse(run("status", "--json").out)).toEqual({ running: false });
  });

  test("a daemon starts, status shows it, a second daemon does not start, chats show in the engine, SIGTERM stops it", async () => {
    const port = randomPort();
    const d = daemon("--port", String(port));
    const line = await firstLine(d);
    const info = await waitFor("engine.json", readEngine);
    expect(info.pid).toBe(d.pid);
    expect(info.port).toBeGreaterThanOrEqual(port);
    expect(line).toBe(`Starship engine http://127.0.0.1:${info.port}/?token=${info.token}`);

    const st = JSON.parse(run("status", "--json").out);
    expect(st).toMatchObject({ running: true, pid: d.pid, port: info.port });
    expect(run("status").out).toBe(`running http://127.0.0.1:${info.port} pid ${d.pid}\n`);
    expect((await fetch(`http://127.0.0.1:${info.port}/health`)).status).toBe(200);

    const second = run("daemon", "--port", String(randomPort()));
    expect(second.code).toBe(0);
    expect(second.out).toBe(`${line}\n`);
    expect(readEngine()).toEqual(info);

    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/api/events?token=${info.token}`);
    const events: string[] = [];
    ws.onmessage = (m) => events.push(String(m.data));
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("no socket"));
    });

    const made = run("chat", "new", "--title", "Recipe search", "--folder", fixture("recipe-search"));
    expect(made).toMatchObject({ code: 0, out: "recipe-search\n" });
    expect(run("chat", "list").out).toBe("recipe-search\tplan\tRecipe search\n");
    const res = await fetch(`http://127.0.0.1:${info.port}/api/chats`, { headers: { authorization: `Bearer ${info.token}` } });
    const chats = (await res.json()) as ChatSummary[];
    expect(chats.map((c) => c.id)).toEqual(["recipe-search"]);
    await waitFor("a chats event", () => events.includes(JSON.stringify({ type: "chats" })));
    ws.close();

    d.kill("SIGTERM");
    expect(await d.exited).toBe(0);
    expect(existsSync(engineFile())).toBe(false);
    expect(run("status").out).toBe("not running\n");
  }, 20000);

  test("I5: a restarted engine keeps its token, so an open window works again", async () => {
    const port = randomPort();
    const first = daemon("--port", String(port));
    await firstLine(first);
    const before = await waitFor("engine.json", readEngine);
    first.kill("SIGTERM");
    await first.exited;

    const second = daemon("--port", String(port));
    await firstLine(second);
    const after = await waitFor("the second engine", () => {
      const e = readEngine();
      return e && e.pid === second.pid ? e : null;
    });
    expect(after.token).toBe(before.token);
    expect((await fetch(`http://127.0.0.1:${after.port}/api/chats`, { headers: { cookie: `starship=${before.token}` } })).status).toBe(200);
  });

  test("the daemon watches a chat's feature folder and pushes a chat event on a change", async () => {
    const base = tempDir();
    dirs.push(base);
    const folder = join(base, "feature");
    Bun.spawnSync(["cp", "-R", fixture("recipe-search"), folder]);
    expect(run("chat", "new", "--title", "Watched", "--folder", folder).code).toBe(0);
    const d = daemon("--port", String(randomPort()));
    await firstLine(d);
    const info = await waitFor("engine.json", readEngine);
    const ws = new WebSocket(`ws://127.0.0.1:${info.port}/api/events?token=${info.token}`);
    const events: string[] = [];
    ws.onmessage = (m) => events.push(String(m.data));
    await new Promise<void>((resolve) => {
      ws.onopen = () => resolve();
    });
    await Bun.sleep(100);
    writeFileSync(join(folder, "PLAN.md"), "# PLAN — changed by hand\n");
    await waitFor("a chat event", () => events.includes(JSON.stringify({ type: "chat", id: "watched" })), 3000);
    const state = await (await fetch(`http://127.0.0.1:${info.port}/api/chats/watched`, { headers: { authorization: `Bearer ${info.token}` } })).json();
    expect(state.handEdits).toEqual(["PLAN.md"]);
    ws.close();
    d.kill("SIGINT");
    expect(await d.exited).toBe(0);
    expect(existsSync(engineFile())).toBe(false);
  }, 20000);

  test("repo add and repo list", () => {
    const dir = tempDir("starship-repo-");
    dirs.push(dir);
    const g = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a]);
    g("init", "-q", "-b", "main");
    writeFileSync(join(dir, "a.txt"), "a\n");
    g("add", ".");
    g("commit", "-q", "-m", "one");
    const added = run("repo", "add", dir, "--name", "demo");
    expect(added).toMatchObject({ code: 0, out: `demo\tmain\t${realpathSync(dir)}\n` });
    expect(run("repo", "list").out).toBe(`demo\tmain\t${realpathSync(dir)}\n`);
    expect(run("chat", "new", "--title", "On demo", "--repo", "demo").code).toBe(0);
    // A repo with no map: the chat gets a worktree and opens in Map.
    expect(run("chat", "list").out).toBe("on-demo\tmap\tOn demo\n");
    expect(existsSync(join(home, "worktrees", "demo", "on-demo", "docs", "features", "on-demo", "run"))).toBe(true);
  });

  test("errors print one line to stderr and exit 1", () => {
    const plain = tempDir();
    dirs.push(plain);
    const r = run("repo", "add", plain);
    expect(r.code).toBe(1);
    expect(r.err.trim().split("\n").length).toBe(1);
    expect(r.err).toContain("not a git repo");
    const c = run("chat", "new", "--title", "X", "--repo", "nope");
    expect(c.code).toBe(1);
    expect(c.err).toBe('no repo "nope"\n');
    expect(run("chat", "new", "--title", "X", "--folder", "/no/such/folder").code).toBe(1);
  });

  /** Runs a daemon to its end, or kills it after `ms`. */
  async function daemonEnds(extraEnv: Record<string, string>, args: string[], ms = 8000): Promise<{ code: number | null; err: string; out: string; secs: number }> {
    const start = Date.now();
    const p = Bun.spawn(["bun", CLI, "daemon", ...args], { env: { ...env(), ...extraEnv }, stdin: "ignore", stdout: "pipe", stderr: "pipe", cwd: repoRoot });
    procs.push(p);
    const timer = setTimeout(() => p.kill("SIGKILL"), ms);
    const code = await p.exited;
    clearTimeout(timer);
    const secs = (Date.now() - start) / 1000;
    return { code: p.signalCode ? null : code, err: await new Response(p.stderr).text(), out: await new Response(p.stdout).text(), secs };
  }

  test("I6 the daemon fails loudly when engine.json cannot be written: one line, exit 1, under 5 s", async () => {
    const base = tempDir();
    dirs.push(base);
    // STARSHIP_HOME under a regular file: no folder can be made there.
    writeFileSync(join(base, "file"), "x");
    const r = await daemonEnds({ STARSHIP_HOME: join(base, "file", "home") }, ["--port", String(randomPort())]);
    expect(r.code).toBe(1);
    expect(r.secs).toBeLessThan(5);
    expect(r.err.trim().split("\n")).toHaveLength(1);
    expect(r.err).toContain("engine.json");
    expect(r.out).toBe("");

    // A read-only STARSHIP_HOME.
    const ro = join(base, "ro");
    mkdirSync(ro);
    chmodSync(ro, 0o555);
    try {
      const r2 = await daemonEnds({ STARSHIP_HOME: ro }, ["--port", String(randomPort())]);
      expect(r2.code).toBe(1);
      expect(r2.secs).toBeLessThan(5);
      expect(r2.err.trim().split("\n")).toHaveLength(1);
      expect(r2.err).toContain("engine.json");
      expect(existsSync(join(ro, "engine.json"))).toBe(false);
    } finally {
      chmodSync(ro, 0o755);
    }
  }, 20000);

  test("I6 the daemon fails loudly when no port can be bound: one line, exit 1, under 5 s", async () => {
    // Take every port the daemon would try: the start port and the 49 after it.
    let held: ReturnType<typeof Bun.serve>[] = [];
    let from = 0;
    for (let attempt = 0; attempt < 5 && !from; attempt++) {
      const start = 20000 + Math.floor(Math.random() * 20000);
      held = [];
      try {
        for (let port = start; port < start + 50; port++) held.push(Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("taken") }));
        from = start;
      } catch {
        for (const s of held) s.stop(true);
      }
    }
    expect(from).toBeGreaterThan(0);
    try {
      const r = await daemonEnds({}, ["--port", String(from)]);
      expect(r.code).toBe(1);
      expect(r.secs).toBeLessThan(5);
      expect(r.err.trim().split("\n")).toHaveLength(1);
      expect(r.err).toContain(`port`);
      expect(r.out).toBe("");
      expect(existsSync(engineFile())).toBe(false);
    } finally {
      for (const s of held) s.stop(true);
    }
  }, 20000);

  test("I3 a taken port moves the daemon to the next free one", async () => {
    const port = randomPort();
    const taken = Bun.serve({ hostname: "127.0.0.1", port, fetch: () => new Response("taken") });
    try {
      const d = daemon("--port", String(port));
      await firstLine(d);
      const info = await waitFor("engine.json", readEngine);
      expect(info.port).toBeGreaterThan(port);
      d.kill("SIGTERM");
      expect(await d.exited).toBe(0);
    } finally {
      taken.stop(true);
    }
  }, 20000);

  test("a bad command, a bad option and a missing argument exit 2 with usage", () => {
    for (const args of [["fly"], [], ["repo"], ["repo", "remove", "x"], ["chat", "new"], ["status", "--verbose"], ["daemon", "--port", "80"], ["daemon", "--port"], ["repo", "add"], ["task"], ["task", "fly"], ["task", "add", "--phase", "1"], ["task", "add", "--phase", "x", "--text", "t", "--files", "a"], ["task", "split", "T001", "--into", "one"], ["task", "block", "T001"], ["task", "retry"], ["check"], ["check", "a", "b"], ["note", "ack"], ["note", "ack", "x"], ["chat", "halt"], ["agent", "pause", "one"], ["agent", "fly", "a", "b"], ["term", "one"], ["map", "overlay"]]) {
      const r = run(...args);
      expect(r.code).toBe(2);
      expect(r.err).toContain("usage:");
    }
    expect(existsSync(engineFile())).toBe(false);
  });
});

describe("cli: the commands of the agents call the engine", () => {
  let feature: string;
  const AS = { STARSHIP_CHAT: "work", STARSHIP_AGENT: "codex" };

  const SPEC = "# SPEC\n\n## Problem\n\nA problem.\n\n## Scope\n\n- one\n";
  const PLAN = ["# PLAN", "", "## Goal", "", "A goal.", "", "## In scope", "", "1. Alpha", "", "## Out of scope", "", "- Gamma", "", "## Data", "", "## Interfaces", "", "## Errors", "", "## Edge cases", "", "## Tests", "", "## Rollout", ""].join("\n");
  const TASKS = "# TASKS\n\n## Phase 0 — Foundation\n\n- [ ] T001 Do alpha — `a.ts` — verify: `bun test a` (plan: In scope #1)\n";

  async function startEngine(): Promise<void> {
    const d = daemon("--port", String(randomPort()));
    await firstLine(d);
    await waitFor("engine.json", readEngine);
  }

  beforeEach(() => {
    const base = tempDir();
    dirs.push(base);
    feature = join(base, "docs", "features", "work");
    mkdirSync(join(base, "docs", "features"), { recursive: true });
    Bun.spawnSync(["cp", "-R", fixture("recipe-search"), feature]);
    expect(run("chat", "new", "--title", "Work", "--folder", feature).out).toBe("work\n");
  });

  function gitRepo(features: string[] = []): string {
    const dir = tempDir("starship-repo-");
    dirs.push(dir);
    const g = (...a: string[]) => Bun.spawnSync(["git", "-C", dir, "-c", "user.name=T", "-c", "user.email=t@example.com", "-c", "commit.gpgsign=false", ...a]);
    g("init", "-q", "-b", "main");
    writeFileSync(join(dir, "README.md"), "# Demo repo\n");
    mkdirSync(join(dir, "src"));
    writeFileSync(join(dir, "src", "a.ts"), "export {};\n");
    for (const f of features) {
      mkdirSync(join(dir, "docs", "features", f), { recursive: true });
      writeFileSync(join(dir, "docs", "features", f, "PLAN.md"), "# Plan\n");
    }
    g("add", ".");
    g("commit", "-q", "-m", "one");
    return dir;
  }

  test("a daemon writes <home>/bin/starship for its agents; the hook and status commands never fail", async () => {
    await startEngine();
    await waitFor("the bin script", () => existsSync(join(home, "bin", "starship")));
    const script = readFileSync(join(home, "bin", "starship"), "utf8");
    expect(script.split("\n").filter(Boolean)).toHaveLength(2);
    expect(script).toContain(CLI);
    // The script is the same program: `starship status --json` through it sees the engine.
    const viaScript = Bun.spawnSync([join(home, "bin", "starship"), "status", "--json"], { env: env(), stdout: "pipe" });
    expect(JSON.parse(viaScript.stdout.toString())).toMatchObject({ running: true });

    // A hook with no chat or agent in its environment prints nothing, exits 0, and leaves a line in the error log.
    const hook = Bun.spawnSync(["bun", CLI, "hook", "claude"], { env: env(), stdin: Buffer.from("{}"), stdout: "pipe", stderr: "pipe" });
    expect({ code: hook.exitCode, out: hook.stdout.toString(), err: hook.stderr.toString() }).toEqual({ code: 0, out: "", err: "" });
    expect(readFileSync(join(home, "hook-errors.log"), "utf8")).toContain("STARSHIP_CHAT and STARSHIP_AGENT must be set");
    // The status line command: JSON on stdin gives `starship`, and the input is kept for the engine.
    const line = Bun.spawnSync(["bun", CLI, "status"], { env: env(), stdin: Buffer.from('{"a":1}'), stdout: "pipe" });
    expect(line.stdout.toString()).toBe("starship\n");
    expect(JSON.parse(readFileSync(join(home, "usage", "claude-status.json"), "utf8"))).toEqual({ a: 1 });
  }, 20000);

  test("with no engine running each command says so and exits 1", () => {
    for (const args of [["plan", "check"], ["note", "--to", "plan", "--said", "a", "b"], ["ask", "--task", "T1", "why"], ["answer", "Q1", "yes"], ["finding", "accept", "1"], ["card", "result", "C1", "pass", "ok"], ["map", "build", "demo"], ["note", "ack", "1"], ["task", "retry", "T001"], ["check", "T001"], ["chat", "halt", "work"], ["chat", "resume", "work"], ["agent", "pause", "work", "worker-a"], ["term", "work", "worker-a"], ["finding", "none"], ["map", "overlay", "o.json"]]) {
      const r = runAs(AS, ...args);
      expect(r.code).toBe(1);
      expect(r.err).toBe("the engine is not running. Start it with: starship daemon\n");
      expect(r.out).toBe("");
    }
  });

  test("a missing chat, agent or option is a usage error and exits 2", async () => {
    await startEngine();
    for (const [extra, args] of [
      [{}, ["plan", "check"]],
      [{}, ["note", "--to", "plan", "--said", "a", "b"]],
      [{ STARSHIP_CHAT: "work" }, ["ask", "--task", "T1", "why"]],
      [{ STARSHIP_CHAT: "work" }, ["finding", "add", "--sev", "high", "--where", "a.ts:1", "bad"]],
      [AS, ["note", "--said", "a", "b"]],
      [AS, ["note", "--to", "plan", "b"]],
      [AS, ["note", "--to", "plan", "--said", "a"]],
      [AS, ["ask", "why"]],
      [AS, ["answer"]],
      [AS, ["finding", "add", "--where", "a.ts:1", "bad"]],
      [AS, ["finding", "reject", "1"]],
      [AS, ["card", "result", "C1"]],
      [AS, ["map", "build"]],
      [AS, ["map", "import", "x.json"]],
    ] as [Record<string, string>, string[]][]) {
      const r = runAs(extra, ...args);
      expect({ args, code: r.code }).toEqual({ args, code: 2 });
      expect(r.err).toContain("usage:");
    }
  }, 20000);

  test("plan check prints one file:line line for each problem and exits 1; a valid plan prints one line and exits 0", async () => {
    await startEngine();
    const bad = runAs(AS, "plan", "check");
    expect(bad.code).toBe(1);
    const lines = bad.out.trim().split("\n");
    expect(lines.length).toBeGreaterThan(0);
    for (const l of lines) expect(l).toMatch(/^[A-Za-z]+\.md(:\d+)? \S.*$/);
    expect(bad.out).toContain("PLAN.md has no section for");
    expect(bad.err).toBe("");

    writeFileSync(join(feature, "SPEC.md"), SPEC);
    writeFileSync(join(feature, "PLAN.md"), PLAN);
    writeFileSync(join(feature, "TASKS.md"), TASKS);
    writeFileSync(join(feature, "ACCEPTANCE.md"), "# Acceptance\n\n## Behavior\n\n- Alpha works.\n");
    expect(runAs({}, "plan", "check", "--chat", "work")).toMatchObject({ code: 0, out: "plan is valid\n" });
    // An unknown chat is the engine's error.
    const gone = runAs({}, "plan", "check", "--chat", "nope");
    expect(gone).toMatchObject({ code: 1, out: "" });
    expect(gone.err).toBe('no chat "nope"\n');
  }, 20000);

  test("note prints its number and status; the chat comes from --chat or STARSHIP_CHAT", async () => {
    await startEngine();
    expect(runAs(AS, "note", "--to", "orchestrator", "--said", "match the dash too", "Match R111 and R-111.")).toMatchObject({ code: 0, out: "note 4 queued\n" });
    expect(runAs({}, "note", "--chat", "work", "--to", "plan", "--said", "owner words", "A plan change.")).toMatchObject({ code: 0, out: "note 5 read\n" });
    expect(readFileSync(join(feature, "run", "handoffs.md"), "utf8")).toContain("You: match the dash too\nNote: Match R111 and R-111.\nStatus: queued");
    const bad = runAs(AS, "note", "--to", "nobody", "--said", "a", "b");
    expect(bad.code).toBe(1);
    expect(bad.err).toContain('"to" must be one of');
  }, 20000);

  test("ask adds a question as the agent in STARSHIP_AGENT; answer closes it", async () => {
    await startEngine();
    expect(runAs({ ...AS, STARSHIP_AGENT: "worker-a" }, "ask", "--task", "T024", "Sort by name or number?")).toMatchObject({ code: 0, out: "Q2 asked\n" });
    expect(readFileSync(join(feature, "run", "questions.md"), "utf8")).toMatch(/## Q2 · \d\d:\d\d · worker-a · T024\nSort by name or number\?\nStatus: open/);
    expect(runAs(AS, "answer", "Q2", "By", "name.")).toMatchObject({ code: 0, out: "Q2 answered\n" });
    expect(readFileSync(join(feature, "run", "questions.md"), "utf8")).toContain("Answer: By name.");
    const twice = runAs(AS, "answer", "Q2", "again");
    expect(twice.code).toBe(1);
    expect(twice.err).toBe("Q2 is already answered\n");
    expect(runAs(AS, "answer", "Q9", "x")).toMatchObject({ code: 1, err: "no question Q9\n" });
  }, 20000);

  test("finding add, dispute, accept and reject", async () => {
    await startEngine();
    expect(runAs(AS, "finding", "add", "--sev", "high", "--where", "api/a.ts:12", "It", "breaks.")).toMatchObject({ code: 0, out: "F3 open\n" });
    const own = runAs(AS, "finding", "dispute", "3", "mine");
    expect(own.code).toBe(1);
    expect(own.err).toContain("cannot dispute its own finding");
    expect(runAs({ ...AS, STARSHIP_AGENT: "claude" }, "finding", "dispute", "3", "It does not.")).toMatchObject({ code: 0, out: "F3 disputed\n" });
    expect(runAs(AS, "finding", "accept", "3")).toMatchObject({ code: 0, out: "F3 accepted\n" });
    expect(runAs(AS, "finding", "reject", "1", "By", "design.")).toMatchObject({ code: 0, out: "F1 rejected\n" });
    const text = readFileSync(join(feature, "run", "review", "findings.md"), "utf8");
    expect(text).toContain("## F3 · high · codex · api/a.ts:12\nIt breaks.\nStatus: accepted\nDispute: claude: It does not.");
    expect(text).toContain("Status: rejected");
    const fixes = readFileSync(join(feature, "run", "review", "fixes.md"), "utf8");
    expect(fixes).toContain("from F3");
    expect(fixes).not.toContain("from F1");
    expect(runAs(AS, "finding", "accept", "9")).toMatchObject({ code: 1, err: "no finding 9\n" });
    expect(runAs(AS, "finding", "add", "--sev", "huge", "--where", "a.ts:1", "x").code).toBe(1);
  }, 20000);

  test("card result writes the card", async () => {
    await startEngine();
    expect(runAs(AS, "card", "result", "C2", "fail", "Found", "nothing.")).toMatchObject({ code: 0, out: "C2 fail\n" });
    expect(readFileSync(join(feature, "run", "review", "story-cards.md"), "utf8")).toContain("Result: fail\nNote: Found nothing.");
    expect(runAs(AS, "card", "result", "C1", "pass")).toMatchObject({ code: 0, out: "C1 pass\n" });
    expect(runAs(AS, "card", "result", "C9", "pass")).toMatchObject({ code: 1, err: "no card C9\n" });
    expect(runAs(AS, "card", "result", "C1", "maybe").code).toBe(1);
  }, 20000);

  test("map validate needs no engine; map import and map build write the repo's map", async () => {
    const good = runAs({}, "map", "validate", fixture("maps", "starship.json"));
    expect(good).toMatchObject({ code: 0, out: "map is valid: starship\n" });
    const badFile = join(tempDir(), "bad.json");
    dirs.push(join(badFile, ".."));
    writeFileSync(badFile, "{nope");
    const bad = runAs({}, "map", "validate", badFile);
    expect(bad.code).toBe(1);
    expect(bad.err).toMatch(/^- .*not valid JSON/);
    expect(bad.out).toBe("");

    const repo = gitRepo();
    expect(run("repo", "add", repo, "--name", "demo").code).toBe(0);
    await startEngine();
    expect(runAs({}, "map", "import", fixture("maps", "starship.json"), "--repo", "demo")).toMatchObject({ code: 0, out: "map imported for demo: starship\n" });
    expect(JSON.parse(readFileSync(join(home, "repos", "demo.map.json"), "utf8")).name).toBe("starship");
    const refused = runAs({}, "map", "import", badFile, "--repo", "demo");
    expect(refused.code).toBe(1);
    expect(refused.err).toContain("map refused");
    expect(runAs({}, "map", "build", "demo")).toMatchObject({ code: 0, out: "map built for demo: 1 boxes, low detail\n" });
    expect(JSON.parse(readFileSync(join(home, "repos", "demo.map.json"), "utf8")).detail).toBe("low");
    expect(runAs({}, "map", "build", "nope")).toMatchObject({ code: 1, err: 'no repo "nope"\n' });
  }, 20000);

  test("chat halt and resume set the flag of a chat on a folder; note ack and finding none go to the engine", async () => {
    await startEngine();
    expect(runAs({}, "chat", "halt", "work")).toMatchObject({ code: 0, out: "work halted\n" });
    expect(runAs({}, "chat", "halt", "work").out).toBe("work was halted already\n");
    expect(JSON.parse(readFileSync(join(home, "chats", "work", "chat.json"), "utf8")).halted).toMatch(/^\d\d:\d\d$/);
    expect(runAs({}, "chat", "resume", "work").out).toBe("work resumed\n");
    expect(runAs({}, "chat", "resume", "work").out).toBe("work had nothing to resume\n");
    expect(runAs({}, "chat", "halt", "nope")).toMatchObject({ code: 1, err: 'no chat "nope"\n' });

    expect(runAs(AS, "note", "--to", "orchestrator", "--said", "a", "A note.").out).toBe("note 4 queued\n");
    expect(runAs(AS, "note", "ack", "4", "N5")).toMatchObject({ code: 0, out: "read note 4, note 5\n" });
    expect(runAs({}, "note", "ack", "4")).toMatchObject({ code: 2 });
    expect(runAs({ ...AS, STARSHIP_CHAT: "nope" }, "note", "ack", "4")).toMatchObject({ code: 1, err: 'no chat "nope"\n' });

    expect(runAs({ ...AS, STARSHIP_AGENT: "reviewer-1" }, "finding", "none")).toMatchObject({ code: 0, out: "reviewer-1 found nothing\n" });
    expect(readFileSync(join(feature, "run", "review", "findings.md"), "utf8")).toContain("## No findings · reviewer-1");
    // A chat on a folder has no worktree, so it has no check and no loop.
    const check = runAs(AS, "check", "T001");
    expect(check.code).toBe(1);
    expect(check.err).toContain("has no worktree");
    expect(runAs({ ...AS, STARSHIP_AGENT: "orchestrator" }, "task", "retry", "T001")).toMatchObject({ code: 1 });
    expect(runAs(AS, "agent", "pause", "work", "worker-a")).toMatchObject({ code: 1, err: 'Chat "work" has no agent "worker-a"\n' });
  }, 20000);

  test("C14: chat new with --feature adopts a feature on the base branch; one that is not there makes no chat", () => {
    const repo = gitRepo(["v1-repos"]);
    expect(run("repo", "add", repo, "--name", "demo").code).toBe(0);
    expect(run("chat", "new", "--title", "Adopt", "--repo", "demo", "--feature", "v1-repos")).toMatchObject({ code: 0, out: "adopt\n" });
    expect(run("chat", "list").out).toContain("adopt\tplan\tAdopt\n");
    expect(readFileSync(join(home, "worktrees", "demo", "v1-repos", "docs", "features", "v1-repos", "PLAN.md"), "utf8")).toBe("# Plan\n");
    const ghost = run("chat", "new", "--title", "Ghost", "--repo", "demo", "--feature", "ghost");
    expect(ghost.code).toBe(1);
    expect(ghost.err).toContain("ghost");
    expect(run("chat", "list").out).not.toContain("ghost");
    expect(run("chat", "new", "--title", "No repo", "--feature", "x").code).toBe(1);
  });
});

describe("cli: a daemon on the fake agent", () => {
  const FAKE = join(repoRoot, "engine", "test", "fake-agent.ts");
  const prefixes: string[] = [];
  afterEach(() => {
    // The daemon is killed by the file's own afterEach, which may run later: end it first, so it starts no session again.
    for (const p of procs) p.kill("SIGKILL");
    for (const prefix of prefixes.splice(0)) for (const n of list(prefix)) kill(n);
  });

  test("config bins, STARSHIP_TMUX_PREFIX and the FAKE_ variables: a message to the admin agent gets the fake's reply", async () => {
    const prefix = `sst-${Math.random().toString(36).slice(2, 10)}-`;
    prefixes.push(prefix);
    const fakeDir = tempDir("starship-fake-sessions-");
    dirs.push(fakeDir);
    writeFileSync(join(home, "config.json"), JSON.stringify({ bins: { claude: [process.execPath, FAKE, "--as", "claude"], codex: [process.execPath, FAKE, "--as", "codex"] } }));
    // FAKE_SESSIONS_DIR is what the fake agent needs: it only starts when the daemon passes FAKE_* on to the agent.
    const p = Bun.spawn(["bun", CLI, "daemon", "--port", String(randomPort())], {
      env: { ...env(), STARSHIP_TMUX_PREFIX: prefix, FAKE_SESSIONS_DIR: fakeDir },
      stdin: "ignore",
      stdout: "pipe",
      stderr: "pipe",
      cwd: repoRoot,
    });
    procs.push(p);
    await firstLine(p);
    const info = await waitFor("engine.json", readEngine);
    const api = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${info.token}`);
      if (init.body) headers.set("content-type", "application/json");
      return fetch(`http://127.0.0.1:${info.port}${path}`, { ...init, headers });
    };

    const created = (await (await api("/api/chats", { method: "POST", body: JSON.stringify({ title: "Say hi" }) })).json()) as { chat: { id: string } };
    const id = created.chat.id;
    const sent = await api(`/api/chats/${id}/messages`, { method: "POST", body: JSON.stringify({ id: "m1", text: "say hello" }) });
    expect(sent.status).toBe(200);

    type View = { messages: { who: string; text: string }[]; agents: { id: string; tmux: string }[] };
    let state: View | null = null;
    const until = Date.now() + 40_000;
    while (Date.now() < until && !state) {
      const seen = (await (await api(`/api/chats/${id}`)).json()) as View;
      if (seen.messages.some((m) => m.who === "admin" && m.text === "hello")) state = seen;
      else await Bun.sleep(100);
    }
    if (!state) throw new Error(`no reply "hello". stderr: ${await new Response(p.stderr).text().catch(() => "")}`);
    // The admin agent runs in a tmux session with the prefix from the environment, and the program from the config.
    const admin = state.agents.find((a) => a.id === "admin");
    expect(admin?.tmux.startsWith(prefix)).toBe(true);
    expect(list(prefix)).toContain(admin?.tmux ?? "");
  }, 60_000);
});

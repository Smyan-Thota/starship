import { afterAll, afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { capture, hasSession, kill, list, paste } from "../src/agents/tmux.ts";
import { paths } from "../src/config.ts";
import { appendHookEvent } from "../src/hooks.ts";
import { SendError } from "../src/run/ports.ts";
import type { AgentEvent, AgentSpec } from "../src/run/ports.ts";
import { Sessions } from "../src/sessions.ts";
import type { SessionsOptions } from "../src/sessions.ts";
import type { Tool } from "../src/types.ts";
import { drop, fixture, tempDir, tempHome } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fake-agent.ts");
const HOOK_ENTRY = join(import.meta.dir, "..", "src", "hook-entry.ts");
const CHAT = "c1";

const rand = () => Math.random().toString(36).slice(2, 10);
const prefixes: string[] = [];

/** Every tmux session that this file made starts with one of its own random prefixes. Nothing else is touched. */
function killMine(): void {
  for (const p of prefixes) for (const n of list(p)) kill(n);
}

afterAll(() => {
  killMine();
  const left = prefixes.flatMap((p) => list(p));
  expect(left).toEqual([]);
});

async function waitFor(check: () => boolean, limit = 12000): Promise<boolean> {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (check()) return true;
    await Bun.sleep(40);
  }
  return check();
}

interface Rig {
  home: string;
  cwd: string;
  fakeDir: string;
  prefix: string;
  /** The tmux session name of an agent. */
  name: (agent: string, chat?: string) => string;
  spec: (id: string, tool?: Tool) => AgentSpec;
  /** A Sessions object on the fake agent, with its events collected. */
  make: (o?: Partial<SessionsOptions>) => { s: Sessions; events: AgentEvent[] };
  agentFile: (agent: string) => Record<string, unknown>;
}

let rig: Rig;
let home: ReturnType<typeof tempHome>;
const made: Sessions[] = [];
const dirs: string[] = [];

beforeEach(() => {
  home = tempHome();
  const cwd = tempDir("starship-work-");
  const fakeDir = tempDir("starship-fake-sessions-");
  dirs.push(cwd, fakeDir);
  const prefix = `sst-${rand()}-`;
  prefixes.push(prefix);
  rig = {
    home: home.dir,
    cwd,
    fakeDir,
    prefix,
    name: (agent, chat = CHAT) => `${prefix}${chat}-${agent}`,
    spec: (id, tool = "claude") => ({ id, role: "worker", tool, model: "fake-model", cwd, promptFile: null }),
    make: (o = {}) => {
      const s = new Sessions({
        bins: {
          claude: [process.execPath, FAKE, "--as", "claude"],
          codex: [process.execPath, FAKE, "--as", "codex"],
        },
        hookEntry: [process.execPath, HOOK_ENTRY],
        prefix,
        pollMs: 80,
        stallMs: 5000,
        readyMs: 10000,
        codexSessionsDir: join(fakeDir, "sessions"),
        ...o,
        env: { FAKE_SESSIONS_DIR: fakeDir, ...o.env },
      });
      const events: AgentEvent[] = [];
      s.on((e) => events.push(e));
      made.push(s);
      return { s, events };
    },
    agentFile: (agent) => JSON.parse(readFileSync(join(paths.chat(CHAT), "agents", `${agent}.json`), "utf8")) as Record<string, unknown>,
  };
});

afterEach(() => {
  for (const s of made.splice(0)) s.dispose();
  killMine();
  home.restore();
});

afterAll(() => {
  for (const d of dirs) drop(d);
});

const of = <T extends AgentEvent["type"]>(events: AgentEvent[], type: T) => events.filter((e): e is Extract<AgentEvent, { type: T }> => e.type === type);
const sessionId = (agent: string) => rig.agentFile(agent).sessionId as string | null;
const claudeStop = (reply: string, id: string) => JSON.stringify({ ...JSON.parse(readFileSync(fixture("claude", "hook-stop.json"), "utf8")), last_assistant_message: reply, session_id: id });

/** Keys other than Enter and Escape exist only in this test file, to act as the owner would. */
function rawKeys(n: string, ...keys: string[]): void {
  const r = Bun.spawnSync(["tmux", "send-keys", "-t", `=${n}:`, ...keys]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

const T = 40000;

describe("one agent, start to turn end", () => {
  test("ensure, send and the turnEnd event with the reply", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(s.status(CHAT, "worker-a")).toBe("idle");
    expect(hasSession(rig.name("worker-a"))).toBe(true);
    // The settings file has the hooks and the status line command.
    const settings = JSON.parse(readFileSync(join(paths.chat(CHAT), "agents", "worker-a.settings.json"), "utf8")) as {
      hooks: Record<string, { hooks: { command: string }[] }[]>;
      statusLine: { command: string };
    };
    expect(settings.hooks.Stop?.[0]?.hooks[0]?.command).toContain("hook claude");
    expect(settings.statusLine.command).toContain(" status");
    // SessionStart arrives by hook: the agent has started, and the session id is saved.
    expect(await waitFor(() => of(events, "started").length === 1)).toBe(true);
    expect(of(events, "started")[0]).toEqual({ type: "started", chat: CHAT, agent: "worker-a", resumed: false });
    expect(await waitFor(() => sessionId("worker-a") !== null)).toBe(true);
    expect(rig.agentFile("worker-a")).toMatchObject({ id: "worker-a", role: "worker", tool: "claude", model: "fake-model", cwd: rig.cwd, promptFile: null, tmux: rig.name("worker-a") });

    await s.send(CHAT, "worker-a", "say hello");
    expect(s.status(CHAT, "worker-a")).toBe("working");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnStart")[0]).toMatchObject({ prompt: "say hello", fromTerminal: false });
    expect(of(events, "turnEnd")[0]).toEqual({ type: "turnEnd", chat: CHAT, agent: "worker-a", reply: "hello", fromTerminal: false });
    expect(s.status(CHAT, "worker-a")).toBe("idle");
    // The status line command ran after the turn: a usage event follows.
    expect(await waitFor(() => of(events, "usage").length >= 1)).toBe(true);
    const usage = of(events, "usage")[0]?.usage;
    expect(usage?.tool).toBe("claude");
    expect(usage?.windows.find((w) => w.name === "five_hour")?.usedPct).toBe(10);
    // The view.
    expect(s.agents(CHAT)).toEqual([
      { id: "worker-a", name: "worker-a", role: "worker", tool: "claude", model: "fake-model", tmux: rig.name("worker-a"), status: "idle", task: null, prompts: [], history: [] },
    ]);
    expect(s.agents("other")).toEqual([]);
  }, T);

  test("a Codex agent: ready by its screen, turnEnd from notify, session id from the thread, usage from the rollout", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(s.status(CHAT, "worker-b")).toBe("idle");
    expect(of(events, "started")).toEqual([{ type: "started", chat: CHAT, agent: "worker-b", resumed: false }]);
    expect(sessionId("worker-b")).toBeNull();
    await s.send(CHAT, "worker-b", "say hi");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnStart")[0]).toMatchObject({ prompt: "say hi", fromTerminal: false });
    expect(of(events, "turnEnd")[0]).toMatchObject({ reply: "hi", fromTerminal: false });
    expect(typeof sessionId("worker-b")).toBe("string");
    expect(await waitFor(() => of(events, "usage").length >= 1)).toBe(true);
    expect(of(events, "usage")[0]?.usage.tool).toBe("codex");
    expect(s.status(CHAT, "worker-b")).toBe("idle");
  }, T);

  test("text typed in the terminal is marked from terminal, for the turn start and the turn end", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("admin"));
    await s.send(CHAT, "admin", "say mine");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    // The owner types: the test pastes into tmux directly, not through the engine.
    paste(rig.name("admin"), "say theirs");
    expect(await waitFor(() => of(events, "turnEnd").length === 2)).toBe(true);
    expect(of(events, "turnStart").map((e) => [e.prompt, e.fromTerminal])).toEqual([
      ["say mine", false],
      ["say theirs", true],
    ]);
    expect(of(events, "turnEnd").map((e) => [e.reply, e.fromTerminal])).toEqual([
      ["mine", false],
      ["theirs", true],
    ]);
  }, T);

  test("a permission: needsYou with reason permission, and the status leaves needsYou when the owner answers", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "permission");
    expect(await waitFor(() => of(events, "needsYou").length === 1)).toBe(true);
    expect(of(events, "needsYou")[0]).toMatchObject({ chat: CHAT, agent: "worker-a", reason: "permission" });
    expect(s.status(CHAT, "worker-a")).toBe("needsYou");
    // The owner answers in the terminal.
    paste(rig.name("worker-a"), "y");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")[0]?.reply).toBe("done");
    expect(s.status(CHAT, "worker-a")).toBe("idle");
  }, T);

  test("send refuses a text with a line break, an unknown agent and a stopped agent; interrupt sends Escape; stop ends the session", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await expect(s.send(CHAT, "worker-a", "one\ntwo")).rejects.toBeInstanceOf(SendError);
    await expect(s.send(CHAT, "nobody", "x")).rejects.toBeInstanceOf(SendError);
    await s.send(CHAT, "worker-a", "slow 20000 x");
    expect(await waitFor(() => of(events, "turnStart").length === 1)).toBe(true);
    await Bun.sleep(200);
    await s.interrupt(CHAT, "worker-a");
    expect(await waitFor(() => capture(rig.name("worker-a")).includes("Interrupted"))).toBe(true);
    expect(of(events, "turnEnd")).toEqual([]);
    await s.stop(CHAT, "worker-a");
    expect(s.status(CHAT, "worker-a")).toBe("stopped");
    expect(hasSession(rig.name("worker-a"))).toBe(false);
    await expect(s.send(CHAT, "worker-a", "x")).rejects.toBeInstanceOf(SendError);
    // A stop is not a crash: no restart follows.
    await Bun.sleep(500);
    expect(hasSession(rig.name("worker-a"))).toBe(false);
    expect(s.status(CHAT, "worker-a")).toBe("stopped");
    // mark sets a status the loop decides.
    s.mark(CHAT, "worker-a", "paused");
    expect(s.status(CHAT, "worker-a")).toBe("paused");
    expect(s.status(CHAT, "nobody")).toBeNull();
  }, T);
});

describe("D18 and D15: the event log and the engine's restart", () => {
  test("D18: events logged while no poll loop runs are applied once at start", async () => {
    const { s, events } = rig.make();
    // No start(): the fake's SessionStart hook still ran and logged its line.
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(await waitFor(() => existsSync(join(paths.chat(CHAT), "events.jsonl")))).toBe(true);
    appendHookEvent(CHAT, { agent: "worker-a", tool: "claude", raw: claudeStop("late reply", "s-1") });
    await Bun.sleep(300);
    expect(events.filter((e) => e.type !== "usage")).toEqual([]); // nothing is applied while the loop is not running

    s.start();
    expect(of(events, "started")).toHaveLength(1);
    // A Stop is the end of the turn once the screen is not busy in two polls in a row: not at the moment it is applied.
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")).toEqual([{ type: "turnEnd", chat: CHAT, agent: "worker-a", reply: "late reply", fromTerminal: false }]);
    await Bun.sleep(500);
    expect(of(events, "turnEnd")).toHaveLength(1);
    expect(of(events, "started")).toHaveLength(1);
    s.dispose();

    // A second engine finds nothing left to apply.
    const second = rig.make();
    second.s.start();
    await Bun.sleep(400);
    expect(second.events.filter((e) => e.type !== "usage")).toEqual([]);
  }, T);

  test("D15: a second Sessions object finds the live session, marks the dead one stopped, applies what arrived, and pastes nothing", async () => {
    const first = rig.make();
    first.s.start();
    await first.s.ensure(CHAT, rig.spec("worker-a"));
    await first.s.ensure(CHAT, rig.spec("worker-b"));
    await first.s.send(CHAT, "worker-a", "say one");
    expect(await waitFor(() => of(first.events, "turnEnd").length === 1)).toBe(true);
    expect(await waitFor(() => sessionId("worker-a") !== null)).toBe(true);
    const id = sessionId("worker-a") ?? "";
    // The engine goes down. The Mac sleeps: one session dies, and one hook fires.
    first.s.dispose();
    kill(rig.name("worker-b"));
    appendHookEvent(CHAT, { agent: "worker-a", tool: "claude", raw: claudeStop("while asleep", id) });
    const prompts = () => readFileSync(join(paths.chat(CHAT), "events.jsonl"), "utf8").split("\n").filter((l) => l.includes("UserPromptSubmit")).length;
    const promptsBefore = prompts();
    expect(promptsBefore).toBe(1);

    const second = rig.make();
    expect(second.s.agents(CHAT)).toEqual([]);
    expect(second.s.rebuild()).toEqual({ kept: 1, stopped: 1 });
    expect(second.s.status(CHAT, "worker-a")).toBe("idle");
    expect(second.s.status(CHAT, "worker-b")).toBe("stopped");
    expect(second.s.agents(CHAT).map((a) => [a.id, a.status])).toEqual([
      ["worker-a", "idle"],
      ["worker-b", "stopped"],
    ]);
    // The Stop that arrived meanwhile waits for two calm polls: the turn ends once the poll loop runs.
    expect(of(second.events, "turnEnd")).toEqual([]);

    // Nothing was pasted: the agent saw no new prompt, and the screen shows only the first turn.
    second.s.start();
    expect(await waitFor(() => of(second.events, "turnEnd").length === 1)).toBe(true);
    expect(of(second.events, "turnEnd")).toEqual([{ type: "turnEnd", chat: CHAT, agent: "worker-a", reply: "while asleep", fromTerminal: false }]);
    await Bun.sleep(500);
    expect(prompts()).toBe(promptsBefore);
    expect(of(second.events, "turnEnd")).toHaveLength(1);
    expect(capture(rig.name("worker-a")).match(/❯ say /g)).toHaveLength(1);
    // The dead agent is not restarted by the rebuild.
    expect(hasSession(rig.name("worker-b"))).toBe(false);
    // The live one still takes text through the new object.
    await second.s.send(CHAT, "worker-a", "say two");
    expect(await waitFor(() => of(second.events, "turnEnd").length === 2)).toBe(true);
    expect(of(second.events, "turnEnd")[1]?.reply).toBe("two");
  }, T);
});

describe("D1, D5, D2: an agent that ends, and an agent that goes quiet", () => {
  /** Runs the end twice: the first end gives one automatic restart, the second stays stopped. */
  async function endsTwice(how: (name: string, s: Sessions) => Promise<void>): Promise<{ s: Sessions; events: AgentEvent[] }> {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(await waitFor(() => sessionId("worker-a") !== null)).toBe(true);
    const id = sessionId("worker-a");

    await how(rig.name("worker-a"), s);
    expect(await waitFor(() => of(events, "ended").length === 1)).toBe(true);
    // One automatic restart: with the tool's own resume, so the session id stays the same.
    expect(await waitFor(() => of(events, "started").length === 2)).toBe(true);
    expect(of(events, "started")[1]).toEqual({ type: "started", chat: CHAT, agent: "worker-a", resumed: true });
    expect(await waitFor(() => s.status(CHAT, "worker-a") === "idle")).toBe(true);
    expect(hasSession(rig.name("worker-a"))).toBe(true);
    expect(sessionId("worker-a")).toBe(id);
    expect(of(events, "needsYou")).toEqual([]);

    // It ends again before a turn of it ended: it stays stopped and the owner is told.
    await how(rig.name("worker-a"), s);
    expect(await waitFor(() => of(events, "needsYou").length === 1)).toBe(true);
    expect(of(events, "needsYou")[0]).toMatchObject({ chat: CHAT, agent: "worker-a", reason: "other" });
    expect(of(events, "ended")).toHaveLength(2);
    expect(s.status(CHAT, "worker-a")).toBe("stopped");
    await Bun.sleep(600);
    expect(hasSession(rig.name("worker-a"))).toBe(false);
    expect(s.status(CHAT, "worker-a")).toBe("stopped");
    expect(of(events, "started")).toHaveLength(2);
    return { s, events };
  }

  test("D1: an agent's process ends: ended, stopped, one automatic restart, then stopped for good", async () => {
    await endsTwice(async (_name, s) => {
      await s.send(CHAT, "worker-a", "crash");
    });
  }, T);

  test("D1: a turn that ended earns the agent a new automatic restart", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "say first");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    await s.send(CHAT, "worker-a", "crash");
    expect(await waitFor(() => of(events, "started").length === 2 && s.status(CHAT, "worker-a") === "idle")).toBe(true);
    // A turn ends after the restart, so the next end gets a restart again.
    await s.send(CHAT, "worker-a", "say second");
    expect(await waitFor(() => of(events, "turnEnd").length === 2)).toBe(true);
    await s.send(CHAT, "worker-a", "crash");
    expect(await waitFor(() => of(events, "started").length === 3 && s.status(CHAT, "worker-a") === "idle")).toBe(true);
    expect(of(events, "needsYou")).toEqual([]);
  }, T);

  test("D5: the owner kills the tmux session: the same as D1", async () => {
    await endsTwice(async (name) => {
      kill(name);
    });
  }, T);

  test("D2: no hook and no screen change while working: stalled, and a screen change gives signal", async () => {
    const { s, events } = rig.make({ stallMs: 700 });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await Bun.sleep(300);
    expect(s.status(CHAT, "worker-a")).toBe("idle"); // an idle agent never stalls
    expect(of(events, "stalled")).toEqual([]);

    await s.send(CHAT, "worker-a", "stall");
    expect(await waitFor(() => of(events, "stalled").length === 1)).toBe(true);
    expect(of(events, "stalled")[0]).toEqual({ type: "stalled", chat: CHAT, agent: "worker-a", reason: "quiet" });
    expect(s.status(CHAT, "worker-a")).toBe("stalled");
    expect(of(events, "signal")).toEqual([]);

    // The owner types in the terminal: the screen changes, so the agent is working again.
    paste(rig.name("worker-a"), "poke");
    expect(await waitFor(() => of(events, "signal").length === 1)).toBe(true);
    expect(of(events, "signal")[0]).toEqual({ type: "signal", chat: CHAT, agent: "worker-a" });
    expect(await waitFor(() => s.status(CHAT, "worker-a") === "working")).toBe(true);
  }, T);

  test("D2: a hook event also ends a stall", async () => {
    const { s, events } = rig.make({ stallMs: 700 });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "stall");
    expect(await waitFor(() => s.status(CHAT, "worker-a") === "stalled")).toBe(true);
    appendHookEvent(CHAT, { agent: "worker-a", tool: "claude", raw: JSON.stringify({ hook_event_name: "PreToolUse", session_id: "s", tool_name: "Bash", tool_input: {} }) });
    expect(await waitFor(() => of(events, "signal").length === 1)).toBe(true);
  }, T);

  test("a usage limit message on the screen gives stalled with reason limit, once", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "say usage limit reached, resets at 5pm");
    expect(await waitFor(() => of(events, "stalled").length === 1)).toBe(true);
    expect(of(events, "stalled")[0]).toMatchObject({ reason: "limit" });
    await Bun.sleep(400);
    expect(of(events, "stalled")).toHaveLength(1);
  }, T);
});

describe("the Codex sandbox flags", () => {
  /** A Codex that writes its own argv to a file, and then runs the fake agent with the same argv. */
  const recording = (out: string) => ({
    bins: {
      claude: [process.execPath, FAKE, "--as", "claude"],
      codex: ["sh", "-c", 'printf "%s\\n" "$@" > "$ARGV_OUT"; exec "$0" "$@"', process.execPath, FAKE, "--as", "codex"],
    },
    env: { ARGV_OUT: out },
  });
  const argvOf = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((x) => x !== "");

  test("every Codex agent starts with codexArgs, after the other flags, and the fake agent still starts", async () => {
    const out = join(rig.cwd, "argv.txt");
    const { s, events } = rig.make({ ...recording(out), codexArgs: ["-s", "workspace-write", "-a", "never"] });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(s.status(CHAT, "worker-b")).toBe("idle");
    const argv = argvOf(out);
    // The flags are in the argv, in order, as two pairs.
    const at = argv.indexOf("-s");
    expect(argv.slice(at, at + 4)).toEqual(["-s", "workspace-write", "-a", "never"]);
    expect(argv).toContain("-C");
    expect(argv.some((a) => a.startsWith("notify="))).toBe(true);
    // The fake skips flags it does not know, with their values: a turn still runs.
    await s.send(CHAT, "worker-b", "say hi");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")[0]).toMatchObject({ reply: "hi" });
  }, T);

  test("an empty codexArgs, and no codexArgs, give none of the flags; a Claude Code agent never gets them", async () => {
    for (const o of [{ codexArgs: [] }, {}]) {
      const out = join(rig.cwd, `argv-${JSON.stringify(o)}.txt`);
      const { s } = rig.make({ ...recording(out), ...o });
      s.start();
      await s.ensure(CHAT, rig.spec("worker-b", "codex"));
      const argv = argvOf(out);
      expect(argv).not.toContain("-s");
      expect(argv).not.toContain("-a");
      expect(argv).not.toContain("workspace-write");
      await s.stop(CHAT, "worker-b");
    }
    const claudeOut = join(rig.cwd, "claude-argv.txt");
    const { s } = rig.make({
      bins: { claude: ["sh", "-c", 'printf "%s\\n" "$@" > "$ARGV_OUT"; exec "$0" "$@"', process.execPath, FAKE, "--as", "claude"], codex: [process.execPath, FAKE, "--as", "codex"] },
      env: { ARGV_OUT: claudeOut },
      codexArgs: ["-s", "workspace-write", "-a", "never"],
    });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(argvOf(claudeOut)).not.toContain("workspace-write");
  }, T);
});

describe("the stall limit", () => {
  test("stallLimitMs is the option, and 10 minutes when none is given", () => {
    expect(rig.make({ stallMs: 7000 }).s.stallLimitMs).toBe(7000);
    const bare = new Sessions({ bins: { claude: ["x"], codex: ["x"] }, hookEntry: ["x"], prefix: rig.prefix });
    expect(bare.stallLimitMs).toBe(600_000);
  });
});

describe("D13: a tool that does not start", () => {
  const failing = (script: string) => ({ bins: { claude: ["sh", "-c", script, "tool"], codex: ["sh", "-c", script, "tool"] } });

  test("D13: the tool exits at once: stopped, with the tool's own text, and ensure throws", async () => {
    const { s, events } = rig.make(failing("echo 'error: unknown model nope'; exit 3"));
    await expect(s.ensure(CHAT, rig.spec("worker-a"))).rejects.toThrow(/unknown model nope/);
    expect(s.status(CHAT, "worker-a")).toBe("stopped");
    expect(s.error(CHAT, "worker-a")).toContain("error: unknown model nope");
    expect(s.error(CHAT, "worker-a")).not.toContain("[starship]");
    expect(rig.agentFile("worker-a")).toMatchObject({ status: "stopped", error: expect.stringContaining("unknown model nope") });
    expect(of(events, "ended")).toHaveLength(1);
    expect(list(rig.prefix)).toEqual([]);
  }, T);

  test("D13: a tool that never gets ready is ended after readyMs: stopped, with its last screen", async () => {
    const { s } = rig.make({ ...failing("echo booting; sleep 30"), readyMs: 600 });
    await expect(s.ensure(CHAT, rig.spec("worker-a", "codex"))).rejects.toThrow(/booting/);
    expect(s.status(CHAT, "worker-a")).toBe("stopped");
    expect(s.error(CHAT, "worker-a")).toContain("booting");
    expect(list(rig.prefix)).toEqual([]);
  }, T);

  test("D13: a work folder that does not exist: stopped, and ensure throws", async () => {
    const { s } = rig.make();
    await expect(s.ensure(CHAT, { ...rig.spec("worker-a"), cwd: join(rig.cwd, "missing") })).rejects.toThrow(/cwd/);
    expect(s.status(CHAT, "worker-a")).toBe("stopped");
    expect(s.error(CHAT, "worker-a")).toContain("cwd");
  }, T);
});

describe("start screens", () => {
  test("the trust screen: needsYou with reason trust, nothing is sent, and the session lives until the owner answers", async () => {
    const { s, events } = rig.make({ env: { FAKE_SCREEN: "trust" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(s.status(CHAT, "worker-a")).toBe("needsYou");
    expect(of(events, "needsYou")).toHaveLength(1);
    expect(of(events, "needsYou")[0]).toMatchObject({ chat: CHAT, agent: "worker-a", reason: "trust" });
    // The default answer is "No, exit". Any Enter would end the session. A few polls later it still waits.
    await Bun.sleep(600);
    expect(hasSession(rig.name("worker-a"))).toBe(true);
    const screen = capture(rig.name("worker-a"));
    expect(screen).toContain("No, exit");
    expect(screen).not.toContain("EXIT");
    expect(screen).not.toContain("[starship]");
    expect(s.status(CHAT, "worker-a")).toBe("needsYou");
    // The engine refuses to paste into it.
    await expect(s.send(CHAT, "worker-a", "say hi")).rejects.toBeInstanceOf(SendError);
    expect(capture(rig.name("worker-a"))).not.toContain("say hi");

    // The owner answers yes in the terminal: Down, then Enter. The agent is ready.
    rawKeys(rig.name("worker-a"), "Down");
    rawKeys(rig.name("worker-a"), "Enter");
    expect(await waitFor(() => s.status(CHAT, "worker-a") === "idle")).toBe(true);
    await s.send(CHAT, "worker-a", "say hi");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")[0]?.reply).toBe("hi");
  }, T);

  test("the Codex update screen: Escape is sent, never Enter, and the agent gets ready", async () => {
    const { s, events } = rig.make({ env: { FAKE_SCREEN: "update" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(s.status(CHAT, "worker-b")).toBe("idle");
    const screen = capture(rig.name("worker-b"));
    expect(screen).not.toContain("Update available");
    expect(screen).not.toContain("INSTALLER"); // Enter on the update question would run the installer
    expect(screen).not.toContain("[starship]");
    expect(hasSession(rig.name("worker-b"))).toBe(true);
    expect(of(events, "needsYou")).toEqual([]);
    await s.send(CHAT, "worker-b", "say ok");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")[0]?.reply).toBe("ok");
  }, T);
});

describe("Codex's trust question", () => {
  test("needsYou with reason trust, nothing is sent, ensure resolves; the owner's Enter makes the agent idle and `started` goes out", async () => {
    const { s, events } = rig.make({ env: { FAKE_SCREEN: "trust" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(s.status(CHAT, "worker-b")).toBe("needsYou");
    expect(s.need(CHAT, "worker-b")).toBe("trust");
    expect(of(events, "needsYou")).toHaveLength(1);
    expect(of(events, "needsYou")[0]).toMatchObject({ chat: CHAT, agent: "worker-b", reason: "trust" });
    expect(of(events, "started")).toEqual([]);
    // Escape quits Codex on this screen and Enter trusts the folder: the engine sends neither. A few polls later it still waits.
    await Bun.sleep(600);
    expect(hasSession(rig.name("worker-b"))).toBe(true);
    const screen = capture(rig.name("worker-b"));
    expect(screen).toContain("Trust this folder?");
    expect(screen).not.toContain("[starship]");
    expect(s.status(CHAT, "worker-b")).toBe("needsYou");
    await expect(s.send(CHAT, "worker-b", "say hi")).rejects.toBeInstanceOf(SendError);
    expect(capture(rig.name("worker-b"))).not.toContain("say hi");

    // The owner trusts the folder in the terminal. Then the agent is ready, with no other action.
    rawKeys(rig.name("worker-b"), "Enter");
    expect(await waitFor(() => s.status(CHAT, "worker-b") === "idle")).toBe(true);
    expect(s.need(CHAT, "worker-b")).toBeNull();
    expect(of(events, "started")).toEqual([{ type: "started", chat: CHAT, agent: "worker-b", resumed: false }]);
    await s.send(CHAT, "worker-b", "say hi");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")[0]?.reply).toBe("hi");
  }, T);

  test("Claude Code's trust question: the owner's answer gives idle and exactly one `started`, also when the hook comes too", async () => {
    const { s, events } = rig.make({ env: { FAKE_SCREEN: "trust" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(s.need(CHAT, "worker-a")).toBe("trust");
    rawKeys(rig.name("worker-a"), "Down");
    rawKeys(rig.name("worker-a"), "Enter");
    expect(await waitFor(() => s.status(CHAT, "worker-a") === "idle")).toBe(true);
    expect(await waitFor(() => of(events, "started").length >= 1)).toBe(true);
    await Bun.sleep(600); // the SessionStart hook of the fake has run by now
    expect(of(events, "started")).toHaveLength(1);
    expect(s.need(CHAT, "worker-a")).toBeNull();
  }, T);
});

describe("interrupt at a trust question", () => {
  for (const tool of ["codex", "claude"] as const) {
    test(`${tool}: interrupt (Pause, Halt) sends no Escape, because Escape leaves the ${tool} trust question`, async () => {
      const { s, events } = rig.make({ env: { FAKE_SCREEN: "trust" } });
      s.start();
      const id = tool === "codex" ? "worker-b" : "worker-a";
      await s.ensure(CHAT, rig.spec(id, tool));
      expect(s.need(CHAT, id)).toBe("trust");
      await s.interrupt(CHAT, id);
      await Bun.sleep(500);
      expect(hasSession(rig.name(id))).toBe(true);
      expect(capture(rig.name(id))).toMatch(/Trust this folder\?|Yes, I trust this folder/);
      expect(capture(rig.name(id))).not.toContain("[starship]");
      expect(s.status(CHAT, id)).toBe("needsYou");
      expect(of(events, "ended")).toEqual([]); // the tool did not quit and start again
    }, T);
  }
});

describe("why an agent needs you", () => {
  test("need() is permission for a permission prompt, and null when the agent does not wait", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(s.need(CHAT, "worker-a")).toBeNull();
    expect(s.need(CHAT, "nobody")).toBeNull();
    await s.send(CHAT, "worker-a", "permission");
    expect(await waitFor(() => s.status(CHAT, "worker-a") === "needsYou")).toBe(true);
    expect(s.need(CHAT, "worker-a")).toBe("permission");
    paste(rig.name("worker-a"), "y");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(s.need(CHAT, "worker-a")).toBeNull();
  }, T);
});

describe("one turn, several Stop events", () => {
  const stops = () =>
    readFileSync(join(paths.chat(CHAT), "events.jsonl"), "utf8")
      .split("\n")
      .filter((l) => l.includes("hook_event_name") && l.includes("Stop")).length;

  test("a blocking Stop hook: the agent stays working, and ONE turnEnd goes out, with every reply of the turn in order", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "block 2500 the final reply");
    expect(await waitFor(() => stops() >= 1)).toBe(true);
    // The first Stop has arrived, and the screen still shows the busy line: the turn goes on.
    await Bun.sleep(600);
    expect(stops()).toBe(1);
    expect(s.status(CHAT, "worker-a")).toBe("working");
    expect(of(events, "turnEnd")).toEqual([]);
    expect(capture(rig.name("worker-a"))).toContain("running Stop hooks");

    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(stops()).toBe(2);
    expect(of(events, "turnEnd")[0]).toEqual({ type: "turnEnd", chat: CHAT, agent: "worker-a", reply: "first\n\nthe final reply", fromTerminal: false });
    expect(s.status(CHAT, "worker-a")).toBe("idle");
    await Bun.sleep(600);
    expect(of(events, "turnEnd")).toHaveLength(1);
    // The agent takes the next line as before.
    await s.send(CHAT, "worker-a", "say after");
    expect(await waitFor(() => of(events, "turnEnd").length === 2)).toBe(true);
    expect(of(events, "turnEnd")[1]?.reply).toBe("after");
  }, T);

  test("the replies of one turn: a reply that repeats the one before it, and an empty one, are dropped; Stops of another prompt are another turn", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(await waitFor(() => existsSync(join(paths.chat(CHAT), "events.jsonl")))).toBe(true);
    const stop = (reply: string, promptId: string) => JSON.stringify({ ...JSON.parse(claudeStop(reply, "s-1")), prompt_id: promptId });
    for (const [reply, id] of [["one", "p1"], ["one", "p1"], ["", "p1"], ["two", "p1"], ["three", "p2"]] as const) {
      appendHookEvent(CHAT, { agent: "worker-a", tool: "claude", raw: stop(reply, id) });
    }
    expect(await waitFor(() => of(events, "turnEnd").length === 2)).toBe(true);
    expect(of(events, "turnEnd").map((e) => e.reply)).toEqual(["one\n\ntwo", "three"]);
  }, T);

  test("Escape in the middle of a turn that had a Stop: the turn does not end, and the reply of the turn after Resume joins it", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "block 6000 never");
    expect(await waitFor(() => stops() >= 1)).toBe(true);
    await s.interrupt(CHAT, "worker-a");
    s.mark(CHAT, "worker-a", "paused");
    await Bun.sleep(800); // more than the two calm polls: a paused agent's turn does not end by itself
    expect(of(events, "turnEnd")).toEqual([]);
    s.mark(CHAT, "worker-a", "idle");
    await s.send(CHAT, "worker-a", "say after the pause");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")[0]?.reply).toBe("first\n\nafter the pause");
    await Bun.sleep(500);
    expect(of(events, "turnEnd")).toHaveLength(1);
  }, T);

  test("after Escape the tool may keep the cut line in its input box: the pasted line joins it, and the turn is still the engine's, not the owner's", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "slow 6000 the story");
    await s.interrupt(CHAT, "worker-a");
    s.mark(CHAT, "worker-a", "paused");
    await Bun.sleep(300);
    s.mark(CHAT, "worker-a", "idle");
    // What the tool would take: the cut line and "continue" in one prompt. Pasted by hand, as the tool's own input box would join them.
    paste(rig.name("worker-a"), "slow 6000 the story continue");
    expect(await waitFor(() => of(events, "turnStart").length === 2)).toBe(true);
    expect(of(events, "turnStart").map((e) => [e.prompt, e.fromTerminal])).toEqual([
      ["slow 6000 the story", false],
      ["slow 6000 the story continue", false],
    ]);
    await s.interrupt(CHAT, "worker-a"); // end the long turn: this test is about the start only
  }, T);

  test("a plain turn still ends promptly", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    const t0 = Date.now();
    await s.send(CHAT, "worker-a", "say x");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")[0]?.reply).toBe("x");
    expect(Date.now() - t0).toBeLessThan(4000);
    expect(s.status(CHAT, "worker-a")).toBe("idle");
  }, T);

  test("a turn typed in the terminal ends the same way, marked from terminal", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    paste(rig.name("worker-a"), "block 1200 theirs");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(of(events, "turnEnd")[0]).toMatchObject({ reply: "first\n\ntheirs", fromTerminal: true });
    await Bun.sleep(400);
    expect(of(events, "turnEnd")).toHaveLength(1);
  }, T);
});

describe("a dialog over the prompt", () => {
  test("Escape goes first, and the next message is delivered; Enter is never sent to the dialog", async () => {
    const { s, events } = rig.make({ env: { FAKE_SCREEN: "dialog" } });
    s.start();
    await s.ensure(CHAT, rig.spec("admin"));
    await s.send(CHAT, "admin", "say one");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(await waitFor(() => capture(rig.name("admin")).includes("Teach auto mode"))).toBe(true);

    await s.send(CHAT, "admin", "say two");
    expect(await waitFor(() => of(events, "turnEnd").length === 2)).toBe(true);
    expect(of(events, "turnEnd")[1]?.reply).toBe("two");
    expect(capture(rig.name("admin"))).not.toContain("DIALOG: confirmed");
    expect(capture(rig.name("admin"))).not.toContain("Teach auto mode");
    expect(of(events, "needsYou")).toEqual([]);
  }, T);

  test("a dialog that Escape does not close: SendError, needsYou with reason other, nothing sent; it goes on when the dialog is gone", async () => {
    const { s, events } = rig.make({ env: { FAKE_SCREEN: "dialog", FAKE_DIALOG_STICKY: "1" } });
    s.start();
    await s.ensure(CHAT, rig.spec("admin"));
    await s.send(CHAT, "admin", "say one");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(await waitFor(() => capture(rig.name("admin")).includes("Teach auto mode"))).toBe(true);

    await expect(s.send(CHAT, "admin", "say two")).rejects.toBeInstanceOf(SendError);
    expect(s.status(CHAT, "admin")).toBe("needsYou");
    expect(s.need(CHAT, "admin")).toBe("other");
    expect(of(events, "needsYou")).toHaveLength(1);
    expect(of(events, "needsYou")[0]).toMatchObject({ chat: CHAT, agent: "admin", reason: "other" });
    const screen = capture(rig.name("admin"));
    expect(screen).not.toContain("say two");
    expect(screen).not.toContain("DIALOG: confirmed");

    // A second try does not repeat the event.
    await expect(s.send(CHAT, "admin", "say three")).rejects.toBeInstanceOf(SendError);
    expect(of(events, "needsYou")).toHaveLength(1);

    // The owner closes the dialog. The agent is idle again, and the engine is told.
    rawKeys(rig.name("admin"), "n");
    expect(await waitFor(() => s.status(CHAT, "admin") === "idle")).toBe(true);
    expect(s.need(CHAT, "admin")).toBeNull();
    expect(of(events, "signal")).toEqual([{ type: "signal", chat: CHAT, agent: "admin" }]);
    await s.send(CHAT, "admin", "say four");
    expect(await waitFor(() => of(events, "turnEnd").length === 2)).toBe(true);
    expect(of(events, "turnEnd")[1]?.reply).toBe("four");
  }, T);
});

describe("claudeArgs", () => {
  const recording = (out: string) => ({
    bins: {
      claude: ["sh", "-c", 'printf "%s\\n" "$@" > "$ARGV_OUT"; exec "$0" "$@"', process.execPath, FAKE, "--as", "claude"],
      codex: ["sh", "-c", 'printf "%s\\n" "$@" > "$ARGV_OUT"; exec "$0" "$@"', process.execPath, FAKE, "--as", "codex"],
    },
    env: { ARGV_OUT: out },
  });
  const argvOf = (file: string): string[] => readFileSync(file, "utf8").split("\n").filter((x) => x !== "");

  test("every Claude Code agent starts with claudeArgs; a Codex agent never gets them", async () => {
    const out = join(rig.cwd, "claude-args.txt");
    const { s } = rig.make({ ...recording(out), claudeArgs: ["--setting-sources", "project,local"] });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    const argv = argvOf(out);
    const at = argv.indexOf("--setting-sources");
    expect(at).toBeGreaterThan(0);
    expect(argv[at + 1]).toBe("project,local");
    expect(argv).toContain("--settings"); // the engine's own flags are still there
    await s.stop(CHAT, "worker-a");

    const codexOut = join(rig.cwd, "codex-args.txt");
    const second = rig.make({ ...recording(codexOut), claudeArgs: ["--setting-sources", "project,local"] });
    second.s.start();
    await second.s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(argvOf(codexOut)).not.toContain("--setting-sources");
  }, T);

  test("no claudeArgs: none of them", async () => {
    const out = join(rig.cwd, "claude-none.txt");
    const { s } = rig.make(recording(out));
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(argvOf(out)).not.toContain("--setting-sources");
  }, T);
});

describe("a dialog at the start", () => {
  test("needsYou with reason other, nothing is sent, ensure resolves, and the session is not ended after readyMs", async () => {
    const dialog = join(import.meta.dir, "..", "..", "fixtures", "claude", "screens", "dialog.txt");
    const { s, events } = rig.make({ bins: { claude: ["sh", "-c", `cat ${dialog}; sleep 30`, "tool"], codex: ["sh", "-c", "sleep 30", "tool"] }, readyMs: 700 });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(s.status(CHAT, "worker-a")).toBe("needsYou");
    expect(s.need(CHAT, "worker-a")).toBe("other");
    expect(of(events, "needsYou")).toHaveLength(1);
    expect(of(events, "needsYou")[0]).toMatchObject({ chat: CHAT, agent: "worker-a", reason: "other" });
    await Bun.sleep(1200); // longer than readyMs
    expect(hasSession(rig.name("worker-a"))).toBe(true);
    expect(s.status(CHAT, "worker-a")).toBe("needsYou");
    expect(capture(rig.name("worker-a"))).toContain("Enter to confirm");
    expect(capture(rig.name("worker-a"))).not.toContain("[starship]");
  }, T);
});

describe("restart", () => {
  test("restart with resume keeps the session id; a change of tool starts a new session; a model change keeps the resume", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(await waitFor(() => sessionId("worker-a") !== null)).toBe(true);
    const id = sessionId("worker-a");

    expect(await s.restart(CHAT, "worker-a")).toEqual({ resumed: true });
    expect(s.status(CHAT, "worker-a")).toBe("idle");
    expect(await waitFor(() => of(events, "started").length === 2)).toBe(true);
    expect(of(events, "started")[1]).toMatchObject({ resumed: true });
    expect(sessionId("worker-a")).toBe(id);
    // The restarted session answers.
    await s.send(CHAT, "worker-a", "say again");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);

    expect(await s.restart(CHAT, "worker-a", { model: "other-model" })).toEqual({ resumed: true });
    expect(s.agents(CHAT)[0]?.model).toBe("other-model");
    expect(sessionId("worker-a")).toBe(id);

    // A change of tool: a new session, for Codex.
    expect(await s.restart(CHAT, "worker-a", { tool: "codex" })).toEqual({ resumed: false });
    expect(s.agents(CHAT)[0]?.tool).toBe("codex");
    expect(rig.agentFile("worker-a")).toMatchObject({ tool: "codex", sessionId: null });
    expect(s.status(CHAT, "worker-a")).toBe("idle");
  }, T);

  test("restart of a Codex agent: a new session before its first turn, the tool's own resume after it", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(await s.restart(CHAT, "worker-b")).toEqual({ resumed: false }); // no session id yet
    await s.send(CHAT, "worker-b", "say one");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    const id = sessionId("worker-b");
    expect(typeof id).toBe("string");
    expect(await s.restart(CHAT, "worker-b")).toEqual({ resumed: true });
    expect(sessionId("worker-b")).toBe(id);
    await s.send(CHAT, "worker-b", "say two");
    expect(await waitFor(() => of(events, "turnEnd").length === 2)).toBe(true);
    expect(sessionId("worker-b")).toBe(id);
    // One rollout file: the resume wrote to the same file.
    const files: string[] = [];
    const walk = (dir: string) => {
      for (const e of readdirSync(dir, { withFileTypes: true })) {
        if (e.isDirectory()) walk(join(dir, e.name));
        else files.push(e.name);
      }
    };
    walk(join(rig.fakeDir, "sessions"));
    expect(files.filter((f) => f.startsWith("rollout-"))).toHaveLength(2); // before the first turn the restart made a first file, then a new session with its own id
  }, T);

  test("a late hook line of the tool that the agent had before a change of tool changes nothing", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(await s.restart(CHAT, "worker-a", { tool: "codex" })).toEqual({ resumed: false });
    appendHookEvent(CHAT, { agent: "worker-a", tool: "claude", raw: claudeStop("late reply", "old-session") });
    await Bun.sleep(500);
    expect(sessionId("worker-a")).toBeNull();
    expect(of(events, "turnEnd")).toEqual([]);
    expect(s.status(CHAT, "worker-a")).toBe("idle");
  }, T);

  test("restart of an unknown agent throws", async () => {
    const { s } = rig.make();
    await expect(s.restart(CHAT, "nobody")).rejects.toThrow(/no agent/);
  });
});

describe("G6: the context use of an agent", () => {
  const statusFile = (agent: string) => join(paths.chat(CHAT), "agents", `${agent}.status.json`);

  test("a Claude Code agent: from its status line input, after a turn; null before, and for an agent that is not known", async () => {
    const { s, events } = rig.make({ env: { FAKE_CONTEXT_PCT: "90" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(s.contextPct(CHAT, "worker-a")).toBeNull();
    await s.send(CHAT, "worker-a", "say hi");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(await waitFor(() => existsSync(statusFile("worker-a")))).toBe(true);
    expect(s.contextPct(CHAT, "worker-a")).toBe(90);
    expect(s.contextPct(CHAT, "nobody")).toBeNull();
    // The status file is not an agent: a second Sessions object does not rebuild it as one.
    const second = rig.make().s;
    second.rebuild();
    expect(second.agents(CHAT).map((a) => a.id)).toEqual(["worker-a"]);
    // A file that is not JSON gives null, not an error.
    writeFileSync(statusFile("worker-a"), "{ not json");
    expect(s.contextPct(CHAT, "worker-a")).toBeNull();
  }, T);

  test("a Codex agent: from its rollout", async () => {
    const { s, events } = rig.make({ env: { FAKE_CONTEXT_PCT: "70" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(s.contextPct(CHAT, "worker-b")).toBeNull();
    await s.send(CHAT, "worker-b", "say hi");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    const pct = s.contextPct(CHAT, "worker-b");
    expect(pct).not.toBeNull();
    expect(Math.round(pct ?? 0)).toBe(70);
  }, T);

  test("a new conversation forgets the old context use; a restart that resumes keeps it", async () => {
    const { s, events } = rig.make({ env: { FAKE_CONTEXT_PCT: "90" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "say hi");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(await waitFor(() => s.contextPct(CHAT, "worker-a") === 90)).toBe(true);
    expect((await s.restart(CHAT, "worker-a")).resumed).toBe(true);
    expect(s.contextPct(CHAT, "worker-a")).toBe(90);
    expect((await s.restart(CHAT, "worker-a", { tool: "codex" })).resumed).toBe(false);
    expect(s.contextPct(CHAT, "worker-a")).toBeNull();
    expect(existsSync(statusFile("worker-a"))).toBe(false);
  }, T);
});

// ───────────────────────────── ready, and the delivery of a paste ─────────────────────────────

/** The keys that the fake agent got: `<epoch ms>\t<flavor>\t<phase>\t<kind>\t<text>`. */
const fakeInput = () => {
  const f = join(rig.fakeDir, "fake-input.log");
  if (!existsSync(f)) return [];
  return readFileSync(f, "utf8")
    .split("\n")
    .filter((l) => l !== "")
    .map((l) => {
      const [at, flavor, phase, kind, text] = l.split("\t");
      return { at: Number(at), flavor: flavor ?? "", phase: phase ?? "", kind: kind ?? "", text: text ?? "" };
    });
};

/**
 * A tool stand-in that shows one real screen, then, after `delay` seconds, another. The screens are the files of fixtures/, so the
 * adapters classify them as the real ones. Nothing reads the keys: what the engine pastes shows only as terminal echo.
 */
const scripted = (first: string[], second: string[], delay: number): string[] => {
  const file = (parts: string[]) => fixture(...parts);
  return ["sh", "-c", `cat ${file(first)}; sleep ${delay}; printf '\\033[2J\\033[3J\\033[H'; cat ${file(second)}; sleep 30`, "tool"];
};

describe("FLAW 1: ready is the tool's own `ready` screen in two polls in a row, 500 ms apart", () => {
  test("Codex: the update question, a bare prompt, then the trust question: not ready, needsYou with reason trust, and nothing is pasted", async () => {
    const { s, events } = rig.make({ env: { FAKE_SCREEN: "update,trust" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(s.need(CHAT, "worker-b")).toBe("trust");
    expect(s.status(CHAT, "worker-b")).toBe("needsYou");
    expect(of(events, "started")).toEqual([]);
    expect(of(events, "needsYou")).toHaveLength(1);
    expect(of(events, "needsYou")[0]).toMatchObject({ agent: "worker-b", reason: "trust" });
    // The engine refuses to paste into it, and a few polls later it still waits.
    await expect(s.send(CHAT, "worker-b", "say hi")).rejects.toBeInstanceOf(SendError);
    await Bun.sleep(600);
    expect(s.status(CHAT, "worker-b")).toBe("needsYou");
    expect(fakeInput().map((e) => [e.phase, e.kind])).toEqual([["update", "esc"]]); // only the Escape that skips the update question

    // The owner's Enter: the agent is ready, and `started` goes out once.
    rawKeys(rig.name("worker-b"), "Enter");
    expect(await waitFor(() => s.status(CHAT, "worker-b") === "idle")).toBe(true);
    expect(of(events, "started")).toHaveLength(1);
    await s.send(CHAT, "worker-b", "say ok");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
    expect(fakeInput().filter((e) => e.kind === "paste").map((e) => e.text)).toEqual(["say ok"]);
  }, T);

  test("Codex: a real-looking ready screen that lasts 400 ms is not ready either", async () => {
    const { s, events } = rig.make({ env: { FAKE_SCREEN: "update,ready,trust" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    expect(s.need(CHAT, "worker-b")).toBe("trust");
    expect(of(events, "started")).toEqual([]);
    expect(fakeInput().filter((e) => e.kind !== "esc")).toEqual([]);
  }, T);

  test("a screen that stays ready: ensure resolves only after two ready polls, 500 ms apart", async () => {
    const { s } = rig.make({ pollMs: 100 });
    s.start();
    const t0 = Date.now();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    const took = Date.now() - t0;
    expect(s.status(CHAT, "worker-b")).toBe("idle");
    // The fake needs time to start too: the first ready screen shows after t0, so the second poll is more than 500 ms after t0.
    expect(took).toBeGreaterThanOrEqual(500);
  }, T);

  test("a bare prompt alone is never ready: the start fails after readyMs with the tool's last screen", async () => {
    const bare = ["sh", "-c", "printf '  >_ OpenAI Codex\\n\\n› '; sleep 30", "tool"];
    const { s } = rig.make({ bins: { claude: ["sh", "-c", "sleep 30", "tool"], codex: bare }, readyMs: 1200 });
    s.start();
    await expect(s.ensure(CHAT, rig.spec("worker-b", "codex"))).rejects.toThrow(/not ready after/);
    expect(s.status(CHAT, "worker-b")).toBe("stopped");
  }, T);
});

describe("FLAW 1: a delivery check after every paste", () => {
  test("Claude Code: send returns after the UserPromptSubmit hook with the pasted line was applied", async () => {
    const { s, events } = rig.make();
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await s.send(CHAT, "worker-a", "say hi");
    expect(of(events, "turnStart")).toHaveLength(1);
    expect(of(events, "turnStart")[0]).toMatchObject({ agent: "worker-a", prompt: "say hi", fromTerminal: false });
    expect(s.status(CHAT, "worker-a")).toBe("working");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
  }, T);

  test("Codex: send returns when the screen is busy or shows the line above the prompt, and the status is working", async () => {
    const { s, events } = rig.make({ env: { FAKE_TURN_MS: "800" } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    await s.send(CHAT, "worker-b", "say hi");
    expect(capture(rig.name("worker-b"))).toMatch(/esc to interrupt|say hi/);
    expect(s.status(CHAT, "worker-b")).toBe("working");
    expect(await waitFor(() => of(events, "turnEnd").length === 1)).toBe(true);
  }, T);

  test("a trust question that shows after the paste: SendError, the status is not working, needsYou with reason trust", async () => {
    const { s, events } = rig.make({ bins: { claude: scripted(["claude", "screens", "ready.txt"], ["claude", "screens", "trust.txt"], 1.3), codex: ["sh", "-c", "sleep 30", "tool"] } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(s.status(CHAT, "worker-a")).toBe("idle");
    await expect(s.send(CHAT, "worker-a", "say hi")).rejects.toBeInstanceOf(SendError);
    expect(s.status(CHAT, "worker-a")).toBe("needsYou");
    expect(s.need(CHAT, "worker-a")).toBe("trust");
    expect(of(events, "needsYou").map((e) => e.reason)).toEqual(["trust"]);
    // A second send is refused at once, with nothing pasted.
    await expect(s.send(CHAT, "worker-a", "say again")).rejects.toBeInstanceOf(SendError);
    expect(capture(rig.name("worker-a"))).not.toContain("say again");
  }, T);

  test("an update question that shows after the paste: SendError, needsYou with reason other", async () => {
    const { s, events } = rig.make({ bins: { claude: ["sh", "-c", "sleep 30", "tool"], codex: scripted(["codex", "screens", "ready.txt"], ["codex", "screens", "update.txt"], 1.3) } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-b", "codex"));
    await expect(s.send(CHAT, "worker-b", "say hi")).rejects.toBeInstanceOf(SendError);
    expect(s.status(CHAT, "worker-b")).toBe("needsYou");
    expect(s.need(CHAT, "worker-b")).toBe("other");
    expect(of(events, "needsYou").map((e) => e.reason)).toEqual(["other"]);
  }, T);

  test("a dialog that shows after the paste: SendError, needsYou with reason other", async () => {
    const { s, events } = rig.make({ bins: { claude: scripted(["claude", "screens", "ready.txt"], ["claude", "screens", "dialog.txt"], 1.3), codex: ["sh", "-c", "sleep 30", "tool"] } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    await expect(s.send(CHAT, "worker-a", "say hi")).rejects.toBeInstanceOf(SendError);
    expect(s.status(CHAT, "worker-a")).toBe("needsYou");
    expect(s.need(CHAT, "worker-a")).toBe("other");
    expect(of(events, "needsYou").map((e) => e.reason)).toEqual(["other"]);
  }, T);
});

describe("OPEN ITEM: Claude Code's permission prompt", () => {
  test("send refuses to paste into it: SendError, needsYou with reason permission, nothing pasted", async () => {
    const { s, events } = rig.make({ bins: { claude: scripted(["claude", "screens", "ready.txt"], ["claude", "screens", "permission.txt"], 1.5), codex: ["sh", "-c", "sleep 30", "tool"] } });
    s.start();
    await s.ensure(CHAT, rig.spec("worker-a"));
    expect(await waitFor(() => capture(rig.name("worker-a")).includes("Do you want to proceed?"))).toBe(true);
    await expect(s.send(CHAT, "worker-a", "say hi")).rejects.toBeInstanceOf(SendError);
    expect(s.status(CHAT, "worker-a")).toBe("needsYou");
    expect(s.need(CHAT, "worker-a")).toBe("permission");
    expect(of(events, "needsYou").map((e) => e.reason)).toEqual(["permission"]);
    expect(capture(rig.name("worker-a"))).not.toContain("say hi");
  }, T);
});

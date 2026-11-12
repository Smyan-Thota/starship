import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { paths } from "../src/config.ts";
import { appendHookEvent, appliedCount, markApplied, readNewEvents, toAgentEvents } from "../src/hooks.ts";
import { fixture, tempHome } from "./helpers.ts";

const HOOK_ENTRY = join(import.meta.dir, "..", "src", "hook-entry.ts");

let h: ReturnType<typeof tempHome>;
beforeEach(() => {
  h = tempHome();
});
afterEach(() => h.restore());

const raw = (...p: string[]) => readFileSync(fixture(...p), "utf8");
const claudeRaw = (name: string, over: Record<string, unknown> = {}) => JSON.stringify({ ...JSON.parse(raw("claude", name)), ...over });
const notification = (over: Record<string, unknown> = {}) =>
  JSON.stringify({
    session_id: "s1",
    transcript_path: "/x/s1.jsonl",
    cwd: "/work",
    hook_event_name: "Notification",
    message: "Claude needs your permission to use Bash",
    notification_type: "permission_prompt",
    ...over,
  });

const claude = (agent: string, text: string) => ({ agent, tool: "claude" as const, raw: text });
const codex = (agent: string, text: string) => ({ agent, tool: "codex" as const, raw: text });

/** Runs hook-entry.ts as a tool would, with only the env a hook gets. */
function runEntry(args: string[], o: { stdin?: string; env?: Record<string, string> } = {}) {
  const r = Bun.spawnSync([process.execPath, HOOK_ENTRY, ...args], {
    stdin: Buffer.from(o.stdin ?? ""),
    stdout: "pipe",
    stderr: "pipe",
    env: { PATH: process.env.PATH ?? "", STARSHIP_HOME: h.dir, ...o.env },
  });
  return { code: r.exitCode, out: r.stdout.toString(), err: r.stderr.toString() };
}

describe("toAgentEvents, Claude Code", () => {
  test("A8: the owner types in the admin's terminal: the turn is marked from terminal", () => {
    // The admin's last pasted text differs from the prompt that the hook reports.
    const typed = toAgentEvents(claude("admin", claudeRaw("hook-user-prompt-submit.json")), { chat: "c1", lastPasted: "an earlier message" });
    expect(typed).toEqual([
      { type: "turnStart", chat: "c1", agent: "admin", prompt: "Reply with the single word hello. Do not use any tool.", fromTerminal: true },
    ]);
    // The engine pasted this text itself.
    const pasted = toAgentEvents(claude("admin", claudeRaw("hook-user-prompt-submit.json")), {
      chat: "c1",
      lastPasted: "Reply with the single word hello. Do not use any tool.",
    });
    expect(pasted[0]).toMatchObject({ type: "turnStart", fromTerminal: false });
    // The end of a turn that began in the terminal is marked the same way.
    const end = toAgentEvents(claude("admin", claudeRaw("hook-stop.json")), { chat: "c1", lastPasted: null, fromTerminal: true });
    expect(end).toEqual([{ type: "turnEnd", chat: "c1", agent: "admin", reply: "hello", fromTerminal: true }]);
  });

  test("after Escape cut a turn, a prompt that holds the cut line is the engine's; with no cut line it is the owner's", () => {
    const joined = claudeRaw("hook-user-prompt-submit.json", { prompt: "Write a 900-word story about a fox\ncontinue" });
    const cut = toAgentEvents(claude("admin", joined), { chat: "c1", lastPasted: "continue", cutLine: "Write a 900-word story about a fox" });
    expect(cut[0]).toMatchObject({ type: "turnStart", fromTerminal: false });
    const typed = toAgentEvents(claude("admin", joined), { chat: "c1", lastPasted: "continue", cutLine: null });
    expect(typed[0]).toMatchObject({ type: "turnStart", fromTerminal: true });
    const other = toAgentEvents(claude("admin", joined), { chat: "c1", lastPasted: "continue", cutLine: "something else" });
    expect(other[0]).toMatchObject({ type: "turnStart", fromTerminal: true });
  });

  test("A10: the admin agent needs a permission: needsYou with reason permission", () => {
    const events = toAgentEvents(claude("admin", notification()), { chat: "c1", lastPasted: null });
    expect(events).toEqual([{ type: "needsYou", chat: "c1", agent: "admin", reason: "permission", message: "Claude needs your permission to use Bash" }]);
  });

  test("D3: the owner types in a worker's terminal: allowed, and the turn is marked from terminal", () => {
    // Nothing was pasted yet: any prompt came from the terminal.
    const first = toAgentEvents(claude("worker-a", claudeRaw("hook-user-prompt-submit.json", { prompt: "do it my way" })), { chat: "c1", lastPasted: null });
    expect(first[0]).toMatchObject({ type: "turnStart", agent: "worker-a", prompt: "do it my way", fromTerminal: true });
    // The text the engine pasted last is compared as typed, apart from spaces at the ends.
    const same = toAgentEvents(claude("worker-a", claudeRaw("hook-user-prompt-submit.json", { prompt: "do T001 " })), { chat: "c1", lastPasted: "do T001" });
    expect(same[0]).toMatchObject({ type: "turnStart", fromTerminal: false });
    // Codex reports the turn only when it ends. It gives the start and the end together, marked the same way.
    const notify = JSON.stringify({ ...JSON.parse(raw("codex", "notify.json")), "input-messages": ["first", "my own words"] });
    const typedInCodex = toAgentEvents(codex("worker-b", notify), { chat: "c1", lastPasted: "first" });
    expect(typedInCodex).toEqual([
      { type: "turnStart", chat: "c1", agent: "worker-b", prompt: "my own words", fromTerminal: true },
      { type: "turnEnd", chat: "c1", agent: "worker-b", reply: "hello", fromTerminal: true },
    ]);
    const pastedInCodex = toAgentEvents(codex("worker-b", raw("codex", "notify.json")), {
      chat: "c1",
      lastPasted: "Reply with the single word hello. Do not run any command.",
    });
    expect(pastedInCodex.map((e) => (e.type === "turnStart" || e.type === "turnEnd" ? e.fromTerminal : null))).toEqual([false, false]);
  });

  test("D6: a worker needs a permission: needsYou with reason permission, for that worker", () => {
    const events = toAgentEvents(claude("worker-a", notification({ message: "Allow Write?" })), { chat: "c2", lastPasted: "x" });
    expect(events).toEqual([{ type: "needsYou", chat: "c2", agent: "worker-a", reason: "permission", message: "Allow Write?" }]);
    // A notification that asks for nothing is not a permission.
    expect(toAgentEvents(claude("worker-a", notification({ notification_type: "idle_prompt" })), { chat: "c2", lastPasted: null })).toEqual([]);
  });

  test("SessionStart gives started, resumed when the source is resume; SessionEnd gives ended; PreToolUse gives nothing", () => {
    const ctx = { chat: "c1", lastPasted: null };
    expect(toAgentEvents(claude("a", raw("claude", "hook-session-start.json")), ctx)).toEqual([{ type: "started", chat: "c1", agent: "a", resumed: false }]);
    expect(toAgentEvents(claude("a", raw("claude", "hook-session-start-resume.json")), ctx)).toEqual([{ type: "started", chat: "c1", agent: "a", resumed: true }]);
    expect(toAgentEvents(claude("a", claudeRaw("hook-stop.json", { hook_event_name: "SessionEnd" })), ctx)).toEqual([{ type: "ended", chat: "c1", agent: "a" }]);
    expect(toAgentEvents(claude("a", raw("claude", "hook-pre-tool-use.json")), ctx)).toEqual([]);
  });

  test("Stop gives turnEnd with the reply; an input that cannot be read gives no events", () => {
    expect(toAgentEvents(claude("a", raw("claude", "hook-stop.json")), { chat: "c1", lastPasted: null })).toEqual([
      { type: "turnEnd", chat: "c1", agent: "a", reply: "hello", fromTerminal: false },
    ]);
    expect(toAgentEvents(claude("a", "not json"), { chat: "c1", lastPasted: null })).toEqual([]);
    expect(toAgentEvents(codex("a", '{"type":"other"}'), { chat: "c1", lastPasted: null })).toEqual([]);
  });
});

describe("the event log", () => {
  test("D18: a hook fires while the engine is down: the event is in events.jsonl and each line is applied once", () => {
    // No engine, no poll loop: the hook only needs the home folder.
    appendHookEvent("c1", claude("worker-a", raw("claude", "hook-user-prompt-submit.json")));
    appendHookEvent("c1", claude("worker-a", raw("claude", "hook-stop.json")));
    const file = join(paths.chat("c1"), "events.jsonl");
    const rows = readFileSync(file, "utf8").split("\n").filter((l) => l !== "");
    expect(rows).toHaveLength(2);
    const first = JSON.parse(rows[0] ?? "") as { at: number; agent: string; tool: string; raw: string };
    expect(Object.keys(first).sort()).toEqual(["agent", "at", "raw", "tool"]);
    expect(first).toMatchObject({ agent: "worker-a", tool: "claude" });
    expect(Math.abs(first.at - Date.now())).toBeLessThan(5000);

    // The engine starts: it gets both lines, in order.
    const first_read = readNewEvents("c1");
    expect(first_read.map((e) => e.line)).toEqual([1, 2]);
    expect(toAgentEvents(first_read[1] ?? claude("x", ""), { chat: "c1", lastPasted: null })[0]).toMatchObject({ type: "turnEnd", reply: "hello" });
    // It applies line 1 and stops: after a restart only line 2 is left.
    markApplied("c1", 1);
    expect(readNewEvents("c1").map((e) => e.line)).toEqual([2]);
    markApplied("c1", 2);
    expect(readNewEvents("c1")).toEqual([]);
    expect(readFileSync(join(paths.chat("c1"), "events.applied"), "utf8").trim()).toBe("2");
    // A new line that arrives later is the only one that is new.
    appendHookEvent("c1", claude("worker-a", raw("claude", "hook-stop.json")));
    expect(readNewEvents("c1").map((e) => e.line)).toEqual([3]);
  });

  test("D18: a line that is not an event is skipped and counted, and an unfinished last line waits", () => {
    appendHookEvent("c1", claude("a", "one"));
    const file = join(paths.chat("c1"), "events.jsonl");
    appendFileSync(file, "this is not json\n");
    appendFileSync(file, '{"at":1,"agent":"a","tool":"other","raw":"x"}\n'); // valid JSON, wrong shape
    appendHookEvent("c1", codex("a", "two"));
    appendFileSync(file, '{"at":1,"agent":"a","tool":"claude","ra'); // a write in progress
    const events = readNewEvents("c1");
    expect(events.map((e) => [e.line, e.raw])).toEqual([
      [1, "one"],
      [4, "two"],
    ]);
    markApplied("c1", 4);
    expect(readNewEvents("c1")).toEqual([]);
    // The write finishes: the line counts as number 5.
    appendFileSync(file, 'w":"three"}\n');
    expect(readNewEvents("c1").map((e) => [e.line, e.raw])).toEqual([[5, "three"]]);
  });

  test("the applied count never goes down, and a missing file counts as 0", () => {
    expect(appliedCount("none")).toBe(0);
    expect(readNewEvents("none")).toEqual([]);
    markApplied("c1", 5);
    markApplied("c1", 3);
    expect(appliedCount("c1")).toBe(5);
  });

  test("many hooks at once give whole lines", async () => {
    const stop = raw("claude", "hook-stop.json");
    const runs = Array.from({ length: 8 }, (_, i) =>
      Bun.spawn([process.execPath, HOOK_ENTRY, "hook", "claude"], {
        stdin: new Blob([stop]),
        stdout: "ignore",
        stderr: "ignore",
        env: { PATH: process.env.PATH ?? "", STARSHIP_HOME: h.dir, STARSHIP_CHAT: "c1", STARSHIP_AGENT: `a${i}` },
      }).exited,
    );
    expect(await Promise.all(runs)).toEqual(Array(8).fill(0));
    const events = readNewEvents("c1");
    expect(events).toHaveLength(8);
    expect(new Set(events.map((e) => e.agent)).size).toBe(8);
    expect(events.every((e) => e.raw === stop.trim())).toBe(true);
  });
});

describe("hook-entry.ts", () => {
  const env = { STARSHIP_CHAT: "c1", STARSHIP_AGENT: "worker-a" };

  test("hook claude reads stdin, appends one event, prints nothing, exits 0", () => {
    const input = raw("claude", "hook-stop.json");
    const r = runEntry(["hook", "claude"], { stdin: input, env });
    expect(r).toEqual({ code: 0, out: "", err: "" });
    const events = readNewEvents("c1");
    expect(events).toHaveLength(1);
    expect(events[0]).toMatchObject({ agent: "worker-a", tool: "claude", raw: input.trim() });
    expect(existsSync(join(h.dir, "hook-errors.log"))).toBe(false);
  });

  test("hook codex takes the input from its last argument", () => {
    const input = raw("codex", "notify.json");
    const r = runEntry(["hook", "codex", input], { env });
    expect(r).toEqual({ code: 0, out: "", err: "" });
    expect(readNewEvents("c1")).toMatchObject([{ agent: "worker-a", tool: "codex", raw: input }]);
  });

  test("a failing hook prints nothing, exits 0 and writes hook-errors.log", () => {
    // No chat and no agent in the env.
    const a = runEntry(["hook", "claude"], { stdin: raw("claude", "hook-stop.json") });
    expect(a).toEqual({ code: 0, out: "", err: "" });
    // Empty input.
    const b = runEntry(["hook", "claude"], { stdin: "", env });
    expect(b).toEqual({ code: 0, out: "", err: "" });
    // An unknown tool and an unknown command.
    expect(runEntry(["hook", "other"], { env }).code).toBe(0);
    expect(runEntry(["nonsense"], { env })).toEqual({ code: 0, out: "", err: "" });
    const log = readFileSync(join(h.dir, "hook-errors.log"), "utf8").trim().split("\n");
    expect(log).toHaveLength(4);
    expect(log[0]).toContain("STARSHIP_CHAT");
    expect(log[1]).toContain("no input");
    expect(readNewEvents("c1")).toEqual([]);
  });

  test("status writes the status line input to usage/claude-status.json and prints starship", () => {
    const input = raw("claude", "statusline.json");
    const r = runEntry(["status"], { stdin: input });
    expect(r).toEqual({ code: 0, out: "starship\n", err: "" });
    expect(readFileSync(join(h.dir, "usage", "claude-status.json"), "utf8")).toBe(input);
    // A second input replaces the first. No temp file is left.
    const second = raw("claude", "statusline-no-limits.json");
    runEntry(["status"], { stdin: second });
    expect(readFileSync(join(h.dir, "usage", "claude-status.json"), "utf8")).toBe(second);
    expect(new Bun.Glob("*").scanSync(join(h.dir, "usage")).next().value).toBe("claude-status.json");
  });

  test("status prints starship also when the input is bad, and keeps the old file", () => {
    runEntry(["status"], { stdin: raw("claude", "statusline.json") });
    const r = runEntry(["status"], { stdin: "garbage" });
    expect(r).toEqual({ code: 0, out: "starship\n", err: "" });
    expect(readFileSync(join(h.dir, "usage", "claude-status.json"), "utf8")).toBe(raw("claude", "statusline.json"));
    expect(readFileSync(join(h.dir, "hook-errors.log"), "utf8")).toContain("status");
  });
});

describe("starship status keeps the status line input of each agent (G6)", () => {
  const input = JSON.stringify({ model: { id: "x" }, context_window: { used_percentage: 90 } });
  const file = (chat: string, agent: string) => join(paths.chat(chat), "agents", `${agent}.status.json`);

  test("with STARSHIP_CHAT and STARSHIP_AGENT the input is written for that agent, as well as for the usage file", () => {
    const r = runEntry(["status"], { stdin: input, env: { STARSHIP_CHAT: "c1", STARSHIP_AGENT: "worker-a" } });
    expect(r).toMatchObject({ code: 0, out: "starship\n", err: "" });
    expect(JSON.parse(readFileSync(file("c1", "worker-a"), "utf8"))).toEqual(JSON.parse(input));
    expect(JSON.parse(readFileSync(join(h.dir, "usage", "claude-status.json"), "utf8"))).toEqual(JSON.parse(input));
  });

  test("without them only the usage file is written; a name that is a path writes nothing outside the agents folder", () => {
    expect(runEntry(["status"], { stdin: input }).out).toBe("starship\n");
    expect(existsSync(paths.chats())).toBe(false);
    expect(existsSync(join(h.dir, "usage", "claude-status.json"))).toBe(true);
    const r = runEntry(["status"], { stdin: input, env: { STARSHIP_CHAT: "c1", STARSHIP_AGENT: "../../evil" } });
    expect(r).toMatchObject({ code: 0, out: "starship\n" });
    expect(existsSync(join(h.dir, "evil.status.json"))).toBe(false);
    expect(existsSync(join(paths.chat("c1"), "agents"))).toBe(false);
  });
});

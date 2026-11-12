import { afterAll, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { claudeScreen } from "../src/agents/claude.ts";
import { codexScreen } from "../src/agents/codex.ts";
import { capture, escape, hasSession, kill, newSession, paste, shellQuote } from "../src/agents/tmux.ts";
import { drop, fixture, tempDir } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fake-agent.ts");
const made: string[] = [];
const dirs: string[] = [];

afterAll(() => {
  for (const n of made) kill(n);
  const left = made.filter((n) => hasSession(n));
  for (const d of dirs) drop(d);
  expect(left).toEqual([]);
});

const rand = () => Math.random().toString(36).slice(2, 10);
const ms = (n: number) => Bun.sleep(n);
const t = (title: string, fn: () => Promise<void>) => test(title, fn, 25000);

async function waitFor(check: () => boolean, limit = 8000): Promise<boolean> {
  const end = Date.now() + limit;
  while (Date.now() < end) {
    if (check()) return true;
    await ms(40);
  }
  return check();
}

const fixtureJson = (...p: string[]) => JSON.parse(readFileSync(fixture(...p), "utf8")) as Record<string, unknown>;
const keysOf = (o: unknown) => Object.keys(o as Record<string, unknown>).sort();

/** A work folder with a hook script that appends each event's stdin to <home>/<Event>.jsonl. */
interface Rig {
  home: string;
  cwd: string;
  sessions: string;
  settings: string;
  notify: string;
  events: (event: string) => Record<string, unknown>[];
  lines: (file: string) => string[];
}

function rig(): Rig {
  const home = tempDir("starship-fake-");
  dirs.push(home);
  const cwd = tempDir("starship-work-");
  dirs.push(cwd);
  const sessions = join(home, "sessions");
  const hook = join(home, "hook.sh");
  writeFileSync(hook, `#!/bin/sh\n{ cat; echo; } >> ${shellQuote(home)}/"$1".jsonl\n`);
  const notify = join(home, "notify.sh");
  writeFileSync(notify, `#!/bin/sh\necho "$#" >> ${shellQuote(home)}/notify-argc.txt\necho "$1" >> ${shellQuote(home)}/notify.jsonl\n`);
  const run = (event: string) => ({ hooks: [{ type: "command", command: `sh ${shellQuote(hook)} ${event}` }] });
  const settings = join(home, "settings.json");
  writeFileSync(
    settings,
    JSON.stringify({
      hooks: {
        SessionStart: [run("SessionStart")],
        UserPromptSubmit: [run("UserPromptSubmit")],
        Stop: [run("Stop")],
        Notification: [run("Notification")],
        PreToolUse: [{ matcher: "Write", ...run("PreToolUse") }],
      },
      statusLine: { type: "command", command: `sh ${shellQuote(hook)} StatusLine` },
    }),
  );
  const lines = (file: string) => {
    const p = join(home, file);
    return existsSync(p) ? readFileSync(p, "utf8").split("\n").filter((l) => l !== "") : [];
  };
  return {
    home,
    cwd,
    sessions,
    settings,
    notify,
    lines,
    events: (e) => lines(`${e}.jsonl`).map((l) => JSON.parse(l) as Record<string, unknown>),
  };
}

/** Starts the fake agent in tmux. It prints EXIT:<code> when the process ends, then sleeps. */
function start(r: Rig, args: string[], env: Record<string, string> = {}): string {
  const n = `sst-${rand()}`;
  made.push(n);
  newSession({
    name: n,
    cwd: r.cwd,
    command: ["sh", "-c", `${shellQuote(process.execPath)} ${shellQuote(FAKE)} "$@"; echo "EXIT:$?"; sleep 60`, "sh", ...args],
    env: { FAKE_SESSIONS_DIR: r.sessions, ...env },
  });
  return n;
}

const claude = (r: Rig, extra: string[] = [], env: Record<string, string> = {}) =>
  start(r, ["--as", "claude", "--settings", r.settings, ...extra], env);

const codex = (r: Rig, extra: string[] = [], env: Record<string, string> = {}) =>
  start(r, ["--as", "codex", "-C", r.cwd, "-c", `notify=["sh","${r.notify}"]`, ...extra], env);

const ready = (n: string, mark: string) => waitFor(() => capture(n).includes(mark));
const exited = (n: string) => waitFor(() => /EXIT:\d+/.test(capture(n)));
const exitCode = (n: string) => /EXIT:(\d+)/.exec(capture(n))?.[1];

/** Keys other than Enter and Escape exist only in this test file, to act as the owner would. */
function rawKeys(n: string, ...keys: string[]): void {
  const r = Bun.spawnSync(["tmux", "send-keys", "-t", `=${n}:`, ...keys]);
  if (r.exitCode !== 0) throw new Error(r.stderr.toString());
}

describe("fake agent, Claude Code flavor", () => {
  t("say hello: the hooks arrive with the fixtures' key names", async () => {
    const r = rig();
    const n = claude(r);
    expect(await ready(n, "❯")).toBe(true);

    const start = r.events("SessionStart");
    expect(start).toHaveLength(1);
    expect(keysOf(start[0])).toEqual(keysOf(fixtureJson("claude", "hook-session-start.json")));
    expect(start[0]?.source).toBe("startup");
    expect(start[0]?.cwd).toBe(r.cwd);

    paste(n, "say hello");
    expect(await waitFor(() => r.events("Stop").length === 1)).toBe(true);

    const submit = r.events("UserPromptSubmit");
    expect(submit).toHaveLength(1);
    expect(keysOf(submit[0])).toEqual(keysOf(fixtureJson("claude", "hook-user-prompt-submit.json")));
    expect(submit[0]?.prompt).toBe("say hello");

    const stop = r.events("Stop")[0];
    expect(keysOf(stop)).toEqual(keysOf(fixtureJson("claude", "hook-stop.json")));
    expect(stop?.last_assistant_message).toBe("hello");
    expect(stop?.hook_event_name).toBe("Stop");
    expect(stop?.prompt_id).toBe(submit[0]?.prompt_id);

    // the screen shows the reply and the real tool's ready screen: the adapter's own classifier says `ready`, the busy line is gone
    expect(await waitFor(() => claudeScreen(capture(n)) === "ready")).toBe(true);
    expect(capture(n)).toContain("⏺ hello");
    expect(capture(n)).not.toContain("esc to interrupt");
  });

  t("the ready screen at the start is the real one: the footer of fixtures/claude/screens/ready.txt, and the adapter says ready", async () => {
    const r = rig();
    const n = claude(r);
    expect(await ready(n, "auto mode on")).toBe(true);
    expect(claudeScreen(capture(n))).toBe("ready");
    expect(capture(n).trimEnd().split("\n").pop()).not.toBe("❯"); // the last line is the footer, not a bare prompt
  });

  t("the transcript sits under FAKE_SESSIONS_DIR and has the user and assistant lines", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "say hello");
    await waitFor(() => r.events("Stop").length === 1);

    const path = String(r.events("Stop")[0]?.transcript_path);
    expect(path.startsWith(r.sessions)).toBe(true);
    expect(path.endsWith(`${r.events("Stop")[0]?.session_id}.jsonl`)).toBe(true);
    const rows = readFileSync(path, "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { type: string; message: { role: string; content: unknown }; sessionId: string });
    const user = rows.find((x) => x.type === "user");
    const assistant = rows.find((x) => x.type === "assistant");
    expect(user?.message.role).toBe("user");
    expect(user?.message.content).toBe("say hello");
    expect(assistant?.message.role).toBe("assistant");
    expect(assistant?.message.content).toEqual([expect.objectContaining({ type: "text", text: "hello" })]);
    expect(assistant?.sessionId).toBe(String(r.events("Stop")[0]?.session_id));
  });

  t("after a turn the status line command gets the fixture's shape", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "say hi");
    expect(await waitFor(() => r.events("StatusLine").length >= 1)).toBe(true);
    const status = r.events("StatusLine")[0];
    expect(keysOf(status)).toEqual(keysOf(fixtureJson("claude", "statusline.json")));
    const limits = status?.rate_limits as Record<string, Record<string, unknown>>;
    expect(keysOf(limits)).toEqual(["five_hour", "seven_day"]);
    expect(keysOf(limits.five_hour)).toEqual(["resets_at", "used_percentage"]);
    expect(typeof (status?.context_window as { used_percentage: unknown }).used_percentage).toBe("number");
  });

  t("Escape stops the turn with no Stop, and the next line works", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "slow 5000 x");
    expect(await waitFor(() => r.events("UserPromptSubmit").length === 1)).toBe(true);
    await ms(200);
    escape(n);
    await ms(1500);
    expect(r.events("Stop")).toEqual([]);
    paste(n, "say again");
    expect(await waitFor(() => r.events("Stop").length === 1)).toBe(true);
    expect(r.events("Stop")[0]?.last_assistant_message).toBe("again");
    // the slow turn's five seconds pass and still nothing else arrives
    await ms(4000);
    expect(r.events("Stop")).toHaveLength(1);
  });

  t("slow waits, then replies", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "slow 600 later words");
    await ms(250);
    expect(r.events("Stop")).toEqual([]);
    expect(await waitFor(() => r.events("Stop").length === 1)).toBe(true);
    expect(r.events("Stop")[0]?.last_assistant_message).toBe("later words");
  });

  t("stall never ends the turn, and Escape frees it", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "stall");
    await waitFor(() => r.events("UserPromptSubmit").length === 1);
    await ms(1200);
    expect(r.events("Stop")).toEqual([]);
    expect(hasSession(n)).toBe(true);
    escape(n);
    await ms(300);
    paste(n, "say free");
    expect(await waitFor(() => r.events("Stop").length === 1)).toBe(true);
    expect(r.events("Stop")[0]?.last_assistant_message).toBe("free");
  });

  t("crash ends the process with code 1 and no Stop", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "crash");
    expect(await exited(n)).toBe(true);
    expect(exitCode(n)).toBe("1");
    expect(r.events("UserPromptSubmit")).toHaveLength(1);
    expect(r.events("Stop")).toEqual([]);
  });

  t("permission fires Notification, waits for y, then replies done", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "permission");
    expect(await waitFor(() => r.events("Notification").length === 1)).toBe(true);
    const note = r.events("Notification")[0];
    expect(note?.hook_event_name).toBe("Notification");
    expect(typeof note?.message).toBe("string");
    expect(note?.session_id).toBe(r.events("SessionStart")[0]?.session_id);
    await ms(600);
    expect(r.events("Stop")).toEqual([]);
    paste(n, "y");
    expect(await waitFor(() => r.events("Stop").length === 1)).toBe(true);
    expect(r.events("Stop")[0]?.last_assistant_message).toBe("done");
    expect(r.events("UserPromptSubmit")).toHaveLength(1);
  });

  t("write makes the file, fires PreToolUse, replies done", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "write sub/dir/a.txt hello there");
    expect(await waitFor(() => r.events("Stop").length === 1)).toBe(true);
    expect(readFileSync(join(r.cwd, "sub", "dir", "a.txt"), "utf8")).toBe("hello there");
    const pre = r.events("PreToolUse")[0];
    expect(keysOf(pre)).toEqual(keysOf(fixtureJson("claude", "hook-pre-tool-use.json")));
    expect(pre?.tool_name).toBe("Write");
    expect(r.events("Stop")[0]?.last_assistant_message).toBe("done");
  });

  t("write refuses a path outside cwd", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "write ../escape.txt nope");
    expect(await waitFor(() => r.events("Stop").length === 1)).toBe(true);
    expect(existsSync(join(r.cwd, "..", "escape.txt"))).toBe(false);
    expect(String(r.events("Stop")[0]?.last_assistant_message)).toContain("outside");
  });

  t("claim says done and writes nothing; empty replies with nothing; other lines get ok:", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "claim");
    await waitFor(() => r.events("Stop").length === 1);
    paste(n, "empty");
    await waitFor(() => r.events("Stop").length === 2);
    paste(n, "what is this");
    await waitFor(() => r.events("Stop").length === 3);
    expect(r.events("Stop").map((s) => s.last_assistant_message)).toEqual(["done", "", "ok: what is this"]);
    expect(r.events("PreToolUse")).toEqual([]);
    expect(readdirSync(r.cwd)).toEqual([]);
  });

  t("lines that arrive during a turn wait their turn", async () => {
    const r = rig();
    const n = claude(r);
    await ready(n, "❯");
    paste(n, "slow 700 first");
    await ms(200);
    paste(n, "say second");
    expect(await waitFor(() => r.events("Stop").length === 2)).toBe(true);
    expect(r.events("Stop").map((s) => s.last_assistant_message)).toEqual(["first", "second"]);
  });

  t("--session-id sets the id", async () => {
    const r = rig();
    const id = crypto.randomUUID();
    const n = claude(r, ["--session-id", id, "--model", "claude-test-1"]);
    await ready(n, "❯");
    const start = r.events("SessionStart")[0];
    expect(start?.session_id).toBe(id);
    expect(start?.source).toBe("startup");
    expect(start?.model).toBe("claude-test-1");
  });

  t("--resume keeps the session id and fires SessionStart with source resume", async () => {
    const r = rig();
    const id = crypto.randomUUID();
    const n = claude(r, ["--resume", id]);
    await ready(n, "❯");
    const start = r.events("SessionStart")[0];
    expect(start?.source).toBe("resume");
    expect(start?.session_id).toBe(id);
    expect(keysOf(start)).toEqual(keysOf(fixtureJson("claude", "hook-session-start-resume.json")));
    paste(n, "say back");
    await waitFor(() => r.events("Stop").length === 1);
    expect(r.events("Stop")[0]?.session_id).toBe(id);
    expect(String(r.events("Stop")[0]?.transcript_path).endsWith(`${id}.jsonl`)).toBe(true);
  });

  t("--append-system-prompt-file is accepted", async () => {
    const r = rig();
    const f = join(r.home, "prompt.txt");
    writeFileSync(f, "be brief");
    const n = claude(r, ["--append-system-prompt-file", f]);
    expect(await ready(n, "❯")).toBe(true);
  });

  t("without FAKE_SESSIONS_DIR it refuses to start", async () => {
    const r = rig();
    const n = `sst-${rand()}`;
    made.push(n);
    newSession({
      name: n,
      cwd: r.cwd,
      command: ["sh", "-c", `env -u FAKE_SESSIONS_DIR ${shellQuote(process.execPath)} ${shellQuote(FAKE)} --as claude; echo "EXIT:$?"; sleep 60`],
    });
    expect(await exited(n)).toBe(true);
    expect(exitCode(n)).not.toBe("0");
    expect(capture(n)).toContain("FAKE_SESSIONS_DIR");
  });
});

describe("fake agent, Codex flavor", () => {
  const rolloutFiles = (r: Rig): string[] => {
    const out: string[] = [];
    const walk = (d: string) => {
      if (!existsSync(d)) return;
      for (const e of readdirSync(d)) {
        const p = join(d, e);
        if (statSync(p).isDirectory()) walk(p);
        else if (/^rollout-.*\.jsonl$/.test(e)) out.push(p);
      }
    };
    walk(r.sessions);
    return out;
  };

  t("notify gets one JSON argument, and the rollout has task_started then task_complete", async () => {
    const r = rig();
    const n = codex(r, ["-m", "gpt-test"]);
    expect(await ready(n, "›")).toBe(true);
    paste(n, "say hello");
    expect(await waitFor(() => r.lines("notify.jsonl").length === 1)).toBe(true);

    expect(r.lines("notify-argc.txt")).toEqual(["1"]);
    const note = JSON.parse(r.lines("notify.jsonl")[0] ?? "{}") as Record<string, unknown>;
    expect(keysOf(note)).toEqual(keysOf(fixtureJson("codex", "notify.json")));
    expect(note.type).toBe("agent-turn-complete");
    expect(note["last-assistant-message"]).toBe("hello");
    expect(note["input-messages"]).toEqual(["say hello"]);
    expect(note.cwd).toBe(r.cwd);

    const files = rolloutFiles(r);
    expect(files).toHaveLength(1);
    expect(files[0]?.endsWith(`${note["thread-id"]}.jsonl`)).toBe(true);
    const rows = readFileSync(files[0] ?? "", "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => JSON.parse(l) as { type: string; payload: Record<string, unknown> });
    expect(rows[0]?.type).toBe("session_meta");
    expect(rows[0]?.payload.id).toBe(note["thread-id"]);
    expect(rows[0]?.payload.cwd).toBe(r.cwd);
    const events = rows.filter((x) => x.type === "event_msg").map((x) => x.payload.type);
    expect(events).toEqual(["task_started", "token_count", "task_complete"]);
    const complete = rows.find((x) => x.payload.type === "task_complete");
    expect(complete?.payload.last_agent_message).toBe("hello");
    expect(complete?.payload.turn_id).toBe(note["turn-id"]);
    const count = rows.find((x) => x.payload.type === "token_count");
    const rate = (count?.payload.rate_limits as { primary: Record<string, unknown> }).primary;
    expect(keysOf(rate)).toEqual(["resets_at", "used_percent", "window_minutes"]);
  });

  t("Escape stops a codex turn: no notify, and the next line works", async () => {
    const r = rig();
    const n = codex(r);
    await ready(n, "›");
    paste(n, "slow 5000 x");
    await ms(400);
    escape(n);
    await ms(1200);
    expect(r.lines("notify.jsonl")).toEqual([]);
    paste(n, "say again");
    expect(await waitFor(() => r.lines("notify.jsonl").length === 1)).toBe(true);
    expect(JSON.parse(r.lines("notify.jsonl")[0] ?? "{}")["last-assistant-message"]).toBe("again");
  });

  t("resume <id> keeps the thread id", async () => {
    const r = rig();
    const id = crypto.randomUUID();
    const n = start(r, ["--as", "codex", "resume", id, "-C", r.cwd, "-c", `notify=["sh","${r.notify}"]`]);
    await ready(n, "›");
    paste(n, "say back");
    expect(await waitFor(() => r.lines("notify.jsonl").length === 1)).toBe(true);
    expect(JSON.parse(r.lines("notify.jsonl")[0] ?? "{}")["thread-id"]).toBe(id);
    expect(rolloutFiles(r)[0]?.endsWith(`${id}.jsonl`)).toBe(true);
  });

  t("a second run that resumes the same id appends to the same rollout file", async () => {
    const r = rig();
    const id = crypto.randomUUID();
    const args = ["--as", "codex", "resume", id, "-C", r.cwd, "-c", `notify=["sh","${r.notify}"]`];
    const a = start(r, args);
    await ready(a, "›");
    paste(a, "say one");
    await waitFor(() => r.lines("notify.jsonl").length === 1);
    kill(a);
    const b = start(r, args);
    await ready(b, "›");
    paste(b, "say two");
    await waitFor(() => r.lines("notify.jsonl").length === 2);
    expect(rolloutFiles(r)).toHaveLength(1);
    const kinds = readFileSync(rolloutFiles(r)[0] ?? "", "utf8")
      .split("\n")
      .filter((l) => l !== "")
      .map((l) => (JSON.parse(l) as { payload: { type?: string } }).payload.type);
    expect(kinds.filter((k) => k === "task_complete")).toHaveLength(2);
  });
});

describe("fake agent, the Codex ready screen", () => {
  t("the start screen and the screen after a turn are the real one: the adapter says ready, and the busy line is gone", async () => {
    const r = rig();
    const n = codex(r);
    expect(await ready(n, "? for shortcuts")).toBe(true);
    expect(codexScreen(capture(n))).toBe("ready");
    expect(capture(n).trimEnd().split("\n").pop()).not.toBe("›");
    paste(n, "say hello");
    expect(await waitFor(() => r.lines("notify.jsonl").length === 1)).toBe(true);
    expect(await waitFor(() => codexScreen(capture(n)) === "ready")).toBe(true);
    expect(capture(n)).toContain("• hello");
    expect(capture(n)).not.toContain("esc to interrupt");
  });
});

describe("fake agent, start screens", () => {
  t("FAKE_SCREEN=trust shows the screen, and Enter exits with code 0", async () => {
    const r = rig();
    const n = claude(r, [], { FAKE_SCREEN: "trust" });
    expect(await ready(n, "No, exit")).toBe(true);
    expect(capture(n)).toContain("Yes, I trust this folder");
    rawKeys(n, "Enter");
    expect(await exited(n)).toBe(true);
    expect(exitCode(n)).toBe("0");
    expect(r.events("SessionStart")).toEqual([]);
  });

  t("FAKE_SCREEN=trust continues only on Down then Enter", async () => {
    const r = rig();
    const n = claude(r, [], { FAKE_SCREEN: "trust" });
    await ready(n, "No, exit");
    rawKeys(n, "Down");
    await ms(400);
    expect(exitCode(n)).toBeUndefined();
    expect(r.events("SessionStart")).toEqual([]);
    rawKeys(n, "Enter");
    expect(await ready(n, "(fake)")).toBe(true);
    expect(exitCode(n)).toBeUndefined();
    expect(await waitFor(() => r.events("SessionStart").length === 1)).toBe(true);
    paste(n, "say ok");
    expect(await waitFor(() => r.events("Stop").length === 1)).toBe(true);
  });

  t("FAKE_SCREEN=update shows the screen, and ESC continues", async () => {
    const r = rig();
    const n = codex(r, [], { FAKE_SCREEN: "update" });
    expect(await ready(n, "Update available")).toBe(true);
    expect(capture(n)).not.toContain("› Ask");
    await ms(300);
    expect(exitCode(n)).toBeUndefined();
    escape(n);
    expect(await ready(n, "OpenAI Codex")).toBe(true);
    expect(capture(n)).not.toContain("Update available");
    paste(n, "say hello");
    expect(await waitFor(() => r.lines("notify.jsonl").length === 1)).toBe(true);
  });

  t("FAKE_SCREEN=update: Enter runs the installer, which the fake shows and exits", async () => {
    const r = rig();
    const n = codex(r, [], { FAKE_SCREEN: "update" });
    await ready(n, "Update available");
    rawKeys(n, "Enter");
    expect(await exited(n)).toBe(true);
    expect(capture(n)).toContain("INSTALLER");
    expect(r.lines("notify.jsonl")).toEqual([]);
  });

  /** The keys the fake got, from its input log: `<epoch ms>\t<flavor>\t<phase>\t<kind>\t<text>`. */
  const inputLog = (r: Rig) => {
    const f = join(r.sessions, "fake-input.log");
    return existsSync(f)
      ? readFileSync(f, "utf8")
          .split("\n")
          .filter((l) => l !== "")
          .map((l) => {
            const [at, flavor, phase, kind, text] = l.split("\t");
            return { at: Number(at), flavor, phase, kind, text: text ?? "" };
          })
      : [];
  };

  t("FAKE_SCREEN=update,trust: the update question; after Escape about 400 ms of a bare prompt; then the trust question, which Enter answers", async () => {
    const r = rig();
    const n = codex(r, [], { FAKE_SCREEN: "update,trust" });
    expect(await ready(n, "Update available")).toBe(true);
    escape(n);
    // The bare prompt: the last line is the prompt glyph alone, and the real classifier does not take it for ready.
    expect(await ready(n, "OpenAI Codex")).toBe(true);
    expect(capture(n).trimEnd().split("\n").pop()?.trim()).toBe("›");
    expect(codexScreen(capture(n))).toBe("unknown");
    const bareAt = Date.now();
    expect(await ready(n, "Trust this folder?")).toBe(true);
    expect(Date.now() - bareAt).toBeGreaterThan(200);
    expect(Date.now() - bareAt).toBeLessThan(2000);
    expect(codexScreen(capture(n))).toBe("trust");
    await ms(300);
    expect(exitCode(n)).toBeUndefined();
    rawKeys(n, "Enter");
    expect(await ready(n, "? for shortcuts")).toBe(true);
    expect(codexScreen(capture(n))).toBe("ready");
  });

  t("FAKE_SCREEN=update,trust: a line pasted and sent in the bare prompt is kept and runs after the trust answer", async () => {
    const r = rig();
    const n = codex(r, [], { FAKE_SCREEN: "update,trust" });
    await ready(n, "Update available");
    escape(n);
    await ready(n, "OpenAI Codex");
    paste(n, "say kept"); // lands in the 400 ms of the bare prompt
    expect(await ready(n, "Trust this folder?")).toBe(true);
    await ms(300);
    expect(r.lines("notify.jsonl")).toEqual([]);
    rawKeys(n, "Enter");
    expect(await waitFor(() => r.lines("notify.jsonl").length === 1)).toBe(true);
    const log = inputLog(r);
    expect(log.filter((e) => e.kind === "paste").map((e) => [e.phase, e.text])).toEqual([["flash", "say kept"]]);
    expect(log.filter((e) => e.kind === "enter").map((e) => e.phase)).toEqual(["flash", "trust"]);
  });

  t("FAKE_SCREEN=update,ready,trust: the real ready screen for 400 ms, then the trust question", async () => {
    const r = rig();
    const n = codex(r, [], { FAKE_SCREEN: "update,ready,trust" });
    await ready(n, "Update available");
    escape(n);
    expect(await ready(n, "? for shortcuts")).toBe(true);
    expect(codexScreen(capture(n))).toBe("ready");
    expect(await ready(n, "Trust this folder?")).toBe(true);
    expect(codexScreen(capture(n))).toBe("trust");
  });

  t("the input log has every key the fake got, with the phase it was in", async () => {
    const r = rig();
    const n = codex(r, [], { FAKE_SCREEN: "trust" });
    await ready(n, "Trust this folder?");
    paste(n, "say a");
    await ms(200);
    expect(inputLog(r).map((e) => [e.phase, e.kind])).toEqual([["trust", "paste"], ["trust", "enter"]]);
    // The Enter of the paste answered the trust question: Codex continues, and the pasted text went nowhere.
    expect(await waitFor(() => codexScreen(capture(n)) === "ready")).toBe(true);
    expect(r.lines("notify.jsonl")).toEqual([]);
  });
});

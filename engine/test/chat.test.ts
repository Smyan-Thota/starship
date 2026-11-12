import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { ChatService, adminCwd } from "../src/chat.ts";
import { createChat, getChat, listChats, readMessages, saveChat } from "../src/chats.ts";
import { paths } from "../src/config.ts";
import type { AgentEvent, AgentPort, AgentSpec, Clock } from "../src/run/ports.ts";
import { SendError } from "../src/run/ports.ts";
import { hhmm } from "../src/time.ts";
import type { AgentStatus, AgentView, EngineEvent, MessageView, Tool } from "../src/types.ts";
import { drop, tempDir, tempHome } from "./helpers.ts";

/** An in-memory AgentPort. It records what the service does and lets the test fire the agent's events. */
class FakeAgents implements AgentPort {
  ensures: { chat: string; spec: AgentSpec }[] = [];
  sends: string[] = [];
  restarts: string[] = [];
  /** What `status` answers for the admin agent. null: no session was ever started. */
  state: AgentStatus | null = "idle";
  /** The next this many sends throw SendError. */
  failSends = 0;
  /** What `restart` resolves with. */
  resumed = true;
  /** When set, `restart` rejects with it: the session cannot be started. */
  restartError: Error | null = null;
  /** The status after `ensure` and `restart`. `needsYou`: the session came up at a trust question. */
  afterStart: AgentStatus = "idle";
  /** Runs inside `send`, before it resolves. */
  onSend: ((line: string) => void) | null = null;
  private listeners = new Set<(e: AgentEvent) => void>();

  get listenerCount(): number {
    return this.listeners.size;
  }

  async ensure(chat: string, spec: AgentSpec): Promise<void> {
    this.ensures.push({ chat, spec });
    this.state = this.afterStart;
  }
  async send(_chat: string, agent: string, line: string): Promise<void> {
    expect(agent).toBe("admin");
    // The port takes one line. A line with a newline is a bug of the caller.
    expect(line).not.toMatch(/[\r\n]/);
    if (this.failSends > 0) {
      this.failSends--;
      throw new SendError("tmux refused the paste");
    }
    this.sends.push(line);
    this.onSend?.(line);
  }
  async interrupt(): Promise<void> {}
  async restart(chat: string, _agent: string, _change?: { tool?: Tool; model?: string }): Promise<{ resumed: boolean }> {
    if (this.restartError) throw this.restartError;
    this.restarts.push(chat);
    this.state = this.afterStart;
    return { resumed: this.resumed };
  }
  async stop(): Promise<void> {}
  status(): AgentStatus | null {
    return this.state;
  }
  mark(): void {}
  agents(): AgentView[] {
    return [];
  }
  on(listener: (e: AgentEvent) => void): () => void {
    this.listeners.add(listener);
    return () => this.listeners.delete(listener);
  }
  fire(e: AgentEvent): void {
    for (const l of [...this.listeners]) l(e);
  }
}

const NOW = Date.UTC(2026, 10, 11, 14, 5);
const clock: Clock = { now: () => NOW };

let home: ReturnType<typeof tempHome>;
let scratch: string;
let agents: FakeAgents;
let published: EngineEvent[];
let services: ChatService[];
let changed: string[];

function service(): ChatService {
  const s = new ChatService({
    agents,
    publish: (e) => published.push(e),
    clock,
    adminSpec: (chatId) => ({ id: "admin", role: "admin", tool: "claude", model: "opus", cwd: adminCwd(chatId), promptFile: null }),
    changedFiles: () => changed,
  });
  services.push(s);
  return s;
}

/** A chat with a feature folder (a repo chat in Phase 1 has no worktree, only an adopted folder). */
function repoChat(title = "Recipe search"): { id: string; featureDir: string } {
  const featureDir = join(scratch, `feature-${Math.random().toString(36).slice(2)}`);
  mkdirSync(join(featureDir, "run"), { recursive: true });
  const chat = createChat({ title, folder: featureDir });
  return { id: chat.id, featureDir };
}

function bareChat(title = "Loose talk"): string {
  return createChat({ title }).id;
}

const turnStart = (chat: string, prompt: string, fromTerminal = false): AgentEvent => ({ type: "turnStart", chat, agent: "admin", prompt, fromTerminal });
const turnEnd = (chat: string, reply: string, fromTerminal = false): AgentEvent => ({ type: "turnEnd", chat, agent: "admin", reply, fromTerminal });
const ended = (chat: string): AgentEvent => ({ type: "ended", chat, agent: "admin" });

const msg = (chat: string, id: string): MessageView | undefined => readMessages(chat).find((m) => m.id === id);
const state = (chat: string, id: string) => msg(chat, id)?.state;
const outbox = (chat: string): { id: string; kind: string; state: string; text: string }[] => JSON.parse(readFileSync(join(paths.chat(chat), "outbox.json"), "utf8"));

beforeEach(() => {
  home = tempHome();
  scratch = tempDir("starship-chat-");
  agents = new FakeAgents();
  published = [];
  services = [];
  changed = [];
});

afterEach(() => {
  for (const s of services) s.dispose();
  drop(scratch);
  home.restore();
});

describe("chat", () => {
  test("a message is in messages.jsonl and outbox.json as queued before anything is pasted", async () => {
    const chat = bareChat();
    agents.state = "needsYou"; // nothing can be pasted: the admin agent waits for the owner
    const svc = service();
    const m = svc.send(chat, { id: "m1", text: "hello" });
    await svc.whenIdle();
    expect(m).toMatchObject({ id: "m1", who: "you", text: "hello", state: "queued", at: hhmm(new Date(NOW)) });
    expect(state(chat, "m1")).toBe("queued");
    expect(outbox(chat)).toEqual([{ id: "m1", kind: "owner", text: "hello", state: "queued" }]);
    expect(agents.sends).toEqual([]);
    expect(published).toContainEqual({ type: "chat", id: chat });
  });

  test("a message that is pasted becomes sent, and answered with the reply as an admin line", async () => {
    const chat = bareChat();
    const svc = service();
    svc.send(chat, { id: "m1", text: "hello" });
    await svc.whenIdle();
    expect(agents.sends).toEqual(["hello"]);
    expect(state(chat, "m1")).toBe("sent");

    agents.fire(turnStart(chat, "hello"));
    agents.fire(turnEnd(chat, "Hi, how can I help?"));
    expect(state(chat, "m1")).toBe("answered");
    const admin = readMessages(chat).filter((m) => m.who === "admin");
    expect(admin).toHaveLength(1);
    expect(admin[0]).toMatchObject({ text: "Hi, how can I help?" });
    expect(admin[0]?.fromTerminal).toBeUndefined();
    expect(outbox(chat)).toEqual([]);
  });

  test("A1: a message sent during a turn waits as queued and is pasted when the turn ends, oldest first", async () => {
    const chat = bareChat();
    const svc = service();
    svc.send(chat, { id: "m1", text: "one" });
    await svc.whenIdle();
    agents.fire(turnStart(chat, "one"));

    svc.send(chat, { id: "m2", text: "two" });
    svc.send(chat, { id: "m3", text: "three" });
    await svc.whenIdle();
    expect(agents.sends).toEqual(["one"]);
    expect(state(chat, "m2")).toBe("queued");
    expect(state(chat, "m3")).toBe("queued");

    agents.fire(turnEnd(chat, "r1"));
    await svc.whenIdle();
    expect(agents.sends).toEqual(["one", "two"]); // one at a time
    expect(state(chat, "m1")).toBe("answered");
    expect(state(chat, "m2")).toBe("sent");
    expect(state(chat, "m3")).toBe("queued");

    agents.fire(turnEnd(chat, "r2"));
    await svc.whenIdle();
    expect(agents.sends).toEqual(["one", "two", "three"]);
    agents.fire(turnEnd(chat, "r3"));
    expect(["m1", "m2", "m3"].map((id) => state(chat, id))).toEqual(["answered", "answered", "answered"]);
    expect(readMessages(chat).filter((m) => m.who === "admin").map((m) => m.text)).toEqual(["r1", "r2", "r3"]);
  });

  test("A2: when the admin session is gone it is restarted first, the chat shows Admin restarted, then the text is pasted", async () => {
    const chat = bareChat();
    agents.state = "stopped";
    agents.resumed = true;
    const svc = service();
    svc.send(chat, { id: "m1", text: "are you there" });
    await svc.whenIdle();
    expect(agents.restarts).toEqual([chat]);
    expect(agents.sends).toEqual(["are you there"]); // no pickup line: the conversation was resumed
    const log = readMessages(chat);
    expect(log.map((m) => [m.who, m.text])).toEqual([
      ["you", "are you there"],
      ["system", "Admin restarted"],
    ]);
    expect(state(chat, "m1")).toBe("sent");
  });

  test("a session that comes up at a question of the owner's: the message stays queued, nothing is pasted, and the started event sends it", async () => {
    const chat = bareChat();
    agents.state = null;
    agents.afterStart = "needsYou"; // the trust question
    const svc = service();
    svc.send(chat, { id: "m1", text: "hello" });
    await svc.whenIdle();
    expect(agents.ensures).toHaveLength(1);
    expect(agents.sends).toEqual([]);
    expect(state(chat, "m1")).toBe("queued"); // not notSent
    expect(outbox(chat)).toEqual([{ id: "m1", kind: "owner", text: "hello", state: "queued" }]);

    // The owner answers: the agent is ready, and the engine says it started.
    agents.state = "idle";
    agents.fire({ type: "started", chat, agent: "admin", resumed: false });
    await svc.whenIdle();
    expect(agents.sends).toEqual(["hello"]);
    expect(agents.ensures).toHaveLength(1);
    expect(state(chat, "m1")).toBe("sent");
  });

  test("a new session after a lost one, at a question of the owner's: the pickup line is not lost", async () => {
    const chat = bareChat();
    agents.state = "stopped";
    agents.resumed = false;
    agents.afterStart = "needsYou";
    const svc = service();
    svc.send(chat, { id: "m1", text: "hello" });
    await svc.whenIdle();
    expect(agents.sends).toEqual([]);
    agents.state = "idle";
    agents.fire({ type: "started", chat, agent: "admin", resumed: false });
    await svc.whenIdle();
    expect(agents.sends).toHaveLength(2);
    expect(agents.sends[0]).toContain("You are a new admin agent");
    expect(agents.sends[1]).toBe("hello");
  });

  test("A2: a session that was never started is ensured with the spec of adminSpec", async () => {
    const chat = bareChat();
    agents.state = null;
    const svc = service();
    svc.send(chat, { id: "m1", text: "first words" });
    await svc.whenIdle();
    expect(agents.ensures).toHaveLength(1);
    expect(agents.ensures[0]?.spec).toMatchObject({ id: "admin", role: "admin" });
    expect(agents.sends).toEqual(["first words"]);
    expect(readMessages(chat).some((m) => m.text === "Admin restarted")).toBe(false);
  });

  test("A3: when the resume fails the new session gets a pickup line, then the message", async () => {
    const { id: chat, featureDir } = repoChat();
    agents.state = "stopped";
    agents.resumed = false;
    const svc = service();
    svc.send(chat, { id: "m1", text: "carry on" });
    await svc.whenIdle();
    expect(agents.sends).toHaveLength(2);
    const [pickup, text] = agents.sends;
    expect(pickup).toContain(featureDir);
    expect(pickup).toContain("messages.jsonl");
    expect(text).toBe("carry on");
    expect(readMessages(chat).some((m) => m.text === "Admin restarted")).toBe(false);

    // The first turn end belongs to the pickup line. Only the second one answers the owner.
    agents.fire(turnEnd(chat, "ok, I read the folder"));
    expect(state(chat, "m1")).toBe("sent");
    expect(readMessages(chat).some((m) => m.who === "admin")).toBe(false);
    agents.fire(turnEnd(chat, "answer to carry on"));
    expect(state(chat, "m1")).toBe("answered");
    expect(readMessages(chat).filter((m) => m.who === "admin").map((m) => m.text)).toEqual(["answer to carry on"]);
  });

  test("A4: when agents.send throws SendError the message is notSent, and Retry pastes it", async () => {
    const chat = bareChat();
    agents.failSends = 1;
    const svc = service();
    svc.send(chat, { id: "m1", text: "please" });
    await svc.whenIdle();
    expect(state(chat, "m1")).toBe("notSent");
    expect(agents.sends).toEqual([]);

    const again = svc.retry(chat, "m1");
    expect(again.state).toBe("queued");
    await svc.whenIdle();
    expect(agents.sends).toEqual(["please"]);
    expect(state(chat, "m1")).toBe("sent");

    // Retry is for notSent and interrupted only.
    expect(() => svc.retry(chat, "m1")).toThrow();
    agents.fire(turnEnd(chat, "done it"));
    expect(state(chat, "m1")).toBe("answered");
    expect(() => svc.retry(chat, "m1")).toThrow();
    expect(() => svc.retry(chat, "nope")).toThrow();
    await svc.whenIdle();
    expect(agents.sends).toEqual(["please"]);
  });

  test("A4: a session that cannot start also gives notSent", async () => {
    const chat = bareChat();
    agents.state = "stopped";
    agents.restartError = new Error("no tmux");
    const svc = service();
    svc.send(chat, { id: "m1", text: "x" });
    await svc.whenIdle();
    expect(state(chat, "m1")).toBe("notSent");
    expect(agents.sends).toEqual([]);
  });

  test("A5: a message with more than one line goes to run/inbox/<id>.md and the pasted line points at it", async () => {
    const { id: chat, featureDir } = repoChat();
    const svc = service();
    const text = "Plan change:\n- drop the export\n- keep the filter\n";
    svc.send(chat, { id: "m-long", text });
    await svc.whenIdle();
    const file = join(featureDir, "run", "inbox", "m-long.md");
    expect(readFileSync(file, "utf8")).toBe(text);
    expect(agents.sends).toHaveLength(1);
    expect(agents.sends[0]).toContain(file);
    // The chat log keeps the owner's own words, not the pointer.
    expect(msg(chat, "m-long")?.text).toBe(text);
  });

  test("A5: a one-line message of more than 400 characters goes to a file; exactly 400 is pasted as it is", async () => {
    const { id: chat, featureDir } = repoChat();
    const svc = service();
    const exact = "a".repeat(400);
    svc.send(chat, { id: "m400", text: exact });
    await svc.whenIdle();
    expect(agents.sends).toEqual([exact]);
    expect(existsSync(join(featureDir, "run", "inbox", "m400.md"))).toBe(false);
    agents.fire(turnEnd(chat, "ok"));

    const long = "b".repeat(401);
    svc.send(chat, { id: "m401", text: long });
    await svc.whenIdle();
    const file = join(featureDir, "run", "inbox", "m401.md");
    expect(readFileSync(file, "utf8").trim()).toBe(long);
    expect(agents.sends[1]).toContain(file);
    expect(agents.sends[1]?.length).toBeLessThan(400);
  });

  test("A5: a chat with no repo keeps the file in its own inbox folder", async () => {
    const chat = bareChat();
    const svc = service();
    svc.send(chat, { id: "m1", text: "line one\nline two" });
    await svc.whenIdle();
    const file = join(paths.chat(chat), "inbox", "m1.md");
    expect(readFileSync(file, "utf8")).toBe("line one\nline two\n");
    expect(agents.sends[0]).toContain(file);
  });

  test("A6: the same id while queued, sent or answered returns the message and pastes nothing more", async () => {
    const chat = bareChat();
    const svc = service();
    svc.send(chat, { id: "m1", text: "once" });
    await svc.whenIdle();
    agents.fire(turnStart(chat, "once"));

    svc.send(chat, { id: "m2", text: "later" }); // queued behind the turn
    const queuedTwice = svc.send(chat, { id: "m2", text: "later" });
    expect(queuedTwice.state).toBe("queued");

    const sentTwice = svc.send(chat, { id: "m1", text: "once" });
    expect(sentTwice.state).toBe("sent");
    await svc.whenIdle();
    expect(agents.sends).toEqual(["once"]);

    agents.fire(turnEnd(chat, "r1"));
    await svc.whenIdle();
    const answeredTwice = svc.send(chat, { id: "m1", text: "once" });
    expect(answeredTwice.state).toBe("answered");
    await svc.whenIdle();
    expect(agents.sends).toEqual(["once", "later"]);
    expect(readMessages(chat).filter((m) => m.who === "you").map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(outbox(chat).map((e) => e.id)).toEqual(["m2"]);
  });

  test("A6: a notSent message with the same id is not pasted again by send; only Retry does it", async () => {
    const chat = bareChat();
    agents.failSends = 1;
    const svc = service();
    svc.send(chat, { id: "m1", text: "x" });
    await svc.whenIdle();
    expect(svc.send(chat, { id: "m1", text: "x" }).state).toBe("notSent");
    await svc.whenIdle();
    expect(agents.sends).toEqual([]);
  });

  test("A7: after an engine restart a queued message goes out in order, and a sent one with no reply is interrupted", async () => {
    const chat = bareChat();
    const first = service();
    first.send(chat, { id: "m1", text: "sent before the crash" });
    await first.whenIdle();
    agents.fire(turnStart(chat, "sent before the crash"));
    first.send(chat, { id: "m2", text: "second" });
    first.send(chat, { id: "m3", text: "third" });
    await first.whenIdle();
    expect(agents.sends).toEqual(["sent before the crash"]);
    first.dispose(); // the engine stops

    agents = new FakeAgents();
    const second = service();
    expect(outbox(chat).map((e) => [e.id, e.state])).toEqual([
      ["m1", "sent"],
      ["m2", "queued"],
      ["m3", "queued"],
    ]);
    await second.recover();
    await second.whenIdle();
    expect(state(chat, "m1")).toBe("interrupted"); // nothing is pasted again for it
    expect(agents.sends).toEqual(["second"]);
    expect(state(chat, "m2")).toBe("sent");
    expect(state(chat, "m3")).toBe("queued");

    agents.fire(turnEnd(chat, "r2"));
    await second.whenIdle();
    expect(agents.sends).toEqual(["second", "third"]);
  });

  test("A7: a chat whose files cannot be read does not keep the other chats' messages from going out", async () => {
    const good = bareChat("Good");
    writeFileSync(join(paths.chat(good), "outbox.json"), JSON.stringify([{ id: "g1", kind: "owner", text: "for the good chat", state: "queued" }]));
    await Bun.sleep(5); // the chat that was made last is listed first
    const bad = bareChat("Bad");
    writeFileSync(join(paths.chat(bad), "outbox.json"), JSON.stringify([{ id: "b1", kind: "owner", text: "for the bad chat", state: "queued" }]));
    rmSync(join(paths.chat(bad), "messages.jsonl"), { force: true });
    mkdirSync(join(paths.chat(bad), "messages.jsonl")); // a folder where the log should be: every read and write of it throws
    expect(listChats()[0]?.id).toBe(bad);
    const svc = service();
    await svc.recover();
    await svc.whenIdle();
    expect(msg(good, "g1")).toMatchObject({ who: "you", text: "for the good chat", state: "sent" });
    expect(agents.sends).toContain("for the good chat");
  });

  test("A7: an outbox entry that never reached messages.jsonl is written to it, then sent", async () => {
    const chat = bareChat();
    writeFileSync(join(paths.chat(chat), "outbox.json"), JSON.stringify([{ id: "lost", kind: "owner", text: "half written", state: "queued" }]));
    const svc = service();
    await svc.recover();
    await svc.whenIdle();
    expect(msg(chat, "lost")).toMatchObject({ who: "you", text: "half written" });
    expect(agents.sends).toEqual(["half written"]);
  });

  test("A9: a turn that ends with no reply text shows Done and the files that changed", async () => {
    const chat = bareChat();
    changed = ["docs/features/recipes/PLAN.md", "docs/features/recipes/TASKS.md"];
    const svc = service();
    svc.send(chat, { id: "m1", text: "update the plan" });
    await svc.whenIdle();
    agents.fire(turnEnd(chat, "   "));
    const admin = readMessages(chat).find((m) => m.who === "admin");
    expect(admin).toMatchObject({ text: "Done", files: ["docs/features/recipes/PLAN.md", "docs/features/recipes/TASKS.md"] });
    expect(state(chat, "m1")).toBe("answered");
  });

  test("A11: a chat with no repo runs the admin agent in its own folder and has no feature folder", async () => {
    const chat = bareChat();
    expect(getChat(chat)).toMatchObject({ repo: null, featureDir: null, stage: null });
    expect(adminCwd(chat)).toBe(join(home.dir, "chats", chat));
    agents.state = null;
    const svc = service();
    svc.send(chat, { id: "m1", text: "just talking" });
    await svc.whenIdle();
    expect(agents.ensures[0]?.spec.cwd).toBe(join(home.dir, "chats", chat));
    expect(readMessages(chat)[0]?.stage).toBeNull();

    // A new session for this chat is told about the chat folder, not about a feature folder.
    agents.fire(ended(chat));
    agents.state = "stopped";
    agents.resumed = false;
    svc.retry(chat, "m1");
    await svc.whenIdle();
    expect(agents.sends[1]).toContain(join(home.dir, "chats", chat, "messages.jsonl"));
    expect(agents.sends[1]).not.toContain("feature folder");
    expect(existsSync(join(home.dir, "chats", chat, "run"))).toBe(false);
  });

  test("A13: the admin session ends after the paste and before the reply: interrupted, nothing is pasted again, Retry works", async () => {
    const chat = bareChat();
    const svc = service();
    svc.send(chat, { id: "m1", text: "do the thing" });
    await svc.whenIdle();
    agents.fire(turnStart(chat, "do the thing"));
    agents.state = "stopped";
    agents.fire(ended(chat));
    await svc.whenIdle();
    expect(state(chat, "m1")).toBe("interrupted");
    expect(agents.sends).toEqual(["do the thing"]);
    expect(agents.restarts).toEqual([]);

    const again = svc.retry(chat, "m1");
    expect(again.state).toBe("queued");
    await svc.whenIdle();
    expect(agents.restarts).toEqual([chat]); // restart with resume, then paste
    expect(agents.sends).toEqual(["do the thing", "do the thing"]);
    agents.fire(turnEnd(chat, "done"));
    expect(state(chat, "m1")).toBe("answered");
  });

  test("A13: a turn end that comes while the paste is still being confirmed is not lost", async () => {
    const chat = bareChat();
    agents.onSend = () => agents.fire(turnEnd(chat, "fast reply"));
    const svc = service();
    svc.send(chat, { id: "m1", text: "quick" });
    await svc.whenIdle();
    expect(state(chat, "m1")).toBe("answered");
    expect(outbox(chat)).toEqual([]);
  });

  test("A15: a line from the engine waits behind the owner's messages while the admin agent is in a turn, and is pasted once", async () => {
    const chat = bareChat();
    const svc = service();
    svc.send(chat, { id: "m1", text: "owner words" });
    await svc.whenIdle();
    agents.fire(turnStart(chat, "owner words"));
    svc.send(chat, { id: "m2", text: "more owner words" });
    svc.tellAdmin(chat, "q3", "Worker A asks Q3: include archived recipes?");
    svc.tellAdmin(chat, "q3", "Worker A asks Q3: include archived recipes?"); // the same line twice
    await svc.whenIdle();
    expect(agents.sends).toEqual(["owner words"]);

    agents.fire(turnEnd(chat, "r1"));
    await svc.whenIdle();
    expect(agents.sends).toEqual(["owner words", "more owner words"]);
    agents.fire(turnEnd(chat, "r2"));
    await svc.whenIdle();
    expect(agents.sends).toEqual(["owner words", "more owner words", "Worker A asks Q3: include archived recipes?"]);
    agents.fire(turnEnd(chat, "")); // no reply to an engine line: nothing to show, and no "Done"
    await svc.whenIdle();
    svc.tellAdmin(chat, "q3", "Worker A asks Q3: include archived recipes?");
    await svc.whenIdle();
    expect(agents.sends).toHaveLength(3);

    // It never shows as an owner message.
    expect(readMessages(chat).filter((m) => m.who === "you").map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(readMessages(chat).some((m) => m.text.includes("Q3"))).toBe(false);
    expect(outbox(chat)).toEqual([]);
  });

  test("A15: a line from the engine waits while the chat is halted and goes out when pump runs after Resume", async () => {
    const chat = bareChat();
    const stored = getChat(chat);
    saveChat({ ...stored, halted: "14:05" });
    const svc = service();
    svc.tellAdmin(chat, "q1", "Worker B asks Q1: which locale?");
    svc.send(chat, { id: "m1", text: "owner still talks to the admin agent" });
    await svc.whenIdle();
    expect(agents.sends).toEqual(["owner still talks to the admin agent"]);
    agents.fire(turnEnd(chat, "ok"));
    await svc.whenIdle();
    expect(agents.sends).toHaveLength(1);

    saveChat({ ...getChat(chat), halted: null });
    await svc.pump(chat);
    expect(agents.sends).toEqual(["owner still talks to the admin agent", "Worker B asks Q1: which locale?"]);
  });

  test("A15: a line from the engine, with the admin session gone, restarts it first", async () => {
    const chat = bareChat();
    agents.state = "stopped";
    const svc = service();
    svc.tellAdmin(chat, "q2", "Worker A asks Q2: x?");
    await svc.whenIdle();
    expect(agents.restarts).toEqual([chat]);
    expect(agents.sends).toEqual(["Worker A asks Q2: x?"]);
  });

  test("a line from the engine that is long goes to a file like an owner message", async () => {
    const { id: chat, featureDir } = repoChat();
    const svc = service();
    svc.tellAdmin(chat, "q9", "Worker A asks Q9:\nline one\nline two");
    await svc.whenIdle();
    expect(readFileSync(join(featureDir, "run", "inbox", "q9.md"), "utf8")).toContain("line two");
    expect(agents.sends[0]).toContain(join(featureDir, "run", "inbox", "q9.md"));
  });

  test("a turn typed in the terminal shows in the chat, marked fromTerminal, and so does its reply", async () => {
    const chat = bareChat();
    const svc = service();
    agents.fire(turnStart(chat, "typed by hand", true));
    svc.send(chat, { id: "m1", text: "waits for the terminal turn" });
    await svc.whenIdle();
    expect(agents.sends).toEqual([]);
    agents.fire(turnEnd(chat, "reply to the hand", true));
    await svc.whenIdle();
    const log = readMessages(chat);
    expect(log[0]).toMatchObject({ who: "you", text: "typed by hand", fromTerminal: true });
    expect(log[0]?.state).toBeUndefined();
    expect(log[1]).toMatchObject({ who: "you", id: "m1" });
    expect(log[2]).toMatchObject({ who: "admin", text: "reply to the hand", fromTerminal: true });
    expect(agents.sends).toEqual(["waits for the terminal turn"]);
  });

  test("a needsYou event of the admin agent adds the line Admin needs you; another agent's does not", () => {
    const chat = bareChat();
    service();
    agents.fire({ type: "needsYou", chat, agent: "worker-a", reason: "permission", message: "x" });
    expect(readMessages(chat)).toEqual([]);
    agents.fire({ type: "needsYou", chat, agent: "admin", reason: "permission", message: "may I run rm" });
    expect(readMessages(chat).map((m) => [m.who, m.text])).toEqual([["system", "Admin needs you"]]);
  });

  test("events for an unknown chat or from another agent are ignored", () => {
    const chat = bareChat();
    service();
    agents.fire(turnEnd("no-such-chat", "x"));
    agents.fire({ type: "turnEnd", chat, agent: "worker-a", reply: "not mine", fromTerminal: false });
    agents.fire({ type: "usage", tool: "claude", usage: { windows: [], updatedAt: null } as never });
    expect(readMessages(chat)).toEqual([]);
  });

  test("dispose ends the subscription to agents.on", async () => {
    const chat = bareChat();
    const svc = service();
    expect(agents.listenerCount).toBe(1);
    svc.dispose();
    expect(agents.listenerCount).toBe(0);
    agents.fire(turnStart(chat, "typed", true));
    expect(readMessages(chat)).toEqual([]);
  });

  test("send refuses an empty text and an unknown chat", () => {
    const chat = bareChat();
    const svc = service();
    expect(() => svc.send(chat, { id: "m1", text: "  " })).toThrow();
    expect(() => svc.send("no-such-chat", { id: "m1", text: "x" })).toThrow();
  });
});

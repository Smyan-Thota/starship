import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendNote, parseNotes } from "../src/folder/notes.ts";
import { writeRunFile } from "../src/folder/write.ts";
import { NoteDelivery } from "../src/run/notes-loop.ts";
import { Orchestrator } from "../src/run/orchestrator.ts";
import type { AgentEvent, AgentPort, AgentSpec } from "../src/run/ports.ts";
import { readRunState } from "../src/run/state.ts";
import { hhmm } from "../src/time.ts";
import type { AgentStatus, AgentView } from "../src/types.ts";
import { drop, tempDir } from "./helpers.ts";

const CHAT = "chat-1";
const NOW = Date.UTC(2026, 10, 11, 12, 0, 0);

// ───────────────────────────── fakes ─────────────────────────────

class FakeAgents implements AgentPort {
  listeners = new Set<(e: AgentEvent) => void>();
  ensured: string[] = [];
  sent: { agent: string; line: string }[] = [];
  failSend = false;
  async ensure(_chat: string, spec: AgentSpec): Promise<void> {
    this.ensured = [...this.ensured, spec.id];
  }
  async send(_chat: string, agent: string, line: string): Promise<void> {
    if (this.failSend) throw new Error("tmux refuses");
    this.sent = [...this.sent, { agent, line }];
  }
  async interrupt(): Promise<void> {}
  async restart(): Promise<{ resumed: boolean }> {
    return { resumed: true };
  }
  async stop(): Promise<void> {}
  status(): AgentStatus | null {
    return "idle";
  }
  mark(): void {}
  agents(): AgentView[] {
    return [];
  }
  on(l: (e: AgentEvent) => void): () => void {
    this.listeners.add(l);
    return () => this.listeners.delete(l);
  }
  /** The orchestrator's turn ends: the test plays the part of the agent. */
  turnEnd(agent = "orchestrator"): void {
    for (const l of this.listeners) l({ type: "turnEnd", chat: CHAT, agent, reply: "ok", fromTerminal: false });
  }
}

const SPEC: AgentSpec = { id: "orchestrator", role: "orchestrator", tool: "claude", model: "m", cwd: "/tmp", promptFile: null };

const TASKS = [
  "# TASKS",
  "",
  "## Phase 1 — Part 1",
  "",
  "- [x] T001 Do T001 — `src/a.ts` — verify: `bun test a` (in scope #1)",
  "- [ ] T002 Do T002 — `src/b.ts` — verify: `bun test b` (in scope #1)",
  "",
].join("\n");

interface H {
  feat: string;
  agents: FakeAgents;
  notes: NoteDelivery;
  orch: Orchestrator;
  flags: { started: boolean; inTurn: boolean; halted: boolean };
  loopCalls: string[];
  states: Record<string, string>;
  add(said: string, note: string, to?: "orchestrator" | "plan"): number;
  text(): string;
  status(n: number): string | undefined;
  inbox(): string[];
}

let dirs: string[] = [];
afterEach(() => {
  for (const d of dirs) drop(d);
  dirs = [];
});

function mk(): H {
  const root = tempDir("starship-notes-loop-");
  dirs.push(root);
  const feat = join(root, "docs", "features", "demo");
  mkdirSync(join(feat, "run"), { recursive: true });
  writeFileSync(join(feat, "TASKS.md"), TASKS);
  const agents = new FakeAgents();
  const flags = { started: false, inTurn: false, halted: false };
  const loopCalls: string[] = [];
  const states: Record<string, string> = { T001: "verified", T002: "working" };
  const chat = () => ({ featureDir: feat, halted: flags.halted });
  const clock = { now: () => NOW };
  const notes = new NoteDelivery({
    agents,
    clock,
    chat,
    buildStarted: () => flags.started,
    taskInTurn: () => flags.inTurn,
    orchestratorSpec: () => SPEC,
    publish: () => {},
  });
  const orch = new Orchestrator({
    agents,
    clock,
    chat,
    spec: () => SPEC,
    loop: {
      retry: (c, t, by) => void loopCalls.push(`retry ${c} ${t} ${by}`),
      block: (c, t, r) => void loopCalls.push(`block ${c} ${t} ${r}`),
      drop: (c, t, r, by) => void loopCalls.push(`drop ${c} ${t} ${r} ${by}`),
      taskAdded: (c) => void loopCalls.push(`taskAdded ${c}`),
      undecided: (c, t) => void loopCalls.push(`undecided ${c} ${t}`),
      checkpointUndecided: (c) => void loopCalls.push(`checkpointUndecided ${c}`),
    },
    taskState: (_c, t) => states[t] ?? null,
    publish: () => {},
  });
  const file = join(feat, "run", "handoffs.md");
  return {
    feat,
    agents,
    notes,
    orch,
    flags,
    loopCalls,
    states,
    add(said, note, to = "orchestrator") {
      let n = 0;
      writeRunFile(file, (old) => {
        const r = appendNote(old, { at: "2026-11-11 12:00", stage: "build", to, said, note });
        n = r.note.n;
        return r.text;
      });
      return n;
    },
    text: () => readFileSync(file, "utf8"),
    status: (n) => parseNotes(readFileSync(file, "utf8")).notes.find((x) => x.n === n)?.status,
    inbox: () => {
      const d = join(feat, "run", "inbox");
      return existsSync(d) ? readdirSync(d).sort() : [];
    },
  };
}

const lastLine = (h: H) => h.agents.sent[h.agents.sent.length - 1]?.line ?? "";
/** The inbox file that the pasted line points at. */
function pointed(h: H): string {
  const m = lastLine(h).match(/(\/\S+\.md)/);
  if (!m?.[1]) throw new Error(`the pasted line points at no file: ${lastLine(h)}`);
  return readFileSync(m[1], "utf8");
}

// ───────────────────────────── edge rows ─────────────────────────────

describe("Notes in the loop", () => {
  test("B1: a note recorded while a task runs waits for the next task boundary, and a note recorded when no task runs goes at once", async () => {
    const h = mk();
    h.flags.started = true;
    h.flags.inTurn = true;
    const n1 = h.add("match numbers without the dash", "Match recipe numbers with or without the dash.");
    await h.notes.recorded(CHAT, n1);
    expect(h.agents.sent).toHaveLength(0);
    expect(h.status(n1)).toBe("queued");
    expect(readRunState(h.feat).notes[String(n1)]).toBeUndefined();

    // The boundary: the check of any task ended.
    h.flags.inTurn = false;
    await h.notes.boundary(CHAT);
    expect(h.agents.sent).toHaveLength(1);
    expect(lastLine(h)).not.toContain("\n");
    expect(pointed(h)).toContain("Match recipe numbers with or without the dash.");
    expect(readRunState(h.feat).notes[String(n1)]).toEqual({ deliveries: 1, reading: true });

    // No task in a turn and the build has started: the next note goes at once, after the first one is read.
    h.agents.turnEnd();
    const n2 = h.add("also add a log line", "Add a log line.");
    await h.notes.recorded(CHAT, n2);
    expect(h.agents.sent).toHaveLength(2);
    expect(pointed(h)).toContain("Add a log line.");
  });

  test("B2: a note to the orchestrator waits for the build to start, and a note to the plan is never delivered", async () => {
    const h = mk();
    const n1 = h.add("use postgres", "Use postgres, not sqlite.");
    const n2 = h.add("rename the spec", "SPEC.md was renamed.", "plan");
    await h.notes.recorded(CHAT, n1);
    await h.notes.recorded(CHAT, n2);
    expect(h.agents.sent).toHaveLength(0);
    expect(h.agents.ensured).toHaveLength(0);
    expect(h.status(n1)).toBe("queued");

    // The build starts: that is a boundary.
    h.flags.started = true;
    await h.notes.boundary(CHAT);
    expect(h.agents.sent).toHaveLength(1);
    expect(h.agents.ensured).toEqual(["orchestrator"]);
    expect(pointed(h)).toContain("Use postgres, not sqlite.");
    expect(pointed(h)).not.toContain("SPEC.md was renamed.");
  });

  test("B6: two notes that contradict go in one turn in number order, with the line that says the later note wins", async () => {
    const h = mk();
    h.flags.started = true;
    h.flags.inTurn = true;
    const n1 = h.add("make the button blue", "Make the button blue.");
    const n2 = h.add("no, make it green", "Make the button green.");
    await h.notes.recorded(CHAT, n2);
    await h.notes.boundary(CHAT);
    expect(h.agents.sent).toHaveLength(1);
    const body = pointed(h);
    expect(body).toContain("A later note wins over an earlier one.");
    expect(body.indexOf("Make the button blue.")).toBeGreaterThan(-1);
    expect(body.indexOf("Make the button blue.")).toBeLessThan(body.indexOf("Make the button green."));
    expect(body).toContain("make the button blue");
    expect(body).toContain("no, make it green");
    expect(body.indexOf(`Note ${n1}`)).toBeLessThan(body.indexOf(`Note ${n2}`));
    const run = readRunState(h.feat).notes;
    expect(run[String(n1)]).toEqual({ deliveries: 1, reading: true });
    expect(run[String(n2)]).toEqual({ deliveries: 1, reading: true });

    h.notes.ack(CHAT, [n1, n2]);
    h.agents.turnEnd();
    expect(h.status(n1)).toBe("read");
    expect(h.status(n2)).toBe("read");
    const read = parseNotes(h.text()).notes.map((n) => n.readAt);
    expect(read).toEqual([hhmm(new Date(NOW)), hhmm(new Date(NOW))]);
    expect(readRunState(h.feat).notes[String(n1)]).toEqual({ deliveries: 1, reading: false });
  });

  test("B7: a note about a running task is delivered, and the orchestrator adds a follow-up task while the task finishes", async () => {
    const h = mk();
    h.flags.started = true;
    h.flags.inTurn = true;
    expect(h.states.T002).toBe("working");
    const n = h.add("T002 must also trim spaces", "T002: also trim spaces from the input.");
    await h.notes.recorded(CHAT, n);
    await h.notes.boundary(CHAT);
    expect(pointed(h)).toContain("T002: also trim spaces from the input.");

    // The fake orchestrator turn: it runs `starship task add`, then `starship note ack`.
    const r = h.orch.taskCommand(CHAT, { agent: "orchestrator", role: "orchestrator" }, { cmd: "add", phase: 1, text: "Trim spaces after T002", files: ["src/b.ts"], verify: "bun test b", parallel: false });
    expect(r).toEqual({ ok: true, id: "T003" });
    h.notes.ack(CHAT, [n]);
    h.agents.turnEnd();

    const tasks = readFileSync(join(h.feat, "TASKS.md"), "utf8");
    expect(tasks).toContain("- [ ] T003 Trim spaces after T002 — `src/b.ts` — verify: `bun test b`");
    expect(tasks).toContain("- [ ] T002 Do T002"); // the running task is untouched
    expect(h.loopCalls).toContain(`taskAdded ${CHAT}`);
    expect(h.status(n)).toBe("read");
  });

  test("B8: a note about a verified task is delivered, and the orchestrator adds a redo task that names it", async () => {
    const h = mk();
    h.flags.started = true;
    const n = h.add("T001 got the dash wrong", "T001 was wrong: redo the dash handling.");
    await h.notes.recorded(CHAT, n);
    expect(h.agents.sent).toHaveLength(1);
    expect(pointed(h)).toContain("T001 was wrong: redo the dash handling.");

    // T001 is verified, so edit is refused and a new task is the only way.
    const refused = h.orch.taskCommand(CHAT, { agent: "orchestrator", role: "orchestrator" }, { cmd: "edit", id: "T001", text: "x" });
    expect(refused.ok).toBe(false);
    const r = h.orch.taskCommand(CHAT, { agent: "orchestrator", role: "orchestrator" }, { cmd: "add", phase: 1, text: "Redo T001: handle the dash", files: ["src/a.ts"], verify: "bun test a", parallel: false });
    expect(r).toEqual({ ok: true, id: "T003" });
    h.notes.ack(CHAT, [n]);
    h.agents.turnEnd();

    expect(readFileSync(join(h.feat, "TASKS.md"), "utf8")).toContain("- [ ] T003 Redo T001: handle the dash — `src/a.ts`");
    expect(h.loopCalls).toContain(`taskAdded ${CHAT}`);
    expect(h.status(n)).toBe("read");
  });

  test("B9: a note delivered 3 times with no ack is not delivered again, stays queued, and shows under needs you", async () => {
    const h = mk();
    h.flags.started = true;
    const n = h.add("do the thing", "Do the thing.");
    expect(h.notes.needsYou(CHAT)).toEqual([]);

    for (let i = 1; i <= 3; i++) {
      await h.notes.boundary(CHAT);
      expect(h.agents.sent).toHaveLength(i);
      expect(readRunState(h.feat).notes[String(n)]).toEqual({ deliveries: i, reading: true });
      h.agents.turnEnd(); // the orchestrator never runs `starship note ack`
      expect(h.status(n)).toBe("queued");
      expect(readRunState(h.feat).notes[String(n)]).toEqual({ deliveries: i, reading: false });
    }

    await h.notes.boundary(CHAT);
    await h.notes.resumed(CHAT);
    expect(h.agents.sent).toHaveLength(3);
    expect(h.status(n)).toBe("queued");
    expect(h.notes.needsYou(CHAT).map((x) => x.n)).toEqual([n]);
  });

  test("B13: Undo is refused with Being read from the paste to the end of the turn, and an Undo before the paste wins", async () => {
    const h = mk();
    h.flags.started = true;
    const n1 = h.add("first", "First note.");
    const n2 = h.add("second", "Second note.");
    const n3 = h.add("third", "Third note.");

    // Before the paste: the note leaves the delivery.
    expect(h.notes.undo(CHAT, n2)).toBeNull();
    expect(h.status(n2)).toBe("undone");
    await h.notes.boundary(CHAT);
    const body = pointed(h);
    expect(body).toContain("First note.");
    expect(body).toContain("Third note.");
    expect(body).not.toContain("Second note.");
    expect(readRunState(h.feat).notes[String(n2)]).toBeUndefined();

    // During the turn.
    expect(h.notes.undo(CHAT, n1)).toBe("Being read");
    expect(h.status(n1)).toBe("queued");

    // The turn ends: n1 acked, n3 not.
    h.notes.ack(CHAT, [n1]);
    h.agents.turnEnd();
    expect(h.notes.undo(CHAT, n1)).toBe("Already read");
    expect(h.status(n1)).toBe("read");
    // Not acked: queued again, and Undo works again.
    expect(h.status(n3)).toBe("queued");
    expect(h.notes.undo(CHAT, n3)).toBeNull();
    expect(h.status(n3)).toBe("undone");
  });
});

describe("NoteDelivery", () => {
  test("a halted chat delivers nothing, and Resume delivers what waits when the rule allows", async () => {
    const h = mk();
    h.flags.started = true;
    h.flags.halted = true;
    const n = h.add("go", "Go on.");
    await h.notes.recorded(CHAT, n);
    await h.notes.boundary(CHAT);
    expect(h.agents.sent).toHaveLength(0);

    h.flags.halted = false;
    h.flags.inTurn = true;
    await h.notes.resumed(CHAT);
    expect(h.agents.sent).toHaveLength(0); // a task is in a turn: wait for its boundary

    h.flags.inTurn = false;
    await h.notes.resumed(CHAT);
    expect(h.agents.sent).toHaveLength(1);
  });

  test("never a second delivery while one is read; a note recorded meanwhile goes when that turn ends", async () => {
    const h = mk();
    h.flags.started = true;
    const n1 = h.add("one", "One.");
    await h.notes.boundary(CHAT);
    const n2 = h.add("two", "Two.");
    await h.notes.recorded(CHAT, n2);
    await h.notes.boundary(CHAT);
    expect(h.agents.sent).toHaveLength(1);

    h.notes.ack(CHAT, [n1]);
    h.agents.turnEnd();
    await h.notes.idle();
    expect(h.agents.sent).toHaveLength(2);
    expect(pointed(h)).toContain("Two.");
    expect(h.status(n1)).toBe("read");
  });

  test("a paste that tmux refuses leaves the note queued and counts no delivery", async () => {
    const h = mk();
    h.flags.started = true;
    const n = h.add("one", "One.");
    h.agents.failSend = true;
    await h.notes.boundary(CHAT);
    expect(h.status(n)).toBe("queued");
    expect(readRunState(h.feat).notes[String(n)]).toEqual({ deliveries: 0, reading: false });
    expect(h.notes.undo(CHAT, n)).toBeNull();
  });

  test("an event of another agent does not end the delivery", async () => {
    const h = mk();
    h.flags.started = true;
    const n = h.add("one", "One.");
    await h.notes.boundary(CHAT);
    h.agents.turnEnd("worker-a");
    expect(readRunState(h.feat).notes[String(n)]?.reading).toBe(true);
  });
});

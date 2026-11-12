import { describe, expect, test } from "bun:test";
import {
  AGENT_EVENTS,
  AGENT_STATES,
  BUILD_EVENTS,
  BUILD_STATES,
  NOTE_EVENTS,
  NOTE_STATES,
  NOTE_TARGETS,
  TASK_EVENTS,
  TASK_STATES,
  agentTable,
  allPairs,
  buildTable,
  missingEntries,
  nextAgent,
  nextBuild,
  nextNote,
  nextTask,
  noteTable,
  silentChoices,
  taskTable,
  type AgentEvent,
  type AgentResult,
  type BuildEvent,
  type BuildResult,
  type Invalid,
  type NoteEvent,
  type NoteResult,
  type NoteState,
  type TaskCtx,
  type TaskEvent,
  type TaskResult,
} from "../src/run/states.ts";
import type { AgentStatus, TaskState } from "../src/types.ts";
import type { NoteTarget } from "../src/folder/notes.ts";

const isInvalid = (r: object): r is Invalid => "invalid" in r;

function task(state: TaskState, event: TaskEvent, ctx: TaskCtx = { attempts: 0, escalations: 0 }): TaskResult {
  const r = nextTask(state, event, ctx);
  if (isInvalid(r)) throw new Error(`task ${state} + ${event} is invalid: ${r.invalid}`);
  return r;
}
const taskNo = (state: TaskState, event: TaskEvent, ctx: TaskCtx = { attempts: 0, escalations: 0 }): string => {
  const r = nextTask(state, event, ctx);
  if (!isInvalid(r)) throw new Error(`task ${state} + ${event} should be invalid, got ${r.state}`);
  return r.invalid;
};
function agent(status: AgentStatus, event: AgentEvent, ctx?: { inTurn?: boolean }): AgentResult {
  const r = nextAgent(status, event, ctx);
  if (isInvalid(r)) throw new Error(`agent ${status} + ${event} is invalid: ${r.invalid}`);
  return r;
}
const agentNo = (status: AgentStatus, event: AgentEvent): string => {
  const r = nextAgent(status, event);
  if (!isInvalid(r)) throw new Error(`agent ${status} + ${event} should be invalid, got ${r.state}`);
  return r.invalid;
};
const idle = { deliveries: 0, beingRead: false, halted: false };
function note(target: NoteTarget, status: NoteState, event: NoteEvent, ctx = idle): NoteResult {
  const r = nextNote(target, status, event, ctx);
  if (isInvalid(r)) throw new Error(`note ${target} ${status} + ${event} is invalid: ${r.invalid}`);
  return r;
}
const noteNo = (target: NoteTarget, status: NoteState, event: NoteEvent, ctx = idle): string => {
  const r = nextNote(target, status, event, ctx);
  if (!isInvalid(r)) throw new Error(`note ${target} ${status} + ${event} should be invalid, got ${r.status}`);
  return r.invalid;
};
function build(state: Parameters<typeof nextBuild>[0], event: BuildEvent, reasons?: BuildResult["reasons"]): BuildResult {
  const r = nextBuild(state, event, reasons ? { reasons } : undefined);
  if (isInvalid(r)) throw new Error(`build ${state} + ${event} is invalid: ${r.invalid}`);
  return r;
}
const buildNo = (state: Parameters<typeof nextBuild>[0], event: BuildEvent, reasons?: BuildResult["reasons"]): string => {
  const r = nextBuild(state, event, reasons ? { reasons } : undefined);
  if (!isInvalid(r)) throw new Error(`build ${state} + ${event} should be invalid, got ${r.state}`);
  return r.invalid;
};

describe("every pair has an entry", () => {
  test("the lists hold every state and event of the plan", () => {
    expect([...TASK_STATES].sort()).toEqual(["assigned", "blocked", "checking", "dropped", "escalated", "failed", "parked", "queued", "verified", "working"]);
    expect([...AGENT_STATES].sort()).toEqual(["halted", "idle", "needsYou", "paused", "stalled", "starting", "stopped", "working"]);
    expect([...BUILD_STATES].sort()).toEqual(["done", "notStarted", "running", "stopped"]);
    expect([...NOTE_STATES].map(String).sort()).toEqual(["held", "new", "queued", "read", "undone"]);
    expect([...NOTE_TARGETS].sort()).toEqual(["fixes", "orchestrator", "plan", "repo"]);
    for (const e of ["assign", "turnStart", "turnEnd", "checkPass", "checkFailCounted", "checkFailNoisy", "checkKilled", "ask", "answer", "agentPaused", "agentResumed", "orchestratorRetry", "orchestratorBlock", "orchestratorDrop", "orchestratorTurnEndedUndecided", "ownerRetry", "ownerDrop", "split", "agentDied", "agentRestarted"] as const) {
      expect(TASK_EVENTS).toContain(e);
    }
    for (const e of ["started", "turnStart", "turnEnd", "needsPermission", "permissionGiven", "noSignal10min", "signal", "limitReported", "processEnded", "restarted", "paused", "resumed", "halted", "chatResumed"] as const) {
      expect(AGENT_EVENTS).toContain(e);
    }
    for (const e of ["recorded", "pasted", "ackedTurnEnd", "unackedTurnEnd", "undo", "chatHalted", "chatResumed", "fixListSent"] as const) {
      expect(NOTE_EVENTS).toContain(e);
    }
    for (const e of ["start", "tasksUnreadable", "tasksReadable", "folderMissing", "folderBack", "checkpointFailed", "ownerResume", "lastPhaseEnded", "taskAdded", "fixListSent"] as const) {
      expect(BUILD_EVENTS).toContain(e);
    }
  });

  test("the task machine has a result or an explicit invalid for every (state, event)", () => {
    const pairs = allPairs().task;
    expect(pairs.length).toBe(TASK_STATES.length * TASK_EVENTS.length);
    expect(missingEntries(taskTable, TASK_STATES, TASK_EVENTS)).toEqual([]);
    for (const [s, e] of pairs) {
      const r = nextTask(s, e, { attempts: 0, escalations: 0 });
      if (isInvalid(r)) expect(r.invalid.length).toBeGreaterThan(5);
      else expect(TASK_STATES).toContain(r.state);
    }
  });

  test("the agent machine has a result or an explicit invalid for every (status, event)", () => {
    const pairs = allPairs().agent;
    expect(pairs.length).toBe(AGENT_STATES.length * AGENT_EVENTS.length);
    expect(missingEntries(agentTable, AGENT_STATES, AGENT_EVENTS)).toEqual([]);
    for (const [s, e] of pairs) {
      const r = nextAgent(s, e);
      if (isInvalid(r)) expect(r.invalid.length).toBeGreaterThan(5);
      else expect(AGENT_STATES).toContain(r.state);
    }
  });

  test("the note machine has a result or an explicit invalid for every (target, status, event)", () => {
    const pairs = allPairs().note;
    expect(pairs.length).toBe(NOTE_TARGETS.length * NOTE_STATES.length * NOTE_EVENTS.length);
    for (const target of NOTE_TARGETS) expect(missingEntries(noteTable[target], NOTE_STATES, NOTE_EVENTS)).toEqual([]);
    for (const [t, s, e] of pairs) {
      const r = nextNote(t, s, e, idle);
      if (isInvalid(r)) expect(r.invalid.length).toBeGreaterThan(5);
      else expect(NOTE_STATES).toContain(r.status);
    }
  });

  test("the build machine has a result or an explicit invalid for every (state, event)", () => {
    const pairs = allPairs().build;
    expect(pairs.length).toBe(BUILD_STATES.length * BUILD_EVENTS.length);
    expect(missingEntries(buildTable, BUILD_STATES, BUILD_EVENTS)).toEqual([]);
    for (const [s, e] of pairs) {
      const r = nextBuild(s, e);
      if (isInvalid(r)) expect(r.invalid.length).toBeGreaterThan(5);
      else expect(BUILD_STATES).toContain(r.state);
    }
  });

  test("the walk fails when a pair has no entry", () => {
    const hole = { ...taskTable, working: { ...taskTable.working } } as unknown as Record<string, Record<string, unknown>>;
    delete hole.working?.ask;
    expect(missingEntries(hole, TASK_STATES, TASK_EVENTS)).toEqual([["working", "ask"]]);
    const noRow = { ...taskTable } as unknown as Record<string, Record<string, unknown>>;
    delete noRow.blocked;
    expect(missingEntries(noRow, TASK_STATES, TASK_EVENTS).length).toBe(TASK_EVENTS.length);
  });

  test("where the plan is silent, the entry says so", () => {
    const choices = silentChoices();
    expect(choices.length).toBeGreaterThan(0);
    for (const c of choices) expect(c.reason.startsWith("plan is silent")).toBe(true);
    expect(choices.some((c) => c.machine === "task" && c.state === "queued" && c.event === "ask")).toBe(true);
  });
});

describe("task machine", () => {
  test("the happy path: queued, assigned, working, checking, verified", () => {
    expect(task("queued", "assign")).toMatchObject({ state: "assigned", attempts: 0 });
    expect(task("assigned", "turnStart").state).toBe("working");
    expect(task("working", "turnEnd")).toMatchObject({ state: "checking", effects: ["queueCheck"] });
    expect(task("checking", "checkPass")).toMatchObject({ state: "verified", effects: ["commit"] });
  });

  test("D7: a check that fails in a quiet worktree counts, and the last lines go back to the same worker", () => {
    const r = task("checking", "checkFailCounted", { attempts: 0, escalations: 0 });
    expect(r).toMatchObject({ state: "failed", attempts: 1, effects: ["sendLogToWorker"] });
    expect(task("failed", "turnStart").state).toBe("working");
    // The second failure is attempt 2.
    expect(task("checking", "checkFailCounted", { attempts: 1, escalations: 0 })).toMatchObject({ state: "failed", attempts: 2, effects: ["sendLogToWorker"] });
  });

  test("D8: three counted failures escalate, and the orchestrator is called", () => {
    const r = task("checking", "checkFailCounted", { attempts: 2, escalations: 0 });
    expect(r).toMatchObject({ state: "escalated", attempts: 3, escalations: 1 });
    expect(r.effects).toEqual(["callOrchestrator"]);
  });

  test("three counted failures escalate: the fourth attempt never starts without a decision", () => {
    expect(taskNo("checking", "checkFailCounted", { attempts: 3, escalations: 1 })).toContain("3");
    for (const e of ["assign", "turnStart", "checkPass"] as const) expect(isInvalid(nextTask("escalated", e, { attempts: 3, escalations: 1 }))).toBe(true);
  });

  test("D17: a failure while another worker has the status working does not count, and the check runs again", () => {
    const r = task("checking", "checkFailNoisy", { attempts: 1, escalations: 0 });
    expect(r).toMatchObject({ state: "checking", attempts: 1, escalations: 0 });
    expect(r.effects).toEqual(["queueCheckWhenQuiet"]);
    // Only the second result counts.
    expect(task("checking", "checkFailCounted", { attempts: 1, escalations: 0 }).attempts).toBe(2);
    expect(task("checking", "checkPass", { attempts: 1, escalations: 0 }).state).toBe("verified");
  });

  test("the orchestrator may retry an escalated task once: attempts go back to 0", () => {
    const r = task("escalated", "orchestratorRetry", { attempts: 3, escalations: 1 });
    expect(r).toMatchObject({ state: "queued", attempts: 0, escalations: 1 });
    expect(taskNo("escalated", "orchestratorRetry", { attempts: 3, escalations: 2 })).toContain("once");
  });

  test("the second escalation goes to blocked, and its edits are saved", () => {
    const r = task("checking", "checkFailCounted", { attempts: 2, escalations: 1 });
    expect(r).toMatchObject({ state: "blocked", attempts: 3, escalations: 2 });
    expect(r.effects).toEqual(["savePatch", "needsYou"]);
  });

  test("an orchestrator turn that ends undecided on an escalated task goes to blocked", () => {
    const r = task("escalated", "orchestratorTurnEndedUndecided", { attempts: 3, escalations: 1 });
    expect(r.state).toBe("blocked");
    expect(r.effects).toEqual(["savePatch", "needsYou"]);
  });

  test("the orchestrator can also block or drop an escalated task", () => {
    expect(task("escalated", "orchestratorBlock", { attempts: 3, escalations: 1 })).toMatchObject({ state: "blocked", effects: ["savePatch", "needsYou"] });
    expect(task("escalated", "orchestratorDrop", { attempts: 3, escalations: 1 })).toMatchObject({ state: "dropped", effects: ["savePatch", "removeLine"] });
  });

  test("only the owner moves a task out of blocked: retry puts attempts at 0 and applies the patch; drop removes the line", () => {
    const ctx = { attempts: 3, escalations: 2 };
    expect(task("blocked", "ownerRetry", ctx)).toMatchObject({ state: "queued", attempts: 0, effects: ["applyPatch"] });
    expect(task("blocked", "ownerDrop", ctx)).toMatchObject({ state: "dropped", effects: ["removeLine"] });
    for (const e of ["orchestratorRetry", "orchestratorBlock", "orchestratorDrop", "orchestratorTurnEndedUndecided", "split"] as const) {
      expect(isInvalid(nextTask("blocked", e, ctx))).toBe(true);
    }
    expect(taskNo("blocked", "orchestratorRetry", ctx)).toContain("owner");
  });

  test("an owner retry does not give the orchestrator a second retry: the next escalation blocks", () => {
    const after = task("blocked", "ownerRetry", { attempts: 3, escalations: 2 });
    expect(after.escalations).toBe(2);
    expect(task("checking", "checkFailCounted", { attempts: 2, escalations: after.escalations }).state).toBe("blocked");
  });

  test("a killed check is not an attempt and the task stays checking", () => {
    expect(task("checking", "checkKilled", { attempts: 1, escalations: 0 })).toMatchObject({ state: "checking", attempts: 1, effects: [] });
  });

  test("E2: Halt kills the check: it is not an attempt, the task stays checking, and Resume queues the check again", () => {
    const killed = task("checking", "checkKilled", { attempts: 2, escalations: 0 });
    expect(killed).toMatchObject({ state: "checking", attempts: 2 });
    const resumed = task("checking", "chatResumed", { attempts: 2, escalations: 0 });
    expect(resumed).toMatchObject({ state: "checking", attempts: 2, effects: ["queueCheck"] });
  });

  test("a task that is assigned or checking does not change when its agent is paused", () => {
    expect(task("assigned", "agentPaused")).toMatchObject({ state: "assigned", effects: [] });
    expect(task("checking", "agentPaused")).toMatchObject({ state: "checking", effects: [] });
  });

  test("working becomes parked on ask or on pause, and returns on the answer or on Resume", () => {
    expect(task("working", "ask").state).toBe("parked");
    expect(task("working", "agentPaused").state).toBe("parked");
    expect(task("parked", "answer").state).toBe("working");
    expect(task("parked", "agentResumed").state).toBe("working");
  });

  test("a parked task keeps its attempts", () => {
    expect(task("working", "ask", { attempts: 2, escalations: 1 })).toMatchObject({ attempts: 2, escalations: 1 });
    expect(task("parked", "answer", { attempts: 2, escalations: 1 })).toMatchObject({ attempts: 2, escalations: 1 });
  });

  test("D1: an agent that dies or restarts does not change its task's state", () => {
    for (const s of ["assigned", "working", "checking", "failed", "parked"] as const) {
      expect(task(s, "agentDied")).toMatchObject({ state: s, effects: [] });
      expect(task(s, "agentRestarted")).toMatchObject({ state: s, effects: [] });
    }
  });

  test("E4: Resume changes no task state, except that it queues a killed check again", () => {
    for (const s of TASK_STATES) {
      const r = task(s, "chatResumed");
      expect(r.state).toBe(s);
      expect(r.effects).toEqual(s === "checking" ? ["queueCheck"] : []);
    }
  });

  test("split replaces the line of a queued or escalated task by its parts", () => {
    expect(task("queued", "split")).toMatchObject({ state: "dropped", effects: ["replaceLine"] });
    expect(task("escalated", "split", { attempts: 3, escalations: 1 })).toMatchObject({ state: "dropped", effects: ["replaceLine"] });
    expect(isInvalid(nextTask("working", "split", { attempts: 0, escalations: 0 }))).toBe(true);
  });

  test("a queued task can be dropped before it starts, and a dropped task is final", () => {
    expect(task("queued", "orchestratorDrop")).toMatchObject({ state: "dropped", effects: ["removeLine"] });
    expect(task("queued", "ownerDrop")).toMatchObject({ state: "dropped", effects: ["removeLine"] });
    for (const e of TASK_EVENTS) {
      if (e === "chatResumed") continue;
      expect(isInvalid(nextTask("dropped", e, { attempts: 0, escalations: 0 }))).toBe(true);
    }
  });

  test("the attempt limit can be set: with a limit of 2 the second counted failure escalates", () => {
    expect(task("checking", "checkFailCounted", { attempts: 0, escalations: 0, max: 2 })).toMatchObject({ state: "failed", attempts: 1 });
    expect(task("checking", "checkFailCounted", { attempts: 1, escalations: 0, max: 2 })).toMatchObject({ state: "escalated", attempts: 2 });
  });

  test("a task whose verify is prose goes from working to blocked, with the owner to decide", () => {
    expect(task("working", "manualCheck")).toMatchObject({ state: "blocked", effects: ["needsYou"] });
    for (const s of TASK_STATES) {
      if (s === "working") continue;
      expect(isInvalid(nextTask(s, "manualCheck", { attempts: 0, escalations: 0 }))).toBe(true);
    }
  });

  test("a verified task has no way back", () => {
    for (const e of TASK_EVENTS) {
      if (e === "chatResumed") continue;
      expect(isInvalid(nextTask("verified", e, { attempts: 1, escalations: 0 }))).toBe(true);
    }
  });
});

describe("agent machine", () => {
  test("the path of an agent: starting, idle, working, idle", () => {
    expect(agent("starting", "started").state).toBe("idle");
    expect(agent("idle", "turnStart").state).toBe("working");
    expect(agent("working", "turnEnd").state).toBe("idle");
  });

  test("D1: an agent whose process ends is stopped, and restarted once", () => {
    for (const s of ["starting", "working", "idle", "needsYou", "stalled", "halted", "paused"] as const) {
      expect(agent(s, "processEnded").state).toBe("stopped");
    }
    expect(agent("stopped", "restarted")).toMatchObject({ state: "starting", effects: ["startSession"] });
    expect(agent("starting", "started").state).toBe("idle");
    // It ends again before its turn ends: stopped again.
    expect(agent("starting", "processEnded").state).toBe("stopped");
    expect(agentNo("stopped", "processEnded")).toContain("stopped");
  });

  test("D2: no signal for 10 minutes while working makes it stalled, and a signal makes it working again", () => {
    expect(agent("working", "noSignal10min").state).toBe("stalled");
    expect(agent("stalled", "signal").state).toBe("working");
    expect(agent("stalled", "turnStart").state).toBe("working");
    // Any new hook event ends the stall, a turn end included.
    expect(agent("stalled", "turnEnd")).toMatchObject({ state: "idle", effects: [] });
    expect(agentNo("idle", "noSignal10min")).toContain("working");
  });

  test("a usage limit makes a working agent stalled", () => {
    expect(agent("working", "limitReported").state).toBe("stalled");
  });

  test("D6: a permission makes the agent needsYou, and giving it makes the agent working", () => {
    expect(agent("working", "needsPermission").state).toBe("needsYou");
    expect(agent("needsYou", "permissionGiven").state).toBe("working");
  });

  test("a paused agent stays paused through Halt and through the chat's Resume", () => {
    expect(agent("paused", "halted").state).toBe("paused");
    expect(agent("paused", "chatResumed").state).toBe("paused");
    expect(agent("paused", "turnEnd").state).toBe("paused");
    expect(agent("paused", "resumed")).toMatchObject({ state: "working", effects: ["sendContinue"] });
  });

  test("Pause sends Escape and sets paused", () => {
    for (const s of ["working", "idle", "needsYou", "stalled", "halted"] as const) {
      expect(agent(s, "paused")).toMatchObject({ state: "paused", effects: s === "halted" ? [] : ["sendEscape"] });
    }
  });

  test("E1: Halt sends Escape and sets halted", () => {
    for (const s of ["starting", "working", "idle", "needsYou", "stalled"] as const) {
      expect(agent(s, "halted")).toMatchObject({ state: "halted", effects: ["sendEscape"] });
    }
    expect(agent("halted", "turnEnd").state).toBe("halted");
  });

  test("E4: Resume sends 'continue' to an agent that was in a turn, and nothing to an idle one", () => {
    expect(agent("halted", "chatResumed", { inTurn: true })).toMatchObject({ state: "working", effects: ["sendContinue"] });
    expect(agent("halted", "chatResumed", { inTurn: false })).toMatchObject({ state: "idle", effects: [] });
    expect(agent("halted", "chatResumed")).toMatchObject({ state: "idle", effects: [] });
  });

  test("E4: a dead session is restarted, as in D1", () => {
    expect(agent("halted", "processEnded").state).toBe("stopped");
    expect(agent("stopped", "restarted").state).toBe("starting");
  });

  test("E5: Halt twice, or Resume when the chat is not halted, has no effect", () => {
    expect(agent("halted", "halted")).toMatchObject({ state: "halted", effects: [] });
    for (const s of ["starting", "working", "idle", "needsYou", "stalled", "stopped", "paused"] as const) {
      expect(agent(s, "chatResumed")).toMatchObject({ state: s, effects: [] });
    }
  });

  test("a stopped agent only restarts", () => {
    for (const e of AGENT_EVENTS) {
      if (e === "restarted" || e === "chatResumed") continue;
      expect(isInvalid(nextAgent("stopped", e))).toBe(true);
    }
  });
});

describe("note machine", () => {
  test("a note starts by its target: orchestrator and fixes queued, plan and repo read", () => {
    expect(note("orchestrator", "new", "recorded").status).toBe("queued");
    expect(note("fixes", "new", "recorded").status).toBe("queued");
    expect(note("plan", "new", "recorded").status).toBe("read");
    expect(note("repo", "new", "recorded").status).toBe("read");
    expect(noteNo("orchestrator", "queued", "recorded")).toContain("already");
  });

  test("B3: the chat is halted: a note to the orchestrator is held, and Resume makes it queued", () => {
    expect(note("orchestrator", "new", "recorded", { ...idle, halted: true }).status).toBe("held");
    expect(note("orchestrator", "queued", "chatHalted").status).toBe("held");
    expect(note("orchestrator", "held", "chatResumed").status).toBe("queued");
    expect(noteNo("orchestrator", "held", "pasted")).toContain("halted");
  });

  test("B3: a note to the plan, the fix list or the repo is still recorded at once while halted", () => {
    const halted = { ...idle, halted: true };
    expect(note("plan", "new", "recorded", halted).status).toBe("read");
    expect(note("repo", "new", "recorded", halted).status).toBe("read");
    expect(note("fixes", "new", "recorded", halted).status).toBe("queued");
    expect(note("fixes", "queued", "chatHalted").status).toBe("queued");
  });

  test("B4: Undo while queued or held makes the note undone, and an undone fixes note leaves the fix list", () => {
    expect(note("orchestrator", "queued", "undo").status).toBe("undone");
    expect(note("orchestrator", "held", "undo").status).toBe("undone");
    expect(note("fixes", "queued", "undo")).toMatchObject({ status: "undone", effects: ["leaveFixList"] });
    expect(note("orchestrator", "queued", "undo").effects).toEqual([]);
  });

  test("B4: an undone note is never delivered", () => {
    expect(isInvalid(nextNote("orchestrator", "undone", "pasted", idle))).toBe(true);
    expect(noteNo("orchestrator", "undone", "undo")).toBe("Already undone");
    expect(noteNo("orchestrator", "undone", "ackedTurnEnd")).toBeTruthy();
  });

  test("B5: Undo after read is refused with 'Already read'", () => {
    for (const target of NOTE_TARGETS) expect(noteNo(target, "read", "undo")).toBe("Already read");
  });

  test("B13: Undo while the engine hands the note to the orchestrator is refused with 'Being read'", () => {
    const pasted = note("orchestrator", "queued", "pasted");
    expect(pasted).toMatchObject({ status: "queued", beingRead: true, deliveries: 1 });
    expect(noteNo("orchestrator", "queued", "undo", { deliveries: 1, beingRead: true, halted: false })).toBe("Being read");
    // Undo before that moment wins.
    expect(note("orchestrator", "queued", "undo", { deliveries: 0, beingRead: false, halted: false }).status).toBe("undone");
  });

  test("a note is read when the turn ends after the ack", () => {
    const ctx = { deliveries: 1, beingRead: true, halted: false };
    expect(note("orchestrator", "queued", "ackedTurnEnd", ctx)).toMatchObject({ status: "read", beingRead: false, deliveries: 1 });
    expect(noteNo("orchestrator", "queued", "ackedTurnEnd")).toBeTruthy();
  });

  test("a turn that ends with no ack makes the note queued again, and Undo works again", () => {
    const ctx = { deliveries: 1, beingRead: true, halted: false };
    const r = note("orchestrator", "queued", "unackedTurnEnd", ctx);
    expect(r).toMatchObject({ status: "queued", beingRead: false, deliveries: 1, effects: [] });
    expect(note("orchestrator", "queued", "undo", { deliveries: r.deliveries, beingRead: r.beingRead, halted: false }).status).toBe("undone");
  });

  test("B9: the third delivery with no ack stops delivery and raises needsYou", () => {
    let ctx = { deliveries: 0, beingRead: false, halted: false };
    for (let i = 1; i <= 3; i++) {
      const pasted = note("orchestrator", "queued", "pasted", ctx);
      expect(pasted.deliveries).toBe(i);
      const ended = note("orchestrator", "queued", "unackedTurnEnd", { ...ctx, deliveries: pasted.deliveries, beingRead: true });
      expect(ended.status).toBe("queued");
      expect(ended.effects).toEqual(i < 3 ? [] : ["needsYou"]);
      ctx = { ...ctx, deliveries: ended.deliveries, beingRead: ended.beingRead };
    }
    expect(noteNo("orchestrator", "queued", "pasted", ctx)).toContain("stopped");
    // The owner can still undo it.
    expect(note("orchestrator", "queued", "undo", ctx).status).toBe("undone");
  });

  test("only an orchestrator note is pasted", () => {
    for (const t of ["plan", "fixes", "repo"] as const) expect(isInvalid(nextNote(t, "queued", "pasted", idle))).toBe(true);
  });

  test("a fixes note is read when the fix list is sent, and a second send adds nothing", () => {
    expect(note("fixes", "queued", "fixListSent").status).toBe("read");
    expect(note("fixes", "read", "fixListSent")).toMatchObject({ status: "read", effects: [] });
    expect(isInvalid(nextNote("fixes", "undone", "fixListSent", idle))).toBe(true);
    expect(isInvalid(nextNote("orchestrator", "queued", "fixListSent", idle))).toBe(true);
  });

  test("E5: Resume when the chat is not halted does not change a note", () => {
    for (const s of ["queued", "read", "undone"] as const) expect(note("orchestrator", s, "chatResumed").status).toBe(s);
    expect(note("orchestrator", "held", "chatHalted")).toMatchObject({ status: "held", effects: [] });
  });

  test("a note that is being read is not held by Halt until its turn ends", () => {
    expect(noteNo("orchestrator", "queued", "chatHalted", { deliveries: 1, beingRead: true, halted: false })).toContain("turn");
  });
});

describe("build machine", () => {
  test("the build starts, and the plan files are committed", () => {
    expect(build("notStarted", "start")).toMatchObject({ state: "running", effects: ["commitPlanFiles"] });
    expect(buildNo("running", "start")).toContain("started");
  });

  test("the last phase ending makes the build done", () => {
    expect(build("running", "lastPhaseEnded").state).toBe("done");
  });

  test("taskAdded and fixListSent make a done build running", () => {
    expect(build("done", "taskAdded").state).toBe("running");
    expect(build("done", "fixListSent").state).toBe("running");
    expect(build("running", "taskAdded").state).toBe("running");
    expect(build("running", "fixListSent").state).toBe("running");
  });

  test("neither taskAdded nor fixListSent restarts a stopped build", () => {
    for (const reasons of [["checkpoint"], ["tasks"], ["folder"]] as const) {
      expect(build("stopped", "taskAdded", [...reasons])).toMatchObject({ state: "stopped", reasons });
      expect(build("stopped", "fixListSent", [...reasons])).toMatchObject({ state: "stopped", reasons });
    }
  });

  test("C2: a TASKS.md line the parser cannot read stops the build, and the build runs again as soon as the file parses", () => {
    const stopped = build("running", "tasksUnreadable");
    expect(stopped).toMatchObject({ state: "stopped", reasons: ["tasks"], effects: ["needsYou"] });
    expect(build("stopped", "tasksReadable", ["tasks"])).toMatchObject({ state: "running", reasons: [] });
  });

  test("C4: a missing feature folder stops the build, and the build runs again as soon as the folder is back", () => {
    expect(build("running", "folderMissing")).toMatchObject({ state: "stopped", reasons: ["folder"], effects: ["needsYou"] });
    expect(build("stopped", "folderBack", ["folder"])).toMatchObject({ state: "running", reasons: [] });
  });

  test("a failed checkpoint (the third run, or no fix task) stops the build until the owner presses Resume", () => {
    expect(build("running", "checkpointFailed")).toMatchObject({ state: "stopped", reasons: ["checkpoint"], effects: ["needsYou"] });
    expect(build("stopped", "ownerResume", ["checkpoint"])).toMatchObject({ state: "running", reasons: [], effects: ["resetCheckpointRuns"] });
  });

  test("Resume does not clear a stop for the file or the folder, and the file's stop clears only when it parses", () => {
    expect(build("stopped", "ownerResume", ["tasks"])).toMatchObject({ state: "stopped", reasons: ["tasks"], effects: [] });
    expect(build("stopped", "ownerResume", ["checkpoint", "tasks"])).toMatchObject({ state: "stopped", reasons: ["tasks"] });
    expect(build("stopped", "tasksReadable", ["checkpoint", "tasks"])).toMatchObject({ state: "stopped", reasons: ["checkpoint"] });
    expect(build("stopped", "tasksReadable", ["tasks", "folder"])).toMatchObject({ state: "stopped", reasons: ["folder"] });
  });

  test("E5: Resume when the build is not stopped on a checkpoint has no effect", () => {
    for (const s of ["notStarted", "running", "done"] as const) expect(build(s, "ownerResume")).toMatchObject({ state: s, effects: [] });
  });

  test("a stopped build runs no checkpoint", () => {
    expect(isInvalid(nextBuild("stopped", "lastPhaseEnded"))).toBe(true);
    expect(isInvalid(nextBuild("stopped", "checkpointFailed"))).toBe(true);
  });

  test("a build with an unreadable TASKS.md does not start", () => {
    expect(buildNo("notStarted", "tasksUnreadable")).toContain("does not start");
  });
});

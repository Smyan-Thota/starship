/**
 * The transition tables: the one source of truth for the states of a task, an agent, a note and a build.
 *
 * Each machine is DATA (a table of every state against every event) plus a small pure function that reads it.
 * An entry is a result, a function that computes a result from a small context, or an explicit
 * `{ invalid: "<reason>" }`. A pair with no entry does not compile, and `missingEntries` lets a test see it at run time.
 *
 * An entry whose reason starts with "plan is silent" marks a choice the plan did not make: nothing changes, and the
 * owner's reviewer decides it. `silentChoices()` lists them all.
 */
import type { NoteStatus, NoteTarget } from "../folder/notes.ts";
import type { AgentStatus, TaskState } from "../types.ts";

export interface Invalid {
  invalid: string;
}
export const isInvalid = (r: object): r is Invalid => "invalid" in r;

const SILENT = "silent" as const;
type Silent = typeof SILENT;

const rule = (reason: string): Invalid => ({ invalid: reason });

/** Replaces each `"silent"` marker with a reason that names the pair. */
function fillRows<S extends string, E extends string, V>(raw: Record<S, Record<E, V | Silent>>, label: string): Record<S, Record<E, V | Invalid>> {
  const out = {} as Record<S, Record<E, V | Invalid>>;
  for (const s of Object.keys(raw) as S[]) {
    const row = {} as Record<E, V | Invalid>;
    for (const e of Object.keys(raw[s]) as E[]) {
      const v = raw[s][e];
      row[e] = v === SILENT ? { invalid: `plan is silent: ${label}${s} + ${e} changes nothing` } : (v as V);
    }
    out[s] = row;
  }
  return out;
}

/** The pairs of `states` and `events` that `table` has no entry for. */
export function missingEntries(table: object, states: readonly string[], events: readonly string[]): [string, string][] {
  const t = table as Record<string, Record<string, unknown> | undefined>;
  const out: [string, string][] = [];
  for (const s of states) for (const e of events) if (t[s]?.[e] === undefined) out.push([s, e]);
  return out;
}

// ───────────────────────────── TASK ─────────────────────────────

export const TASK_STATES = ["queued", "assigned", "working", "checking", "verified", "failed", "escalated", "parked", "blocked", "dropped"] as const satisfies readonly TaskState[];
/** Compile-time check: the list above names every TaskState. */
const _taskCover: Exclude<TaskState, (typeof TASK_STATES)[number]> extends never ? true : never = true;

export const TASK_EVENTS = [
  "assign",
  "turnStart",
  "turnEnd",
  "checkPass",
  /** A failure in a quiet worktree: it counts as an attempt. */
  "checkFailCounted",
  /** A failure while another worker has the status working: it does not count, and the check runs again. */
  "checkFailNoisy",
  /** Halt killed the check, or the chat was dropped. */
  "checkKilled",
  "ask",
  "answer",
  "agentPaused",
  "agentResumed",
  "orchestratorRetry",
  "orchestratorBlock",
  "orchestratorDrop",
  "orchestratorTurnEndedUndecided",
  /** The owner's retry, through the admin agent. */
  "ownerRetry",
  "ownerDrop",
  "split",
  "agentDied",
  "agentRestarted",
  /** The turn of a task whose verify is prose ended: the engine cannot check it, so a person does. Not in the plan's event list. */
  "manualCheck",
  /** The chat's Resume. Not in the plan's event list: E2 needs it to queue a killed check again. */
  "chatResumed",
] as const;
export type TaskEvent = (typeof TASK_EVENTS)[number];

export type TaskEffect =
  | "sendPrompt"
  | "queueCheck"
  /** Run the check again when no worker of the chat has the status working. */
  | "queueCheckWhenQuiet"
  | "sendLogToWorker"
  | "commit"
  | "callOrchestrator"
  | "savePatch"
  | "applyPatch"
  | "needsYou"
  | "removeLine"
  /** The task's line leaves TASKS.md and its parts take its place. */
  | "replaceLine";

export interface TaskCtx {
  attempts: number;
  /** How many times the task has been escalated so far. */
  escalations: number;
  /** Counted failures before the orchestrator decides. Default 3. */
  max?: number;
}
export interface TaskResult {
  state: TaskState;
  attempts: number;
  escalations: number;
  effects: TaskEffect[];
}
interface TaskStep {
  state: TaskState;
  effects: TaskEffect[];
  resetAttempts?: true;
}
export type TaskEntry = Invalid | TaskStep | ((ctx: TaskCtx) => TaskResult | Invalid);

const to = (state: TaskState, effects: TaskEffect[] = [], resetAttempts?: true): TaskStep => (resetAttempts ? { state, effects, resetAttempts } : { state, effects });

/** The third counted failure escalates; the second escalation of a task blocks it. */
const checkFailCounted = (ctx: TaskCtx): TaskResult | Invalid => {
  const max = ctx.max ?? 3;
  if (ctx.attempts >= max) return { invalid: `the task already has ${max} attempts: no further attempt starts without a decision` };
  const attempts = ctx.attempts + 1;
  if (attempts < max) return { state: "failed", attempts, escalations: ctx.escalations, effects: ["sendLogToWorker"] };
  const escalations = ctx.escalations + 1;
  if (escalations >= 2) return { state: "blocked", attempts, escalations, effects: ["savePatch", "needsYou"] };
  return { state: "escalated", attempts, escalations, effects: ["callOrchestrator"] };
};

/** The orchestrator retries an escalated task once. */
const orchestratorRetry = (ctx: TaskCtx): TaskResult | Invalid =>
  ctx.escalations >= 2 ? { invalid: "the orchestrator retries a task once, and this task was escalated twice" } : { state: "queued", attempts: 0, escalations: ctx.escalations, effects: [] };

const NOT_ESCALATED = rule("the orchestrator decides only an escalated task");
const OWNER_ONLY = rule("only the owner moves a task out of blocked");
const NOT_BLOCKED = rule("only a blocked task takes the owner's retry or drop");
const NOT_DECIDING = rule("no orchestrator turn is deciding this task");
const NOT_RETRYABLE = rule("task retry applies to an escalated or a blocked task");
const GONE = rule("a dropped task has no line in TASKS.md any more");
const DONE = rule("a verified task is final");
const NOT_IN_TURN = rule("only a task whose turn just ended goes to a manual check");

type TaskRaw = TaskEntry | Silent;
const T: Record<TaskState, Record<TaskEvent, TaskRaw>> = {
  queued: {
    assign: to("assigned", ["sendPrompt"]), turnStart: SILENT, turnEnd: SILENT, checkPass: SILENT, checkFailCounted: SILENT, checkFailNoisy: SILENT, checkKilled: SILENT,
    ask: SILENT, answer: SILENT, agentPaused: SILENT, agentResumed: SILENT,
    orchestratorRetry: NOT_RETRYABLE, orchestratorBlock: SILENT, orchestratorDrop: to("dropped", ["removeLine"]), orchestratorTurnEndedUndecided: NOT_DECIDING,
    ownerRetry: NOT_BLOCKED, ownerDrop: to("dropped", ["removeLine"]), split: to("dropped", ["replaceLine"]),
    agentDied: SILENT, agentRestarted: SILENT, manualCheck: NOT_IN_TURN, chatResumed: to("queued"),
  },
  assigned: {
    assign: SILENT, turnStart: to("working"), turnEnd: SILENT, checkPass: SILENT, checkFailCounted: SILENT, checkFailNoisy: SILENT, checkKilled: SILENT,
    ask: SILENT, answer: SILENT, agentPaused: to("assigned"), agentResumed: to("assigned"),
    orchestratorRetry: NOT_RETRYABLE, orchestratorBlock: SILENT, orchestratorDrop: SILENT, orchestratorTurnEndedUndecided: NOT_DECIDING,
    ownerRetry: NOT_BLOCKED, ownerDrop: NOT_BLOCKED, split: SILENT,
    agentDied: to("assigned"), agentRestarted: to("assigned"), manualCheck: NOT_IN_TURN, chatResumed: to("assigned"),
  },
  working: {
    assign: SILENT, turnStart: rule("plan is silent: already working; a turn start after an answer or after Resume changes nothing"), turnEnd: to("checking", ["queueCheck"]),
    checkPass: SILENT, checkFailCounted: SILENT, checkFailNoisy: SILENT, checkKilled: SILENT,
    ask: to("parked"), answer: SILENT, agentPaused: to("parked"), agentResumed: SILENT,
    orchestratorRetry: NOT_RETRYABLE, orchestratorBlock: SILENT, orchestratorDrop: SILENT, orchestratorTurnEndedUndecided: NOT_DECIDING,
    ownerRetry: NOT_BLOCKED, ownerDrop: NOT_BLOCKED, split: SILENT,
    agentDied: to("working"), agentRestarted: to("working"), manualCheck: to("blocked", ["needsYou"]), chatResumed: to("working"),
  },
  checking: {
    assign: SILENT, turnStart: SILENT, turnEnd: SILENT, checkPass: to("verified", ["commit"]), checkFailCounted, checkFailNoisy: to("checking", ["queueCheckWhenQuiet"]), checkKilled: to("checking"),
    ask: SILENT, answer: SILENT, agentPaused: to("checking"), agentResumed: to("checking"),
    orchestratorRetry: NOT_RETRYABLE, orchestratorBlock: SILENT, orchestratorDrop: SILENT, orchestratorTurnEndedUndecided: NOT_DECIDING,
    ownerRetry: NOT_BLOCKED, ownerDrop: NOT_BLOCKED, split: SILENT,
    agentDied: to("checking"), agentRestarted: to("checking"), manualCheck: NOT_IN_TURN, chatResumed: to("checking", ["queueCheck"]),
  },
  verified: {
    assign: DONE, turnStart: DONE, turnEnd: DONE, checkPass: DONE, checkFailCounted: DONE, checkFailNoisy: DONE, checkKilled: DONE,
    ask: DONE, answer: DONE, agentPaused: DONE, agentResumed: DONE,
    orchestratorRetry: NOT_RETRYABLE, orchestratorBlock: DONE, orchestratorDrop: DONE, orchestratorTurnEndedUndecided: NOT_DECIDING,
    ownerRetry: NOT_BLOCKED, ownerDrop: NOT_BLOCKED, split: DONE,
    agentDied: DONE, agentRestarted: DONE, manualCheck: DONE, chatResumed: to("verified"),
  },
  failed: {
    assign: SILENT, turnStart: to("working"), turnEnd: SILENT, checkPass: SILENT, checkFailCounted: SILENT, checkFailNoisy: SILENT, checkKilled: SILENT,
    ask: SILENT, answer: SILENT, agentPaused: SILENT, agentResumed: SILENT,
    orchestratorRetry: NOT_RETRYABLE, orchestratorBlock: SILENT, orchestratorDrop: SILENT, orchestratorTurnEndedUndecided: NOT_DECIDING,
    ownerRetry: NOT_BLOCKED, ownerDrop: NOT_BLOCKED, split: SILENT,
    agentDied: to("failed"), agentRestarted: to("failed"), manualCheck: NOT_IN_TURN, chatResumed: to("failed"),
  },
  escalated: {
    assign: SILENT, turnStart: SILENT, turnEnd: SILENT, checkPass: SILENT, checkFailCounted: SILENT, checkFailNoisy: SILENT, checkKilled: SILENT,
    ask: SILENT, answer: SILENT, agentPaused: SILENT, agentResumed: SILENT,
    orchestratorRetry, orchestratorBlock: to("blocked", ["savePatch", "needsYou"]), orchestratorDrop: to("dropped", ["savePatch", "removeLine"]),
    orchestratorTurnEndedUndecided: to("blocked", ["savePatch", "needsYou"]),
    ownerRetry: NOT_ESCALATED, ownerDrop: NOT_ESCALATED, split: to("dropped", ["replaceLine"]),
    agentDied: SILENT, agentRestarted: SILENT, manualCheck: NOT_IN_TURN, chatResumed: to("escalated"),
  },
  parked: {
    assign: SILENT, turnStart: SILENT, turnEnd: rule("plan is silent: a parked task's turn end is not a check; the task waits until its cause ends"), checkPass: SILENT, checkFailCounted: SILENT, checkFailNoisy: SILENT, checkKilled: SILENT,
    ask: SILENT, answer: to("working"), agentPaused: SILENT, agentResumed: to("working"),
    orchestratorRetry: NOT_RETRYABLE, orchestratorBlock: SILENT, orchestratorDrop: SILENT, orchestratorTurnEndedUndecided: NOT_DECIDING,
    ownerRetry: NOT_BLOCKED, ownerDrop: NOT_BLOCKED, split: SILENT,
    agentDied: to("parked"), agentRestarted: to("parked"), manualCheck: NOT_IN_TURN, chatResumed: to("parked"),
  },
  blocked: {
    assign: SILENT, turnStart: SILENT, turnEnd: SILENT, checkPass: SILENT, checkFailCounted: SILENT, checkFailNoisy: SILENT, checkKilled: SILENT,
    ask: SILENT, answer: SILENT, agentPaused: SILENT, agentResumed: SILENT,
    orchestratorRetry: OWNER_ONLY, orchestratorBlock: OWNER_ONLY, orchestratorDrop: OWNER_ONLY, orchestratorTurnEndedUndecided: OWNER_ONLY,
    ownerRetry: to("queued", ["applyPatch"], true), ownerDrop: to("dropped", ["removeLine"]), split: OWNER_ONLY,
    agentDied: SILENT, agentRestarted: SILENT, manualCheck: NOT_IN_TURN, chatResumed: to("blocked"),
  },
  dropped: {
    assign: GONE, turnStart: GONE, turnEnd: GONE, checkPass: GONE, checkFailCounted: GONE, checkFailNoisy: GONE, checkKilled: GONE,
    ask: GONE, answer: GONE, agentPaused: GONE, agentResumed: GONE,
    orchestratorRetry: GONE, orchestratorBlock: GONE, orchestratorDrop: GONE, orchestratorTurnEndedUndecided: GONE,
    ownerRetry: GONE, ownerDrop: GONE, split: GONE,
    agentDied: GONE, agentRestarted: GONE, manualCheck: GONE, chatResumed: to("dropped"),
  },
};

export const taskTable: Record<TaskState, Record<TaskEvent, TaskEntry>> = fillRows(T, "a ");

export function nextTask(state: TaskState, event: TaskEvent, ctx: TaskCtx): TaskResult | Invalid {
  const entry = taskTable[state][event];
  if (typeof entry === "function") return entry(ctx);
  if (isInvalid(entry)) return entry;
  return { state: entry.state, attempts: entry.resetAttempts ? 0 : ctx.attempts, escalations: ctx.escalations, effects: [...entry.effects] };
}

// ───────────────────────────── AGENT ─────────────────────────────

export const AGENT_STATES = ["starting", "working", "idle", "needsYou", "stalled", "stopped", "halted", "paused"] as const satisfies readonly AgentStatus[];
const _agentCover: Exclude<AgentStatus, (typeof AGENT_STATES)[number]> extends never ? true : never = true;

export const AGENT_EVENTS = [
  "started",
  "turnStart",
  "turnEnd",
  "needsPermission",
  "permissionGiven",
  "noSignal10min",
  "signal",
  "limitReported",
  "processEnded",
  "restarted",
  "paused",
  "resumed",
  "halted",
  "chatResumed",
] as const;
export type AgentEvent = (typeof AGENT_EVENTS)[number];

export type AgentEffect = "sendEscape" | "sendContinue" | "startSession";

export interface AgentCtx {
  /** For `chatResumed` on a halted agent: it was in a turn when Halt came. */
  inTurn?: boolean;
}
export interface AgentResult {
  state: AgentStatus;
  effects: AgentEffect[];
}
export type AgentEntry = Invalid | AgentResult | ((ctx: AgentCtx) => AgentResult);

const ag = (state: AgentStatus, effects: AgentEffect[] = []): AgentResult => ({ state, effects });
const haltedResume = (ctx: AgentCtx): AgentResult => (ctx.inTurn ? ag("working", ["sendContinue"]) : ag("idle"));
const ALREADY_STOPPED = rule("the agent is stopped already");

type AgentRaw = AgentEntry | Silent;
const A: Record<AgentStatus, Record<AgentEvent, AgentRaw>> = {
  starting: {
    started: ag("idle"), turnStart: SILENT, turnEnd: SILENT, needsPermission: SILENT, permissionGiven: SILENT, noSignal10min: SILENT, signal: SILENT, limitReported: SILENT,
    processEnded: ag("stopped"), restarted: SILENT, paused: SILENT, resumed: SILENT, halted: ag("halted", ["sendEscape"]), chatResumed: ag("starting"),
  },
  working: {
    started: SILENT, turnStart: rule("plan is silent: the agent is in a turn already"), turnEnd: ag("idle"), needsPermission: ag("needsYou"), permissionGiven: SILENT,
    noSignal10min: ag("stalled"), signal: SILENT, limitReported: ag("stalled"),
    processEnded: ag("stopped"), restarted: ag("starting", ["startSession"]), paused: ag("paused", ["sendEscape"]), resumed: SILENT, halted: ag("halted", ["sendEscape"]), chatResumed: ag("working"),
  },
  idle: {
    started: SILENT, turnStart: ag("working"), turnEnd: SILENT, needsPermission: SILENT, permissionGiven: SILENT,
    noSignal10min: rule("the 10 minutes with no signal count only while the agent is working"), signal: SILENT, limitReported: SILENT,
    processEnded: ag("stopped"), restarted: ag("starting", ["startSession"]), paused: ag("paused", ["sendEscape"]), resumed: SILENT, halted: ag("halted", ["sendEscape"]), chatResumed: ag("idle"),
  },
  needsYou: {
    started: SILENT, turnStart: SILENT, turnEnd: SILENT, needsPermission: SILENT, permissionGiven: ag("working"), noSignal10min: SILENT, signal: SILENT, limitReported: SILENT,
    processEnded: ag("stopped"), restarted: ag("starting", ["startSession"]), paused: ag("paused", ["sendEscape"]), resumed: SILENT, halted: ag("halted", ["sendEscape"]), chatResumed: ag("needsYou"),
  },
  stalled: {
    started: SILENT, turnStart: ag("working"), turnEnd: ag("idle") /* D2: any new hook event ends the stall */, needsPermission: SILENT, permissionGiven: SILENT, noSignal10min: SILENT, signal: ag("working"), limitReported: SILENT,
    processEnded: ag("stopped"), restarted: ag("starting", ["startSession"]), paused: ag("paused", ["sendEscape"]), resumed: SILENT, halted: ag("halted", ["sendEscape"]), chatResumed: ag("stalled"),
  },
  stopped: {
    started: SILENT, turnStart: SILENT, turnEnd: SILENT, needsPermission: SILENT, permissionGiven: SILENT, noSignal10min: SILENT, signal: SILENT, limitReported: SILENT,
    processEnded: ALREADY_STOPPED, restarted: ag("starting", ["startSession"]), paused: SILENT, resumed: SILENT, halted: SILENT, chatResumed: ag("stopped"),
  },
  halted: {
    started: SILENT, turnStart: SILENT, turnEnd: ag("halted"), /* Escape ends the turn, so a halted agent still gets this event */ needsPermission: SILENT, permissionGiven: SILENT, noSignal10min: SILENT, signal: SILENT, limitReported: SILENT,
    processEnded: ag("stopped"), restarted: SILENT, paused: ag("paused"), resumed: SILENT, halted: ag("halted"), chatResumed: haltedResume,
  },
  paused: {
    started: SILENT, turnStart: SILENT, turnEnd: ag("paused") /* Escape ends the turn */, needsPermission: SILENT, permissionGiven: SILENT, noSignal10min: SILENT, signal: SILENT, limitReported: SILENT,
    processEnded: ag("stopped"), restarted: SILENT, paused: SILENT, resumed: ag("working", ["sendContinue"]), halted: ag("paused"), chatResumed: ag("paused"),
  },
};

export const agentTable: Record<AgentStatus, Record<AgentEvent, AgentEntry>> = fillRows(A, "an agent that is ");

export function nextAgent(status: AgentStatus, event: AgentEvent, ctx: AgentCtx = {}): AgentResult | Invalid {
  const entry = agentTable[status][event];
  if (typeof entry === "function") return entry(ctx);
  if (isInvalid(entry)) return entry;
  return { state: entry.state, effects: [...entry.effects] };
}

// ───────────────────────────── NOTE ─────────────────────────────

/** `new` is the moment before the note exists: only `recorded` leaves it. */
export type NoteState = "new" | NoteStatus;
export const NOTE_STATES = ["new", "queued", "read", "undone", "held"] as const satisfies readonly NoteState[];
const _noteCover: Exclude<NoteState, (typeof NOTE_STATES)[number]> extends never ? true : never = true;
export const NOTE_TARGETS = ["orchestrator", "plan", "fixes", "repo"] as const satisfies readonly NoteTarget[];

export const NOTE_EVENTS = [
  /** The engine writes the note to handoffs.md. */
  "recorded",
  /** The engine pastes the note to the orchestrator. */
  "pasted",
  /** The orchestrator's turn ended after it ran `starship note ack` for the note. */
  "ackedTurnEnd",
  /** The orchestrator's turn ended with no ack for the note. */
  "unackedTurnEnd",
  "undo",
  "chatHalted",
  "chatResumed",
  "fixListSent",
] as const;
export type NoteEvent = (typeof NOTE_EVENTS)[number];

export type NoteEffect = "needsYou" | "leaveFixList";

export interface NoteCtx {
  /** How many times the engine pasted the note to the orchestrator. */
  deliveries: number;
  /** Pasted, and the orchestrator's turn has not ended. */
  beingRead: boolean;
  /** Only for `recorded`: the chat is halted. */
  halted: boolean;
}
export interface NoteResult {
  status: NoteStatus;
  deliveries: number;
  beingRead: boolean;
  effects: NoteEffect[];
}
export type NoteEntry = Invalid | NoteStatusStep | ((ctx: NoteCtx) => NoteResult | Invalid);
interface NoteStatusStep {
  status: NoteStatus;
  effects: NoteEffect[];
}

/** After this many deliveries with no ack, the engine stops delivering a note. */
export const MAX_DELIVERIES = 3;

const nt = (status: NoteStatus, effects: NoteEffect[] = []): NoteStatusStep => ({ status, effects });
const res = (ctx: NoteCtx, status: NoteStatus, over: Partial<NoteResult> = {}): NoteResult => ({ status, deliveries: ctx.deliveries, beingRead: ctx.beingRead, effects: [], ...over });

const orchestratorRecorded = (ctx: NoteCtx): NoteResult => res(ctx, ctx.halted ? "held" : "queued");
const paste = (ctx: NoteCtx): NoteResult | Invalid => {
  if (ctx.beingRead) return { invalid: "the note is being read already" };
  if (ctx.deliveries >= MAX_DELIVERIES) return { invalid: `delivery stopped after ${MAX_DELIVERIES} deliveries with no ack` };
  return res(ctx, "queued", { deliveries: ctx.deliveries + 1, beingRead: true });
};
const ackedTurnEnd = (ctx: NoteCtx): NoteResult | Invalid => (ctx.beingRead ? res(ctx, "read", { beingRead: false }) : { invalid: "the note was not being read" });
const unackedTurnEnd = (ctx: NoteCtx): NoteResult | Invalid =>
  ctx.beingRead ? res(ctx, "queued", { beingRead: false, effects: ctx.deliveries >= MAX_DELIVERIES ? ["needsYou"] : [] }) : { invalid: "the note was not being read" };
const undoQueued = (effects: NoteEffect[]) => (ctx: NoteCtx): NoteResult | Invalid => (ctx.beingRead ? { invalid: "Being read" } : res(ctx, "undone", { effects }));
const holdWhenIdle = (ctx: NoteCtx): NoteResult | Invalid =>
  ctx.beingRead ? { invalid: "plan is silent: the note is being read; its turn ends first, and the engine applies the halt after it" } : res(ctx, "held");

const NO_NOTE_YET = rule("the note does not exist yet");
const RECORDED = rule("the note is recorded already");
const NOT_PASTED = rule("only an orchestrator note is pasted");
const NOT_ACKABLE = rule("only an orchestrator note has a turn to ack");
const NOT_ON_FIX_LIST = rule("the fix list holds only fixes notes");
const READ = rule("Already read");
const UNDONE = rule("Already undone");
const NEVER = rule("a note to this target never has this status");
const HELD_NOT_DELIVERED = rule("the chat is halted: no note is delivered to the orchestrator");
const NOTHING_TO_READ = rule("the note was not being read");

type NoteRaw = NoteEntry | Silent;
type NoteRows = Record<NoteState, Record<NoteEvent, NoteRaw>>;
const newRow = (recorded: NoteEntry): Record<NoteEvent, NoteRaw> => ({
  recorded, pasted: NO_NOTE_YET, ackedTurnEnd: NO_NOTE_YET, unackedTurnEnd: NO_NOTE_YET, undo: NO_NOTE_YET, chatHalted: NO_NOTE_YET, chatResumed: NO_NOTE_YET, fixListSent: NO_NOTE_YET,
});
const neverRow: Record<NoteEvent, NoteRaw> = {
  recorded: NEVER, pasted: NEVER, ackedTurnEnd: NEVER, unackedTurnEnd: NEVER, undo: NEVER, chatHalted: NEVER, chatResumed: NEVER, fixListSent: NEVER,
};

const orchestratorRows: NoteRows = {
  new: newRow(orchestratorRecorded),
  queued: {
    recorded: RECORDED, pasted: paste, ackedTurnEnd, unackedTurnEnd, undo: undoQueued([]), chatHalted: holdWhenIdle, chatResumed: nt("queued"), fixListSent: NOT_ON_FIX_LIST,
  },
  read: {
    recorded: RECORDED, pasted: rule("the note is read already"), ackedTurnEnd: NOTHING_TO_READ, unackedTurnEnd: NOTHING_TO_READ, undo: READ, chatHalted: SILENT, chatResumed: nt("read"), fixListSent: NOT_ON_FIX_LIST,
  },
  undone: {
    recorded: RECORDED, pasted: rule("an undone note is never delivered"), ackedTurnEnd: NOTHING_TO_READ, unackedTurnEnd: NOTHING_TO_READ, undo: UNDONE, chatHalted: SILENT, chatResumed: nt("undone"), fixListSent: NOT_ON_FIX_LIST,
  },
  held: {
    recorded: RECORDED, pasted: HELD_NOT_DELIVERED, ackedTurnEnd: NOTHING_TO_READ, unackedTurnEnd: NOTHING_TO_READ, undo: nt("undone"), chatHalted: nt("held"), chatResumed: nt("queued"), fixListSent: NOT_ON_FIX_LIST,
  },
};

/** A `plan` or `repo` note: the engine wrote it, so it is `read` from the start. */
const engineWrittenRows: NoteRows = {
  new: newRow(nt("read")),
  queued: neverRow,
  read: {
    recorded: RECORDED, pasted: NOT_PASTED, ackedTurnEnd: NOT_ACKABLE, unackedTurnEnd: NOT_ACKABLE, undo: READ, chatHalted: SILENT, chatResumed: nt("read"), fixListSent: NOT_ON_FIX_LIST,
  },
  undone: neverRow,
  held: neverRow,
};

const fixesRows: NoteRows = {
  new: newRow(nt("queued")),
  queued: {
    recorded: RECORDED, pasted: NOT_PASTED, ackedTurnEnd: NOT_ACKABLE, unackedTurnEnd: NOT_ACKABLE, undo: undoQueued(["leaveFixList"]),
    // A note to the fix list is recorded at once and never held.
    chatHalted: nt("queued"), chatResumed: nt("queued"), fixListSent: nt("read"),
  },
  read: {
    recorded: RECORDED, pasted: NOT_PASTED, ackedTurnEnd: NOT_ACKABLE, unackedTurnEnd: NOT_ACKABLE, undo: READ, chatHalted: SILENT, chatResumed: nt("read"),
    // A second send adds nothing.
    fixListSent: nt("read"),
  },
  undone: {
    recorded: RECORDED, pasted: NOT_PASTED, ackedTurnEnd: NOT_ACKABLE, unackedTurnEnd: NOT_ACKABLE, undo: UNDONE, chatHalted: SILENT, chatResumed: nt("undone"),
    fixListSent: rule("an undone note left the fix list"),
  },
  held: neverRow,
};

export const noteTable: Record<NoteTarget, Record<NoteState, Record<NoteEvent, NoteEntry>>> = {
  orchestrator: fillRows(orchestratorRows, "an orchestrator note that is "),
  plan: fillRows(engineWrittenRows, "a plan note that is "),
  fixes: fillRows(fixesRows, "a fixes note that is "),
  repo: fillRows(engineWrittenRows, "a repo note that is "),
};

export function nextNote(target: NoteTarget, status: NoteState, event: NoteEvent, ctx: NoteCtx = { deliveries: 0, beingRead: false, halted: false }): NoteResult | Invalid {
  const entry = noteTable[target][status][event];
  if (typeof entry === "function") return entry(ctx);
  if (isInvalid(entry)) return entry;
  return { status: entry.status, deliveries: ctx.deliveries, beingRead: ctx.beingRead, effects: [...entry.effects] };
}

// ───────────────────────────── BUILD ─────────────────────────────

export type BuildState = "notStarted" | "running" | "stopped" | "done";
export const BUILD_STATES = ["notStarted", "running", "stopped", "done"] as const satisfies readonly BuildState[];

export const BUILD_EVENTS = [
  "start",
  "tasksUnreadable",
  "tasksReadable",
  "folderMissing",
  "folderBack",
  /** The checkpoint failed a third time, or failed and the orchestrator added no fix task. */
  "checkpointFailed",
  "ownerResume",
  "lastPhaseEnded",
  "taskAdded",
  "fixListSent",
] as const;
export type BuildEvent = (typeof BUILD_EVENTS)[number];

/** Why a build is stopped. More than one can hold at once. */
export type BuildStop = "tasks" | "folder" | "checkpoint";
export type BuildEffect = "commitPlanFiles" | "needsYou" | "resetCheckpointRuns";

export interface BuildCtx {
  reasons: BuildStop[];
}
export interface BuildResult {
  state: BuildState;
  reasons: BuildStop[];
  effects: BuildEffect[];
}
type BuildFn = (ctx: BuildCtx) => BuildResult | Invalid;
export type BuildEntry = Invalid | BuildFn;

const defaultBuildCtx = (state: BuildState): BuildCtx => ({ reasons: state === "stopped" ? ["checkpoint"] : [] });

const bs = (state: BuildState, effects: BuildEffect[] = []): BuildFn => (ctx) => ({ state, reasons: [...ctx.reasons], effects });
const stopFor = (reason: BuildStop): BuildFn => (ctx) => ({
  state: "stopped",
  reasons: ctx.reasons.includes(reason) ? [...ctx.reasons] : [...ctx.reasons, reason],
  effects: ctx.reasons.length === 0 ? ["needsYou"] : [],
});
/** A stop clears; the build runs again only when no other reason holds. */
const clear = (reason: BuildStop, effects: BuildEffect[] = []): BuildFn => (ctx) => {
  if (!ctx.reasons.includes(reason)) return { invalid: `the build is not stopped for ${reason}` };
  const reasons = ctx.reasons.filter((r) => r !== reason);
  return { state: reasons.length === 0 ? "running" : "stopped", reasons, effects: reasons.length === 0 ? effects : [] };
};
const ownerResume: BuildFn = (ctx) => (ctx.reasons.includes("checkpoint") ? clear("checkpoint", ["resetCheckpointRuns"])(ctx) : { state: "stopped", reasons: [...ctx.reasons], effects: [] });

type BuildRaw = BuildEntry | Silent;
const B: Record<BuildState, Record<BuildEvent, BuildRaw>> = {
  notStarted: {
    start: () => ({ state: "running", reasons: [], effects: ["commitPlanFiles"] }),
    tasksUnreadable: rule("the build does not start while TASKS.md has a line the parser cannot read"),
    tasksReadable: SILENT, folderMissing: SILENT, folderBack: SILENT, checkpointFailed: SILENT, ownerResume: bs("notStarted"), lastPhaseEnded: SILENT, taskAdded: SILENT, fixListSent: SILENT,
  },
  running: {
    start: rule("the build has started"), tasksUnreadable: stopFor("tasks"), tasksReadable: SILENT, folderMissing: stopFor("folder"), folderBack: SILENT, checkpointFailed: stopFor("checkpoint"),
    ownerResume: bs("running"), lastPhaseEnded: bs("done"), taskAdded: bs("running"), fixListSent: bs("running"),
  },
  stopped: {
    start: SILENT, tasksUnreadable: stopFor("tasks"), tasksReadable: clear("tasks"), folderMissing: stopFor("folder"), folderBack: clear("folder"),
    checkpointFailed: rule("plan is silent: a stopped build runs no checkpoint"), ownerResume, lastPhaseEnded: rule("plan is silent: a stopped build runs no checkpoint"),
    // Neither one starts a stopped build again.
    taskAdded: bs("stopped"), fixListSent: bs("stopped"),
  },
  done: {
    start: SILENT, tasksUnreadable: SILENT, tasksReadable: SILENT, folderMissing: SILENT, folderBack: SILENT, checkpointFailed: SILENT, ownerResume: bs("done"), lastPhaseEnded: SILENT,
    taskAdded: bs("running"), fixListSent: bs("running"),
  },
};

export const buildTable: Record<BuildState, Record<BuildEvent, BuildEntry>> = fillRows(B, "a build that is ");

export function nextBuild(state: BuildState, event: BuildEvent, ctx: BuildCtx = defaultBuildCtx(state)): BuildResult | Invalid {
  if (state === "stopped" && ctx.reasons.length === 0) return { invalid: "a stopped build has a reason" };
  const entry = buildTable[state][event];
  return isInvalid(entry) ? entry : entry(ctx);
}

// ───────────────────────────── WALKING THE TABLES ─────────────────────────────

/** Every (state, event) pair of each machine, for a test that walks them all. */
export function allPairs(): {
  task: [TaskState, TaskEvent][];
  agent: [AgentStatus, AgentEvent][];
  note: [NoteTarget, NoteState, NoteEvent][];
  build: [BuildState, BuildEvent][];
} {
  return {
    task: TASK_STATES.flatMap((s) => TASK_EVENTS.map((e): [TaskState, TaskEvent] => [s, e])),
    agent: AGENT_STATES.flatMap((s) => AGENT_EVENTS.map((e): [AgentStatus, AgentEvent] => [s, e])),
    note: NOTE_TARGETS.flatMap((t) => NOTE_STATES.flatMap((s) => NOTE_EVENTS.map((e): [NoteTarget, NoteState, NoteEvent] => [t, s, e]))),
    build: BUILD_STATES.flatMap((s) => BUILD_EVENTS.map((e): [BuildState, BuildEvent] => [s, e])),
  };
}

/** Every entry where the plan is silent. The owner's reviewer decides each one. */
export function silentChoices(): { machine: "task" | "agent" | "note" | "build"; state: string; event: string; reason: string }[] {
  const out: { machine: "task" | "agent" | "note" | "build"; state: string; event: string; reason: string }[] = [];
  const silent = (e: unknown): e is Invalid => typeof e === "object" && e !== null && "invalid" in e && String((e as Invalid).invalid).startsWith("plan is silent");
  const pairs = allPairs();
  for (const [s, e] of pairs.task) if (silent(taskTable[s][e])) out.push({ machine: "task", state: s, event: e, reason: (taskTable[s][e] as Invalid).invalid });
  for (const [s, e] of pairs.agent) if (silent(agentTable[s][e])) out.push({ machine: "agent", state: s, event: e, reason: (agentTable[s][e] as Invalid).invalid });
  for (const [t, s, e] of pairs.note) if (silent(noteTable[t][s][e])) out.push({ machine: "note", state: `${t}/${s}`, event: e, reason: (noteTable[t][s][e] as Invalid).invalid });
  for (const [s, e] of pairs.build) if (silent(buildTable[s][e])) out.push({ machine: "build", state: s, event: e, reason: (buildTable[s][e] as Invalid).invalid });
  return out;
}

void [_taskCover, _agentCover, _noteCover];

/**
 * run/state.json: the task loop's own state for one chat.
 *
 * TASKS.md holds only the checkboxes. Everything else the loop must remember is here,
 * so that an engine restart finds the same build. One writer: the engine.
 */
import { existsSync, mkdirSync, readFileSync, renameSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import type { BuildStatus, BuildView, TaskState } from "../types.ts";
import type { BuildStop } from "./states.ts";

export interface TaskRun {
  state: TaskState;
  /** The agent that has the task, such as "worker-a". */
  agent: string | null;
  /** Failed checks that counted since the last retry. */
  attempts: number;
  /** How many times the task went to the orchestrator. */
  escalations: number;
  /** Every run of the task's check. It names the log and the patch, and never starts again. */
  runs: number;
  parkedBy: "question" | "pause" | null;
  /** Why the task is blocked or escalated, when someone said. */
  reason?: string;
}

export interface NoteRun {
  /** How many times the note was pasted to the orchestrator. */
  deliveries: number;
  /** True from the paste until that orchestrator turn ends. Undo is refused meanwhile. */
  reading: boolean;
}

export interface RunState {
  build: {
    status: BuildStatus;
    reason: BuildView["reason"];
    startedAt: string | null;
    /** Every reason that holds a stopped build. `reason` shows the first one. */
    reasons?: BuildStop[];
  };
  /** By task id. A task with no entry is `queued`, or `verified` when its box is checked. */
  tasks: Record<string, TaskRun>;
  /** By note number. */
  notes: Record<string, NoteRun>;
  /** By phase number. `fails`: failed runs of the checkpoint. `passed`: the phase has ended. `runs`: every run, for the log name. `at`: verified tasks of the phase when the last run failed. */
  checkpoints: Record<string, { fails: number; passed?: true; runs?: number; at?: number }>;
  /** Set while the chat is halted: the agents that were in a turn when Halt came. */
  halt?: { inTurn: string[] };
  /** A passed check whose commit is not made yet. Finished once after a restart. */
  pendingCommit: { task: string; text: string; files: string[] } | null;
  /** Ids of the prompts that were pasted. No prompt goes out twice. */
  sent: string[];
  /** Changed files that no task lists. */
  outside: string[];
  dropped: { task: string; text: string; reason: string }[];
  lastFixSent: number;
  /** The commit that the engine made last, or the branch's commit at the build's start. A commit above it that the engine did not make is foreign. null: not known yet. */
  lastCommit: string | null;
  /** Commits that a worker made, which workers must never do. Each is listed once, in the order found. The build goes on. */
  foreignCommits: { sha: string; subject: string; at: string }[];
}

export class RunStateError extends Error {}

export function emptyRunState(): RunState {
  return {
    build: { status: "notStarted", reason: null, startedAt: null },
    tasks: {},
    notes: {},
    checkpoints: {},
    pendingCommit: null,
    sent: [],
    outside: [],
    dropped: [],
    lastFixSent: 0,
    lastCommit: null,
    foreignCommits: [],
  };
}

export function emptyTaskRun(state: TaskState = "queued"): TaskRun {
  return { state, agent: null, attempts: 0, escalations: 0, runs: 0, parkedBy: null };
}

export function runStatePath(featureDir: string): string {
  return join(featureDir, "run", "state.json");
}

const isObject = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);

/** A missing file is an empty state. A file that is not a JSON object is an error with its path. */
export function readRunState(featureDir: string): RunState {
  const file = runStatePath(featureDir);
  const out = emptyRunState();
  if (!existsSync(file)) return out;
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch {
    throw new RunStateError(`${file} is not JSON`);
  }
  if (!isObject(raw)) throw new RunStateError(`${file} is not a JSON object`);

  if (isObject(raw.build)) {
    const b = raw.build;
    if (b.status === "notStarted" || b.status === "running" || b.status === "stopped" || b.status === "done") out.build.status = b.status;
    if (isObject(b.reason) && (b.reason.kind === "tasks" || b.reason.kind === "folder" || b.reason.kind === "checkpoint")) {
      out.build.reason = { kind: b.reason.kind, text: typeof b.reason.text === "string" ? b.reason.text : "" };
    }
    if (typeof b.startedAt === "string") out.build.startedAt = b.startedAt;
    if (Array.isArray(b.reasons)) out.build.reasons = b.reasons.filter((r): r is BuildStop => r === "tasks" || r === "folder" || r === "checkpoint");
  }
  if (isObject(raw.tasks)) {
    for (const [id, v] of Object.entries(raw.tasks)) {
      if (!isObject(v) || typeof v.state !== "string") continue;
      const t = emptyTaskRun(v.state as TaskState); // reason: the caller checks the name against its own list of states
      if (typeof v.agent === "string") t.agent = v.agent;
      if (typeof v.attempts === "number") t.attempts = v.attempts;
      if (typeof v.escalations === "number") t.escalations = v.escalations;
      if (typeof v.runs === "number") t.runs = v.runs;
      if (v.parkedBy === "question" || v.parkedBy === "pause") t.parkedBy = v.parkedBy;
      if (typeof v.reason === "string") t.reason = v.reason;
      out.tasks[id] = t;
    }
  }
  if (isObject(raw.notes)) {
    for (const [n, v] of Object.entries(raw.notes)) {
      if (!isObject(v)) continue;
      out.notes[n] = { deliveries: typeof v.deliveries === "number" ? v.deliveries : 0, reading: v.reading === true };
    }
  }
  if (isObject(raw.checkpoints)) {
    for (const [n, v] of Object.entries(raw.checkpoints)) {
      if (!isObject(v)) continue;
      const c: RunState["checkpoints"][string] = { fails: typeof v.fails === "number" ? v.fails : 0 };
      if (v.passed === true) c.passed = true;
      if (typeof v.runs === "number") c.runs = v.runs;
      if (typeof v.at === "number") c.at = v.at;
      out.checkpoints[n] = c;
    }
  }
  if (isObject(raw.pendingCommit) && typeof raw.pendingCommit.task === "string") {
    const p = raw.pendingCommit;
    out.pendingCommit = {
      task: raw.pendingCommit.task,
      text: typeof p.text === "string" ? p.text : "",
      files: Array.isArray(p.files) ? p.files.filter((f): f is string => typeof f === "string") : [],
    };
  }
  if (Array.isArray(raw.sent)) out.sent = raw.sent.filter((x): x is string => typeof x === "string");
  if (Array.isArray(raw.outside)) out.outside = raw.outside.filter((x): x is string => typeof x === "string");
  if (Array.isArray(raw.dropped)) {
    for (const d of raw.dropped) {
      if (isObject(d) && typeof d.task === "string") {
        out.dropped.push({ task: d.task, text: typeof d.text === "string" ? d.text : "", reason: typeof d.reason === "string" ? d.reason : "" });
      }
    }
  }
  if (isObject(raw.halt) && Array.isArray(raw.halt.inTurn)) out.halt = { inTurn: raw.halt.inTurn.filter((x): x is string => typeof x === "string") };
  if (typeof raw.lastFixSent === "number") out.lastFixSent = raw.lastFixSent;
  if (typeof raw.lastCommit === "string" && raw.lastCommit !== "") out.lastCommit = raw.lastCommit;
  if (Array.isArray(raw.foreignCommits)) {
    for (const c of raw.foreignCommits) {
      if (isObject(c) && typeof c.sha === "string" && c.sha !== "") {
        out.foreignCommits.push({ sha: c.sha, subject: typeof c.subject === "string" ? c.subject : "", at: typeof c.at === "string" ? c.at : "" });
      }
    }
  }
  return out;
}

/** Writes a new file and renames it, so a reader never sees half a file. */
export function writeRunState(featureDir: string, state: RunState): void {
  const file = runStatePath(featureDir);
  mkdirSync(dirname(file), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  writeFileSync(tmp, JSON.stringify(state, null, 2) + "\n");
  renameSync(tmp, file);
}

/** Reads the file again, applies the change, and writes it. The engine never writes from an old copy. */
export function updateRunState(featureDir: string, change: (s: RunState) => void): RunState {
  const s = readRunState(featureDir);
  change(s);
  writeRunState(featureDir, s);
  return s;
}

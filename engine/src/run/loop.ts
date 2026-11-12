/**
 * The task loop. (ADR engine-runs-the-loop)
 *
 * The engine does every step a rule can do: it hands each idle worker a ready task, waits for the worker's
 * turn to end, runs the task's verify command through the run queue, and checks the task off only when that
 * command exited 0. A failure goes back to the same worker, three times at most, then to the orchestrator.
 *
 * Every state change of a task, an agent and a build goes through `nextTask`, `nextAgent` and `nextBuild`
 * (states.ts). A pair the table calls invalid changes nothing and leaves one line in `run/logs/loop.log`.
 * The loop reaches agents, checks and time only through the ports in ports.ts.
 *
 * All state changes run in one synchronous step: read run/state.json, decide, write. Only the sending of text
 * to an agent and the waiting for a check are asynchronous, so two events never write from an old copy.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, statSync, writeFileSync } from "node:fs";
import { join, relative } from "node:path";
import { rolePrompt } from "../agents/roles.ts";
import { type PlanProblem, validatePlan } from "../folder/plan.ts";
import { renderProgress } from "../folder/progress.ts";
import { ParseError, type Phase, type Task, type TasksDoc, allTasks, checkTask, counts, findTask, parseTasks, serialize } from "../folder/tasks.ts";
import { writeRunFile } from "../folder/write.ts";
import type { TaskState } from "../types.ts";
import { applyAside, changedFiles, commitPlanFiles, commitTask, commitsBetween, headCommit, setAside } from "./commit.ts";
import type { AgentEvent, AgentPort, AgentSpec, CheckPort, Clock } from "./ports.ts";
import { type CheckResult, tailLines } from "./queue.ts";
import { type RunState, type TaskRun, emptyTaskRun, readRunState, updateRunState } from "./state.ts";
import { type BuildEvent, type BuildResult, type BuildState, type BuildStop, type TaskEvent, type TaskResult, isInvalid, nextAgent, nextBuild, nextTask } from "./states.ts";

export interface ChatInfo {
  worktree: string;
  /** Absolute path of docs/features/<slug>/ in the worktree. */
  featureDir: string;
  slug: string;
  halted: boolean;
  /** True when the command is heavy: one at a time on the whole Mac. */
  heavy: (cmd: string) => boolean;
  /** The repo's `commitPlanFiles`. false: the loop never commits plan files, the owner does. Default true. */
  commitPlanFiles?: boolean;
}

export interface LoopDeps {
  agents: AgentPort;
  checks: CheckPort;
  clock: Clock;
  /** The chat's state changed: the window reads it again. */
  publish: (chatId: string) => void;
  chat: (chatId: string) => ChatInfo;
  /** The worker agents of the chat, in the order they get tasks. */
  workers: (chatId: string) => AgentSpec[];
  orchestrator: {
    escalated(chatId: string, taskId: string, logTail: string): void;
    checkpointFailed(chatId: string, phase: number, logTail: string): void;
    planChanged?(chatId: string, files: string[]): void;
  };
  /** A task boundary: a check ended with a result that counts. */
  onBoundary?: (chatId: string) => void;
  /** A task passed its check. */
  onTaskEnded?: (chatId: string, agent: string, task: string) => void;
  /** Counted failures before the orchestrator decides. Default 3. */
  maxAttempts?: number;
}

/** What `halt.ts` needs from the loop. */
export interface HaltLoop {
  finishPending(chatId: string): void;
  recheck(chatId: string, taskId: string): boolean;
  resumeBuild(chatId: string): boolean;
  kick(chatId: string): void;
  writeProgress(chatId: string, halted?: string): void;
  buildStatus(chatId: string): { status: BuildState; reasons: BuildStop[] };
}

interface Delivery {
  spec: AgentSpec;
  taskId: string;
  promptId: string;
  line: string;
}

/** A task in one of these states holds back every task that lists one of its files. */
const HOLDS_FILES: readonly TaskState[] = ["assigned", "working", "checking", "failed", "parked", "escalated"];
/** A worker with a task in one of these states is not free for another task. */
const HOLDS_WORKER: readonly TaskState[] = ["assigned", "working", "checking", "failed", "parked"];
/** The agent is in the middle of this task's turn. */
const IN_TURN: readonly TaskState[] = ["parked", "working", "assigned", "failed"];
const LOG_LINES = 200;
/** Failed runs of one phase's checkpoint before the build stops. */
export const CHECKPOINT_RUNS = 3;

const slashed = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");
const dirOf = (e: string) => (e.endsWith("/") ? e : "");

/** Two file lists overlap when they share a path, or one lists a folder (a path that ends with `/`) that holds a path of the other. */
function overlap(a: string[], b: string[]): boolean {
  return a.some((x) => b.some((y) => {
    const p = slashed(x);
    const q = slashed(y);
    return p === q || (dirOf(p) !== "" && q.startsWith(p)) || (dirOf(q) !== "" && p.startsWith(q));
  }));
}

/** The task an agent is in a turn for, or null. */
export function activeTask(st: RunState, agent: string): string | null {
  for (const want of IN_TURN) {
    const hit = Object.entries(st.tasks).find(([, t]) => t.agent === agent && t.state === want);
    if (hit) return hit[0];
  }
  return null;
}

export class BuildLoop implements HaltLoop {
  private readonly max: number;
  private readonly work = new Set<Promise<unknown>>();
  /** Checks in the queue or running, by `chat/task`. */
  private readonly running = new Set<string>();
  /**
   * The line that `deliver` sends, or sent, for each task's current prompt, by `chat/task`. The turn that this line starts is the
   * task's turn. A turn that began with another text (Codex's role line, a line the owner typed) is not.
   */
  private readonly lines = new Map<string, string>();
  /** Per chat: tasks whose failure did not count and whose check waits for a quiet worktree, or runs again. */
  private readonly noisy = new Map<string, Set<string>>();
  private readonly cpRunning = new Set<string>();
  /** The last TASKS.md that parsed, per chat. */
  private readonly docs = new Map<string, TasksDoc>();
  /** Chats whose feature folder is missing. The build is stopped in memory: nothing can be written there. */
  private readonly folderGone = new Set<string>();
  /** The build as last read from run/state.json, for a chat whose folder is gone. */
  private readonly lastBuild = new Map<string, { status: BuildState; reasons: BuildStop[] }>();
  private readonly tasksProblem = new Map<string, string>();
  /** For a repo that commits no plan files: the plan edits the orchestrator was told about, by chat. */
  private readonly announced = new Map<string, Map<string, string>>();

  constructor(private readonly deps: LoopDeps) {
    this.max = deps.maxAttempts ?? 3;
  }

  // ───────────────────────────── public: build ─────────────────────────────

  /** Starts the build. Refused while the plan has a problem or TASKS.md does not parse (C2). */
  start(chatId: string): { ok: true } | { ok: false; problems: PlanProblem[] } {
    const info = this.deps.chat(chatId);
    const problems = validatePlan(info.featureDir);
    try {
      this.parse(chatId);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      if (!problems.some((p) => p.file === "TASKS.md")) problems.unshift({ file: "TASKS.md", line: e.line, code: "tasks-unreadable", text: `TASKS.md line ${e.line}: ${e.reason}` });
    }
    if (problems.length > 0) return { ok: false, problems };
    const eff = this.effective(chatId);
    const r = nextBuild(eff.status, "start", { reasons: eff.reasons });
    if (isInvalid(r)) {
      this.log(chatId, `start while ${eff.status}: ${r.invalid}`);
      return { ok: true };
    }
    if (r.effects.includes("commitPlanFiles")) {
      this.commitPlan(chatId, info);
      // With no plan commit the plan files stay in the list of changed files: what is there at the start is the plan, not an edit.
      if (info.commitPlanFiles === false) this.newPlanEdits(chatId, info, this.planEdits(chatId, info));
    }
    // The branch's commit at the start, plus the plan commit above, is what the engine made: a commit above it is not the engine's.
    this.trackCommits(chatId, null);
    this.setBuild(chatId, r);
    this.update(chatId, (s) => {
      s.build.startedAt = new Date(this.deps.clock.now()).toISOString();
    });
    this.publish(chatId);
    this.kick(chatId);
    return { ok: true };
  }

  /** The build as the loop sees it, including a stop for a missing folder. */
  buildStatus(chatId: string): { status: BuildState; reasons: BuildStop[] } {
    return this.effective(chatId);
  }

  /** Looks at the chat again: reads TASKS.md, runs a checkpoint that is due, and hands out tasks. */
  kick(chatId: string): void {
    this.track(this.dispatch(chatId).catch((e: unknown) => this.log(chatId, `dispatch failed: ${(e as Error).message}`)));
  }

  /** Resolves when no work is in flight. Checks that wait in the queue are not work. */
  async settled(): Promise<void> {
    for (let i = 0; i < 3; i++) {
      await new Promise((r) => setTimeout(r, 0));
      while (this.work.size > 0) await Promise.all([...this.work]);
    }
  }

  /** The orchestrator added a task, or a fix list came: a `done` build runs again. */
  taskAdded(chatId: string): void {
    this.buildEvent(chatId, "taskAdded");
    this.kick(chatId);
  }

  /** The orchestrator's turn after a failed checkpoint ended with no new task: the build stops. */
  checkpointUndecided(chatId: string): void {
    this.buildEvent(chatId, "checkpointFailed");
  }

  /** The Resume of a build that stopped on its checkpoint. The checkpoint gets 3 more runs. */
  resumeBuild(chatId: string): boolean {
    const eff = this.effective(chatId);
    if (eff.status !== "stopped" || !eff.reasons.includes("checkpoint")) return false;
    const r = this.buildEvent(chatId, "ownerResume");
    if (!r) return false;
    if (r.effects.includes("resetCheckpointRuns")) {
      this.update(chatId, (s) => {
        for (const c of Object.values(s.checkpoints)) {
          c.fails = 0;
          delete c.at;
        }
      });
    }
    this.kick(chatId);
    return true;
  }

  // ───────────────────────────── public: events ─────────────────────────────

  /** One event of an agent. It never throws. */
  handle(e: AgentEvent): void {
    if (e.type === "usage") return;
    const chat = e.chat;
    try {
      if (e.type === "turnStart") this.onTurnStart(chat, e.agent, e.prompt);
      else if (e.type === "turnEnd") this.onTurnEnd(chat, e.agent);
      // A worker that waited at a question of the owner's is ready: a prompt that was written and not sent goes out again.
      else if ((e.type === "started" || e.type === "signal") && this.deps.workers(chat).some((w) => w.id === e.agent)) this.kick(chat);
      this.rerunWhenQuiet(chat);
    } catch (err) {
      this.log(chat, `event ${e.type} of ${e.agent} failed: ${(err as Error).message}`);
    }
  }

  // ───────────────────────────── public: task commands ─────────────────────────────

  /** `escalated` → `queued` (the orchestrator, once for each task) or `blocked` → `queued` (the owner). */
  retry(chatId: string, taskId: string, by: "orchestrator" | "owner"): boolean {
    const r = this.transition(chatId, taskId, by === "owner" ? "ownerRetry" : "orchestratorRetry", { agent: null, parkedBy: null, reason: undefined });
    if (!r) return false;
    if (r.effects.includes("applyPatch")) this.applyPatchOf(chatId, taskId);
    this.publish(chatId);
    this.kick(chatId);
    return true;
  }

  /** The orchestrator blocks a task for the owner. The task's edits are set aside. */
  block(chatId: string, taskId: string, reason: string): boolean {
    const task = this.taskLine(chatId, taskId);
    const r = this.transition(chatId, taskId, "orchestratorBlock", { reason });
    if (!r) return false;
    if (r.effects.includes("savePatch")) this.setAsideOf(chatId, taskId, task?.files ?? []);
    this.publish(chatId);
    this.kick(chatId);
    return true;
  }

  /** A task is dropped. Its line leaves TASKS.md and the reason goes under "Dropped". */
  drop(chatId: string, taskId: string, reason: string, by: "orchestrator" | "owner"): boolean {
    const task = this.taskLine(chatId, taskId);
    const r = this.transition(chatId, taskId, by === "owner" ? "ownerDrop" : "orchestratorDrop", { reason });
    if (!r) return false;
    if (r.effects.includes("savePatch")) this.setAsideOf(chatId, taskId, task?.files ?? []);
    if (r.effects.includes("removeLine")) {
      this.removeLine(chatId, taskId);
      this.update(chatId, (s) => {
        s.dropped = [...s.dropped, { task: taskId, text: task?.text ?? "", reason }];
      });
    }
    this.publish(chatId);
    this.kick(chatId);
    return true;
  }

  /** The orchestrator's turn for an escalated task ended and the task is still `escalated`: it is blocked. */
  undecided(chatId: string, taskId: string): boolean {
    const task = this.taskLine(chatId, taskId);
    const r = this.transition(chatId, taskId, "orchestratorTurnEndedUndecided", { reason: "the orchestrator did not decide" });
    if (!r) return false;
    if (r.effects.includes("savePatch")) this.setAsideOf(chatId, taskId, task?.files ?? []);
    this.publish(chatId);
    return true;
  }

  /**
   * The orchestrator replaced the task's line with its parts. The old id is `dropped`, so it no longer holds its files.
   * Its line is already gone from TASKS.md, and a split is not a drop: nothing goes under "Dropped".
   */
  split(chatId: string, taskId: string): boolean {
    const r = this.transition(chatId, taskId, "split");
    if (!r) return false;
    this.publish(chatId);
    this.kick(chatId);
    return true;
  }

  // ───────────────────────────── public: one agent ─────────────────────────────

  /** Escape to one agent. It is `paused`, and its `working` task is `parked`. */
  async pause(chatId: string, agent: string): Promise<void> {
    const status = this.deps.agents.status(chatId, agent);
    if (status === null) return;
    const r = nextAgent(status, "paused");
    if (isInvalid(r)) {
      this.log(chatId, `pause of ${agent} while ${status}: ${r.invalid}`);
      return;
    }
    if (r.effects.includes("sendEscape")) await this.deps.agents.interrupt(chatId, agent);
    this.deps.agents.mark(chatId, agent, r.state);
    const st = this.read(chatId);
    for (const [id, t] of Object.entries(st.tasks)) {
      if (t.agent === agent && t.state === "working") this.transition(chatId, id, "agentPaused", { parkedBy: "pause" });
    }
    this.publish(chatId);
  }

  /** Undoes Pause: "continue <task>", or "continue" for an agent with no task. */
  async resumeAgent(chatId: string, agent: string): Promise<void> {
    const status = this.deps.agents.status(chatId, agent);
    if (status === null) return;
    const r = nextAgent(status, "resumed");
    if (isInvalid(r)) {
      this.log(chatId, `resume of ${agent} while ${status}: ${r.invalid}`);
      return;
    }
    this.deps.agents.mark(chatId, agent, r.state);
    let st = this.read(chatId);
    for (const [id, t] of Object.entries(st.tasks)) {
      if (t.agent === agent && t.state === "parked" && t.parkedBy === "pause") this.transition(chatId, id, "agentResumed", { parkedBy: null });
    }
    st = this.read(chatId);
    const task = activeTask(st, agent);
    this.publish(chatId);
    if (r.effects.includes("sendContinue")) await this.deps.agents.send(chatId, agent, task ? `continue ${task}` : "continue");
  }

  // ───────────────────────────── public: questions ─────────────────────────────

  /**
   * A worker asked a question (A15): its `working` task is `parked`, and the files stay held by the ready rule.
   * A task that a pause parked takes the question as its cause: Resume then leaves it parked until the answer.
   */
  asked(chatId: string, taskId: string): void {
    const cur = this.read(chatId).tasks[taskId];
    if (cur?.state === "parked") {
      this.update(chatId, (s) => {
        const t = s.tasks[taskId];
        if (t) t.parkedBy = "question";
      });
    } else if (cur?.state === "working") {
      this.transition(chatId, taskId, "ask", { parkedBy: "question" });
    } else {
      this.log(chatId, `${taskId}: a question came while the task is ${cur?.state ?? "unknown"}: no task was parked`);
      return;
    }
    this.publish(chatId);
  }

  /**
   * The question was answered: the task goes back to `working`. A task whose agent is also paused stays
   * `parked`, now for the pause alone, until Resume.
   */
  answered(chatId: string, taskId: string): void {
    const cur = this.read(chatId).tasks[taskId];
    if (cur?.state !== "parked" || cur.parkedBy !== "question") {
      this.log(chatId, `${taskId}: an answer came while the task is ${cur?.state ?? "unknown"}${cur?.parkedBy ? ` (parked by ${cur.parkedBy})` : ""}: nothing to unpark`);
      return;
    }
    if (cur.agent && this.deps.agents.status(chatId, cur.agent) === "paused") {
      this.update(chatId, (s) => {
        const t = s.tasks[taskId];
        if (t) t.parkedBy = "pause";
      });
    } else {
      this.transition(chatId, taskId, "answer", { parkedBy: null });
    }
    this.publish(chatId);
  }

  // ───────────────────────────── public: for Halt and restart ─────────────────────────────

  /** Finishes a passed task's commit that was not made. Once, and the same after an engine restart. (D19, E3) */
  finishPending(chatId: string): void {
    const st = this.read(chatId);
    const p = st.pendingCommit;
    if (!p) return;
    const info = this.deps.chat(chatId);
    let others: Record<string, string[]> = {};
    const doc = this.tryParse(chatId);
    if (doc) {
      others = {};
      for (const t of allTasks(doc)) {
        if (t.id !== p.task && this.stateIn(st, t) !== "verified") others[t.id] = t.files;
      }
    }
    try {
      const res = commitTask({ worktree: info.worktree, taskId: p.task, text: p.text, files: p.files, otherTasks: others });
      this.update(chatId, (s) => {
        s.pendingCommit = null;
        s.outside = res.outside.filter((f) => !this.isPlanFile(chatId, f));
      });
      this.trackCommits(chatId, res.commit);
    } catch (e) {
      this.log(chatId, `the commit of ${p.task} failed: ${(e as Error).message}`);
    }
  }

  /**
   * The check of a `checking` task goes into the queue again, after Resume (E2).
   * Without a task id: every `checking` task of the chat, after an engine restart (D16, F4). Returns the task ids.
   */
  recheck(chatId: string): string[];
  recheck(chatId: string, taskId: string): boolean;
  recheck(chatId: string, taskId?: string): boolean | string[] {
    if (taskId === undefined) {
      if (this.deps.chat(chatId).halted) return [];
      const ids = Object.entries(this.read(chatId).tasks)
        .filter(([, t]) => t.state === "checking")
        .map(([id]) => id);
      return ids.filter((id) => this.recheck(chatId, id));
    }
    if (this.deps.chat(chatId).halted) return false;
    const r = this.transition(chatId, taskId, "chatResumed");
    if (!r || !r.effects.includes("queueCheck")) return false;
    this.enqueueCheck(chatId, taskId);
    return true;
  }

  /** Writes run/progress.md from TASKS.md and the state. `halted` is HH:MM. */
  writeProgress(chatId: string, halted?: string): void {
    const info = this.deps.chat(chatId);
    if (!existsSync(info.featureDir)) return;
    const doc = this.tryParse(chatId);
    if (!doc) return;
    const st = this.read(chatId);
    const now = allTasks(doc)
      .map((t) => ({ t, s: this.stateIn(st, t) }))
      .filter(({ s }) => s !== "queued" && s !== "verified" && s !== "dropped")
      .map(({ t, s }) => `${t.id} ${st.tasks[t.id]?.agent ?? "-"}: ${s}`);
    const text = renderProgress({ title: info.slug, phases: counts(doc).phases, now, outside: st.outside, fromTerminal: [], manual: [], ...(halted ? { halted } : {}) });
    writeRunFile(join(info.featureDir, "run", "progress.md"), () => text);
  }

  // ───────────────────────────── handing out ─────────────────────────────

  private async dispatch(chat: string): Promise<void> {
    if (this.read(chat).pendingCommit) this.finishPending(chat);
    const deliveries = this.assign(chat);
    await Promise.all(deliveries.map((d) => this.deliver(chat, d)));
  }

  /** The synchronous half of handing out: decides, writes the state and the prompt files. */
  private assign(chat: string): Delivery[] {
    const doc = this.gate(chat);
    if (!doc) return [];
    if ((this.noisy.get(chat)?.size ?? 0) > 0) return [];
    const st0 = this.read(chat);
    const cur = this.currentPhase(doc, st0);
    if (!cur) {
      this.finishBuild(chat);
      return [];
    }
    if (cur.tasks.length > 0 && cur.tasks.every((t) => this.stateIn(st0, t) === "verified")) {
      this.checkpointDue(chat, cur, st0);
      return [];
    }

    const specs = this.deps.workers(chat);
    let out: Delivery[] = [];
    // A prompt that was written and never sent goes out again.
    for (const t of allTasks(doc)) {
      const run = st0.tasks[t.id];
      if (!run?.agent || (run.state !== "assigned" && run.state !== "failed")) continue;
      const spec = specs.find((s) => s.id === run.agent);
      const last = this.lastPrompt(chat, run.agent, t.id);
      if (!spec || !last || st0.sent.includes(last.id)) continue;
      out = [...out, { spec, taskId: t.id, promptId: last.id, line: this.lineFor(run.state, t.id, last.file, run.attempts) }];
    }

    for (const t of cur.tasks) {
      const st = this.read(chat);
      if (this.stateIn(st, t) !== "queued") continue;
      const idx = cur.tasks.indexOf(t);
      const before = cur.tasks.slice(0, idx);
      const waitsFor = t.parallel ? before.filter((b) => !b.parallel) : before;
      if (!waitsFor.every((b) => this.stateIn(st, b) === "verified")) continue;
      const inFlight = allTasks(doc).filter((o) => o.id !== t.id && HOLDS_FILES.includes(this.stateIn(st, o)));
      if (inFlight.some((o) => overlap(o.files, t.files))) continue;
      const busy = new Set(Object.values(st.tasks).filter((r) => r.agent && HOLDS_WORKER.includes(r.state)).map((r) => r.agent));
      const spec = specs.find((s) => !busy.has(s.id) && this.isFree(chat, s.id));
      if (!spec) break;
      const r = this.transition(chat, t.id, "assign", { agent: spec.id });
      if (!r) continue;
      const n = this.nextVersion(chat, spec.id, t.id);
      const file = this.promptPath(chat, spec.id, t.id, n);
      const info = this.deps.chat(chat);
      const verify = t.verify ?? `checked by a person: ${t.verifyNote}`;
      const text = rolePrompt("worker", { chatTitle: info.slug, stage: "build", worktree: info.worktree, featureFolder: info.featureDir, task: { id: t.id, text: t.text, files: t.files, verify } });
      this.writePrompt(file, text);
      out = [...out, { spec, taskId: t.id, promptId: `${spec.id}-${t.id}-v${n}`, line: this.lineFor("assigned", t.id, file, 0) }];
    }
    if (out.length > 0) this.publish(chat);
    return out;
  }

  private isFree(chat: string, agent: string): boolean {
    const s = this.deps.agents.status(chat, agent);
    return s === null || s === "idle";
  }

  private lineFor(state: TaskState, task: string, file: string, attempts: number): string {
    return state === "failed" ? `Task ${task}: the check failed (attempt ${attempts} of ${this.max}). Read ${file} and fix it.` : `Task ${task}: read ${file} and do what it says.`;
  }

  /** Records the prompt id first, then ensures the agent and sends one line. A prompt id goes out once. */
  private async deliver(chat: string, d: Delivery): Promise<void> {
    const box = { fresh: false };
    this.update(chat, (s) => {
      if (s.sent.includes(d.promptId)) return;
      s.sent = [...s.sent, d.promptId];
      box.fresh = true;
    });
    if (!box.fresh) return;
    this.lines.set(`${chat}/${d.taskId}`, d.line);
    try {
      await this.deps.agents.ensure(chat, d.spec);
      await this.deps.agents.send(chat, d.spec.id, d.line);
    } catch (e) {
      this.lines.delete(`${chat}/${d.taskId}`);
      this.update(chat, (s) => {
        s.sent = s.sent.filter((x) => x !== d.promptId);
      });
      this.log(chat, `the prompt ${d.promptId} was not sent: ${(e as Error).message}`);
    }
  }

  // ───────────────────────────── the phase and its checkpoint ─────────────────────────────

  private phaseEnded(phase: Phase, st: RunState): boolean {
    if (phase.tasks.length === 0 || !phase.tasks.every((t) => this.stateIn(st, t) === "verified")) return false;
    if (!phase.checkpoint?.command) return true;
    return st.checkpoints[String(phase.n)]?.passed === true;
  }

  private currentPhase(doc: TasksDoc, st: RunState): Phase | null {
    return doc.phases.find((p) => !this.phaseEnded(p, st)) ?? null;
  }

  private finishBuild(chat: string): void {
    const r = this.buildEvent(chat, "lastPhaseEnded");
    if (!r) return;
    this.planStep(chat, true);
    this.writeProgress(chat);
    this.publish(chat);
  }

  private checkpointDue(chat: string, phase: Phase, st: RunState): void {
    const cmd = phase.checkpoint?.command;
    if (!cmd) return;
    const key = `${chat}/cp${phase.n}`;
    if (this.cpRunning.has(key)) return;
    const c = st.checkpoints[String(phase.n)] ?? { fails: 0 };
    // After a failure the engine waits for the fix tasks: it runs again when more tasks are verified.
    if (c.at !== undefined && phase.tasks.length <= c.at) return;
    const info = this.deps.chat(chat);
    const box = { run: 0 };
    this.update(chat, (s) => {
      const cur = s.checkpoints[String(phase.n)] ?? { fails: 0 };
      cur.runs = (cur.runs ?? 0) + 1;
      box.run = cur.runs;
      s.checkpoints[String(phase.n)] = cur;
    });
    const logPath = join(info.featureDir, "run", "logs", `checkpoint-${phase.n}-${box.run}.log`);
    mkdirSync(join(info.featureDir, "run", "logs"), { recursive: true });
    this.cpRunning.add(key);
    this.deps.checks
      .enqueue({ id: `${chat}:checkpoint-${phase.n}:${box.run}`, chat, name: `checkpoint-${phase.n}`, cmd, cwd: info.worktree, heavy: info.heavy(cmd), logPath })
      .then((r) => this.onCheckpoint(chat, phase.n, r))
      .catch((e: unknown) => {
        this.cpRunning.delete(key);
        this.log(chat, `the checkpoint of phase ${phase.n} failed to run: ${(e as Error).message}`);
      });
  }

  private onCheckpoint(chat: string, n: number, r: CheckResult): void {
    this.cpRunning.delete(`${chat}/cp${n}`);
    if (r.outcome === "dropped") return; // Halt killed it. Resume runs it again.
    if (r.outcome === "pass" && r.exit === 0) {
      this.update(chat, (s) => {
        const c = s.checkpoints[String(n)] ?? { fails: 0 };
        c.passed = true;
        delete c.at;
        s.checkpoints[String(n)] = c;
      });
      this.publish(chat);
      this.kick(chat);
      return;
    }
    const doc = this.tryParse(chat);
    const phase = doc?.phases.find((p) => p.n === n);
    const box = { fails: 0 };
    this.update(chat, (s) => {
      const c = s.checkpoints[String(n)] ?? { fails: 0 };
      c.fails += 1;
      c.at = phase ? phase.tasks.length : 0;
      box.fails = c.fails;
      s.checkpoints[String(n)] = c;
    });
    const tail = (r.outcome === "timeout" ? "The checkpoint timed out.\n" : "") + tailLines(r.logPath, LOG_LINES);
    this.deps.orchestrator.checkpointFailed(chat, n, tail);
    if (box.fails >= CHECKPOINT_RUNS) this.buildEvent(chat, "checkpointFailed");
    this.publish(chat);
  }

  // ───────────────────────────── the build machine ─────────────────────────────

  private effective(chat: string): { status: BuildState; reasons: BuildStop[] } {
    const dir = this.deps.chat(chat).featureDir;
    let status: BuildState = "notStarted";
    let reasons: BuildStop[] = [];
    if (existsSync(dir)) {
      const b = this.read(chat).build;
      status = b.status;
      reasons = b.reasons ?? (b.reason ? [b.reason.kind] : []);
      if (status === "stopped" && reasons.length === 0) reasons = ["checkpoint"];
      this.lastBuild.set(chat, { status, reasons });
    } else {
      const last = this.lastBuild.get(chat);
      if (last) ({ status, reasons } = last);
    }
    if (this.folderGone.has(chat) && status !== "notStarted" && status !== "done") return { status: "stopped", reasons: [...reasons.filter((r) => r !== "folder"), "folder"] };
    return { status, reasons };
  }

  private setBuild(chat: string, r: BuildResult): void {
    const kept = r.reasons.filter((x) => x !== "folder");
    if (r.reasons.includes("folder")) this.folderGone.add(chat);
    else this.folderGone.delete(chat);
    // A build that is stopped only for a missing folder stays `running` on disk: the folder comes back, and it runs.
    const status: BuildState = r.state === "stopped" && kept.length === 0 ? "running" : r.state;
    this.lastBuild.set(chat, { status, reasons: kept });
    const first = kept[0];
    this.update(chat, (s) => {
      s.build.status = status;
      s.build.reasons = kept;
      s.build.reason = first ? { kind: first, text: this.reasonText(chat, first) } : null;
    });
  }

  private reasonText(chat: string, kind: BuildStop): string {
    if (kind === "tasks") return this.tasksProblem.get(chat) ?? "TASKS.md has a line the parser cannot read";
    if (kind === "folder") return "Feature folder missing";
    return "Checkpoint failed";
  }

  private buildEvent(chat: string, event: BuildEvent): BuildResult | null {
    const eff = this.effective(chat);
    const r = nextBuild(eff.status, event, { reasons: eff.reasons });
    if (isInvalid(r)) {
      this.log(chat, `build ${event} while ${eff.status}: ${r.invalid}`);
      return null;
    }
    this.setBuild(chat, r);
    this.publish(chat);
    return r;
  }

  /**
   * Looks at the folder and at TASKS.md and applies the build events that follow (C2, C4).
   * Returns the parsed file when the build runs and the loop may hand out tasks.
   */
  private gate(chat: string): TasksDoc | null {
    const info = this.deps.chat(chat);
    if (info.halted) return null;
    let eff = this.effective(chat);
    if (eff.status === "notStarted" || eff.status === "done") return null;
    if (!existsSync(info.featureDir)) {
      if (!eff.reasons.includes("folder")) this.buildEvent(chat, "folderMissing");
      return null;
    }
    if (eff.reasons.includes("folder")) this.buildEvent(chat, "folderBack");
    let doc: TasksDoc;
    try {
      doc = this.parse(chat);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      this.tasksProblem.set(chat, `${e.file} line ${e.line}: ${e.reason}`);
      if (!this.effective(chat).reasons.includes("tasks")) this.buildEvent(chat, "tasksUnreadable");
      return null;
    }
    if (this.effective(chat).reasons.includes("tasks")) this.buildEvent(chat, "tasksReadable");
    eff = this.effective(chat);
    if (eff.status !== "running") return null;
    return this.reconcile(chat, doc);
  }

  /** A task that is `verified` in the state keeps its box checked, also after a crash between the two writes. */
  private reconcile(chat: string, doc: TasksDoc): TasksDoc {
    const st = this.read(chat);
    let cur = doc;
    for (const t of allTasks(doc)) {
      if (!t.done && st.tasks[t.id]?.state === "verified") {
        try {
          cur = checkTask(cur, t.id);
        } catch (e) {
          this.log(chat, `the box of ${t.id} was not checked: ${(e as Error).message}`);
        }
      }
    }
    if (cur !== doc) {
      writeRunFile(join(this.deps.chat(chat).featureDir, "TASKS.md"), () => serialize(cur));
      this.docs.set(chat, cur);
    }
    return cur;
  }

  // ───────────────────────────── agent events ─────────────────────────────

  /**
   * The task's turn begins when the tool starts the task's own prompt. A turn of any other text is not the task's turn, and its end
   * must not send the task to `checking`: Codex reports its role line's turn only when it ends, which can be after the task's line
   * went in. After an engine restart the line is not known, and the turn counts.
   */
  private onTurnStart(chat: string, agent: string, prompt: string): void {
    const st = this.read(chat);
    const hit = Object.entries(st.tasks).find(([, t]) => t.agent === agent && (t.state === "assigned" || t.state === "failed"));
    if (!hit) return;
    const line = this.lines.get(`${chat}/${hit[0]}`);
    const text = prompt.trim();
    // `continue <task>` is the engine's own line after Pause or Halt. Codex reports a turn only when it ends, so a task whose
    // turn was cut by Escape is still `assigned`, and the turn of this line is that task's turn. The tool may also keep the task's
    // line in its input box, so that the prompt holds the task's line and the continue line together.
    if (line !== undefined && text !== "" && !text.includes(line.trim()) && text !== `continue ${hit[0]}`) {
      this.log(chat, `${hit[0]}: a turn of another text began while the task waits for its own: it is not the task's turn`);
      return;
    }
    this.transition(chat, hit[0], "turnStart");
  }

  private onTurnEnd(chat: string, agent: string): void {
    const st = this.read(chat);
    const mine = Object.entries(st.tasks).filter(([, t]) => t.agent === agent);
    const working = mine.find(([, t]) => t.state === "working");
    if (!working) {
      // A parked task is not checked when its turn ends. The table says so; the line records it.
      const parked = mine.find(([, t]) => t.state === "parked");
      if (parked) this.transition(chat, parked[0], "turnEnd");
      return;
    }
    const id = working[0];
    const task = this.taskLine(chat, id);
    if (task && task.verify === null) {
      // Prose cannot be checked by the engine. A person does it.
      if (this.transition(chat, id, "manualCheck", { reason: "manual check" })) this.kick(chat);
      this.publish(chat);
      return;
    }
    const r = this.transition(chat, id, "turnEnd");
    if (r?.effects.includes("queueCheck")) this.enqueueCheck(chat, id);
    this.publish(chat);
  }

  // ───────────────────────────── checks ─────────────────────────────

  private enqueueCheck(chat: string, id: string): void {
    const info = this.deps.chat(chat);
    if (info.halted) return;
    const key = `${chat}/${id}`;
    if (this.running.has(key)) return;
    const task = this.taskLine(chat, id);
    if (!task?.verify) return;
    const box = { run: 0 };
    this.update(chat, (s) => {
      const t = s.tasks[id];
      if (!t) return;
      t.runs += 1;
      box.run = t.runs;
    });
    if (box.run === 0) return;
    mkdirSync(join(info.featureDir, "run", "logs"), { recursive: true });
    const logPath = join(info.featureDir, "run", "logs", `${id}-${box.run}.log`);
    this.running.add(key);
    this.deps.checks
      .enqueue({ id: `${chat}:${id}:${box.run}`, chat, name: id, cmd: task.verify, cwd: info.worktree, heavy: info.heavy(task.verify), logPath })
      .then((r) => this.onResult(chat, id, r))
      .catch((e: unknown) => {
        this.running.delete(key);
        this.log(chat, `the check of ${id} failed to run: ${(e as Error).message}`);
      });
  }

  private onResult(chat: string, id: string, r: CheckResult): void {
    this.running.delete(`${chat}/${id}`);
    const cur = this.read(chat).tasks[id];
    if (cur?.state !== "checking") {
      this.log(chat, `the result of ${id} (${r.outcome}) came while the task is ${cur?.state ?? "unknown"}: ignored`);
      return;
    }
    if (r.outcome === "dropped") {
      // Halt killed it. It is not an attempt, and Resume queues the check again.
      this.transition(chat, id, "checkKilled");
      return;
    }
    // A task is checked off only for a check that exited 0.
    if (r.outcome === "pass" && r.exit === 0) this.onPass(chat, id, cur.agent);
    else this.onFail(chat, id, r);
  }

  private onPass(chat: string, id: string, agent: string | null): void {
    this.noisy.get(chat)?.delete(id);
    const task = this.taskLine(chat, id);
    const r = this.transition(chat, id, "checkPass");
    if (!r) return;
    const files = task?.files ?? [];
    if (r.effects.includes("commit")) {
      this.update(chat, (s) => {
        s.pendingCommit = { task: id, text: task?.text ?? "", files };
      });
    }
    this.writeBox(chat, id);
    this.finishPending(chat);
    this.boundary(chat);
    if (agent) this.deps.onTaskEnded?.(chat, agent, id);
    this.kick(chat);
  }

  private onFail(chat: string, id: string, r: CheckResult): void {
    const cur = this.read(chat).tasks[id];
    const agent = cur?.agent ?? null;
    // D17: a failure while another worker is in a turn does not count. The check runs again in a quiet worktree.
    const busy = this.deps.workers(chat).some((w) => w.id !== agent && this.deps.agents.status(chat, w.id) === "working");
    if (busy) {
      if (this.transition(chat, id, "checkFailNoisy")) {
        const set = this.noisy.get(chat) ?? new Set<string>();
        this.noisy.set(chat, set.add(id));
      }
      return;
    }
    this.noisy.get(chat)?.delete(id);
    const res = this.transition(chat, id, "checkFailCounted");
    if (!res) return;
    const tail = (r.outcome === "timeout" ? "The check timed out.\n" : "") + tailLines(r.logPath, LOG_LINES);
    const task = this.taskLine(chat, id);
    for (const effect of res.effects) {
      if (effect === "sendLogToWorker") this.sendLog(chat, id, res, tail, r);
      else if (effect === "callOrchestrator") this.deps.orchestrator.escalated(chat, id, tail);
      else if (effect === "savePatch") this.setAsideOf(chat, id, task?.files ?? []);
    }
    if (res.state === "blocked") {
      this.update(chat, (s) => {
        const t = s.tasks[id];
        if (t) t.reason = "the check failed again after a retry";
      });
    }
    this.boundary(chat);
    this.kick(chat);
  }

  /** D7: the last 200 lines go back to the same worker, as a file and one line. */
  private sendLog(chat: string, id: string, res: TaskResult, tail: string, r: CheckResult): void {
    const agent = this.read(chat).tasks[id]?.agent;
    const spec = this.deps.workers(chat).find((w) => w.id === agent);
    if (!agent || !spec) return;
    const task = this.taskLine(chat, id);
    const n = this.nextVersion(chat, agent, id);
    const file = this.promptPath(chat, agent, id, n);
    const how = r.outcome === "timeout" ? "timed out" : `failed with exit code ${r.exit ?? "none"}`;
    const text = [
      `# The check of ${id} ${how}`,
      "",
      `Attempt ${res.attempts} of ${this.max}.`,
      `The command: \`${task?.verify ?? ""}\``,
      "",
      `The last ${LOG_LINES} lines of its log:`,
      "",
      "```",
      tail,
      "```",
      "",
      `Fix the task. Before your turn ends, run \`starship check ${id}\`.`,
      "",
    ].join("\n");
    this.writePrompt(file, text);
    this.track(this.deliver(chat, { spec, taskId: id, promptId: `${agent}-${id}-v${n}`, line: this.lineFor("failed", id, file, res.attempts) }));
  }

  /** Runs the checks that waited for a quiet worktree, once no worker of the chat has the status `working`. */
  private rerunWhenQuiet(chat: string): void {
    const waiting = this.noisy.get(chat);
    if (!waiting || waiting.size === 0) return;
    if (this.deps.chat(chat).halted) return;
    if (this.deps.workers(chat).some((w) => this.deps.agents.status(chat, w.id) === "working")) return;
    for (const id of waiting) this.enqueueCheck(chat, id);
  }

  // ───────────────────────────── at a task boundary ─────────────────────────────

  private boundary(chat: string): void {
    this.trackCommits(chat, null); // a commit that a worker made, since the last boundary
    this.gate(chat); // C2: TASKS.md that no longer parses stops the build here, and a parse that works again restarts it.
    this.planStep(chat, false);
    this.writeProgress(chat);
    this.publish(chat);
    this.deps.onBoundary?.(chat);
  }

  /** Commits the plan files, and tells the orchestrator which ones changed. TASKS.md alone changes with every task. */
  private planStep(chat: string, always: boolean): void {
    const info = this.deps.chat(chat);
    let files: string[];
    try {
      files = changedFiles(info.worktree).filter((f) => this.isPlanFile(chat, f));
    } catch (e) {
      this.log(chat, `the plan files could not be listed: ${(e as Error).message}`);
      return;
    }
    const others = files.filter((f) => f !== this.tasksMd(chat));
    if (files.length === 0 || (others.length === 0 && !always)) return;
    const edited = this.newPlanEdits(chat, info, others);
    if (edited.length > 0) this.deps.orchestrator.planChanged?.(chat, edited);
    this.commitPlan(chat, info);
  }

  private tasksMd(chat: string): string {
    return `${this.featureRel(chat)}/TASKS.md`;
  }

  /** The changed plan files except TASKS.md, which changes with every task. An empty list when git cannot list them. */
  private planEdits(chat: string, info: ChatInfo): string[] {
    try {
      return changedFiles(info.worktree).filter((f) => this.isPlanFile(chat, f) && f !== this.tasksMd(chat));
    } catch {
      return [];
    }
  }

  /** Commits the plan files, unless the repo says `commitPlanFiles: false`. A failure is logged and the build goes on. */
  private commitPlan(chat: string, info: ChatInfo): void {
    if (info.commitPlanFiles === false) return;
    try {
      const made = commitPlanFiles({ worktree: info.worktree, featureFolder: info.featureDir, slug: info.slug });
      this.trackCommits(chat, made);
    } catch (e) {
      this.log(chat, `the plan commit failed: ${(e as Error).message}`);
    }
  }

  /**
   * Workers must never commit, and a Codex worker has no hook that stops it. The engine does not undo such a commit. It keeps in the
   * state the commit that it made last (`lastCommit`; at first the branch's commit), and every commit above that one that it did not
   * make is added once to `foreignCommits`, which the chat's needs list shows. The build goes on.
   *
   * `mine` is a commit that the engine has just made: the walk goes up to it, so a worker's commit under it is found, and it is the new
   * `lastCommit`. With null the walk goes up to the branch's commit now. A failure of git is logged and changes nothing.
   */
  private trackCommits(chat: string, mine: string | null): void {
    try {
      const info = this.deps.chat(chat);
      const tip = mine ?? headCommit(info.worktree);
      if (tip === null) return;
      const known = this.read(chat).lastCommit;
      if (known === tip) return;
      const found = known === null ? [] : commitsBetween(info.worktree, known, tip).filter((c) => c.sha !== mine);
      const at = new Date(this.deps.clock.now()).toISOString();
      this.update(chat, (s) => {
        for (const c of found) if (!s.foreignCommits.some((f) => f.sha === c.sha)) s.foreignCommits.push({ sha: c.sha, subject: c.subject, at });
        s.lastCommit = tip;
      });
      if (found.length > 0) {
        this.log(chat, `a commit that the engine did not make: ${found.map((c) => `${c.sha.slice(0, 7)} ${c.subject}`).join("; ")}`);
        this.publish(chat);
      }
    } catch (e) {
      this.log(chat, `the commits could not be checked: ${(e as Error).message}`);
    }
  }

  /**
   * The files of `files` that the orchestrator was not told about yet. A committed plan file leaves the list of changed files, so
   * each of them is new. When the repo commits no plan files they stay in the list at every boundary: a file is new when its size
   * or its time differs from the one the orchestrator last heard of.
   */
  private newPlanEdits(chat: string, info: ChatInfo, files: string[]): string[] {
    if (info.commitPlanFiles !== false) return files;
    const known = this.announced.get(chat) ?? new Map<string, string>();
    this.announced.set(chat, known);
    const fresh: string[] = [];
    for (const f of files) {
      let stamp: string;
      try {
        const st = statSync(join(info.worktree, f));
        stamp = `${st.size}:${st.mtimeMs}`;
      } catch {
        stamp = "gone"; // a deleted plan file is a change too
      }
      if (known.get(f) === stamp) continue;
      known.set(f, stamp);
      fresh.push(f);
    }
    return fresh;
  }

  private featureRel(chat: string): string {
    const info = this.deps.chat(chat);
    return slashed(relative(info.worktree, info.featureDir));
  }

  /** A plan file: in the feature folder but not under run/, or a decision record. */
  private isPlanFile(chat: string, f: string): boolean {
    const rel = this.featureRel(chat);
    return (f.startsWith(`${rel}/`) && !f.startsWith(`${rel}/run/`)) || f.startsWith("docs/adr/");
  }

  // ───────────────────────────── TASKS.md ─────────────────────────────

  private tasksFile(chat: string): string {
    return join(this.deps.chat(chat).featureDir, "TASKS.md");
  }

  /** Parses TASKS.md. Throws ParseError, also for a file that is missing. */
  private parse(chat: string): TasksDoc {
    const file = this.tasksFile(chat);
    let text: string;
    try {
      text = readFileSync(file, "utf8");
    } catch {
      throw new ParseError("TASKS.md", 1, "TASKS.md is missing");
    }
    const doc = parseTasks(text, "TASKS.md");
    this.docs.set(chat, doc);
    return doc;
  }

  /** The file as it parses now, or the last copy that parsed. */
  private tryParse(chat: string): TasksDoc | null {
    try {
      return this.parse(chat);
    } catch (e) {
      if (!(e instanceof ParseError)) throw e;
      return this.docs.get(chat) ?? null;
    }
  }

  private taskLine(chat: string, id: string): Task | undefined {
    const doc = this.tryParse(chat);
    return doc ? findTask(doc, id) : undefined;
  }

  /** Checks the box of a verified task. A file that does not parse waits: `reconcile` checks it later. */
  private writeBox(chat: string, id: string): void {
    try {
      writeRunFile(this.tasksFile(chat), (text) => serialize(checkTask(parseTasks(text, "TASKS.md"), id)));
    } catch (e) {
      this.log(chat, `the box of ${id} was not checked: ${(e as Error).message}`);
    }
  }

  private removeLine(chat: string, id: string): void {
    try {
      writeRunFile(this.tasksFile(chat), (text) => {
        const doc = parseTasks(text, "TASKS.md");
        const t = findTask(doc, id);
        if (!t) return text;
        const lines = doc.lines.slice();
        lines.splice(t.line - 1, 1);
        const next = lines.join("\n");
        parseTasks(next, "TASKS.md"); // the file must still parse
        return next;
      });
    } catch (e) {
      this.log(chat, `the line of ${id} was not removed: ${(e as Error).message}`);
    }
  }

  // ───────────────────────────── patches ─────────────────────────────

  private setAsideOf(chat: string, id: string, files: string[]): void {
    const info = this.deps.chat(chat);
    try {
      setAside({ worktree: info.worktree, featureFolder: info.featureDir, taskId: id, run: this.read(chat).tasks[id]?.runs ?? 0, files });
    } catch (e) {
      this.log(chat, `the edits of ${id} were not set aside: ${(e as Error).message}`);
    }
  }

  private applyPatchOf(chat: string, id: string): void {
    const dir = join(this.deps.chat(chat).featureDir, "run", "patches");
    if (!existsSync(dir)) return;
    const runs = readdirSync(dir)
      .map((n) => n.match(new RegExp(`^${id}-(\\d+)\\.patch$`)))
      .filter((m): m is RegExpMatchArray => m !== null)
      .map((m) => Number(m[1]));
    if (runs.length === 0) return;
    try {
      applyAside({ worktree: this.deps.chat(chat).worktree, patch: join(dir, `${id}-${Math.max(...runs)}.patch`) });
    } catch (e) {
      this.log(chat, `the patch of ${id} was not applied: ${(e as Error).message}`);
    }
  }

  // ───────────────────────────── prompts ─────────────────────────────

  private promptDir(chat: string): string {
    return join(this.deps.chat(chat).featureDir, "run", "prompts");
  }

  private promptPath(chat: string, agent: string, task: string, n: number): string {
    return join(this.promptDir(chat), `${agent}-${task}-v${n}.md`);
  }

  private versions(chat: string, agent: string, task: string): number[] {
    const dir = this.promptDir(chat);
    if (!existsSync(dir)) return [];
    const prefix = `${agent}-${task}-v`;
    return readdirSync(dir)
      .filter((n) => n.startsWith(prefix) && n.endsWith(".md"))
      .map((n) => Number(n.slice(prefix.length, -3)))
      .filter((n) => Number.isInteger(n));
  }

  private nextVersion(chat: string, agent: string, task: string): number {
    return Math.max(0, ...this.versions(chat, agent, task)) + 1;
  }

  private lastPrompt(chat: string, agent: string, task: string): { id: string; file: string } | null {
    const v = this.versions(chat, agent, task);
    if (v.length === 0) return null;
    const n = Math.max(...v);
    return { id: `${agent}-${task}-v${n}`, file: this.promptPath(chat, agent, task, n) };
  }

  private writePrompt(file: string, text: string): void {
    mkdirSync(join(file, ".."), { recursive: true });
    writeFileSync(file, text);
  }

  // ───────────────────────────── state helpers ─────────────────────────────

  private read(chat: string): RunState {
    return readRunState(this.deps.chat(chat).featureDir);
  }

  /** Reads, changes and writes run/state.json. Nothing is written, and the folder is not made, when the folder is gone. */
  private update(chat: string, change: (s: RunState) => void): RunState | null {
    const dir = this.deps.chat(chat).featureDir;
    if (!existsSync(dir)) return null;
    return updateRunState(dir, change);
  }

  private stateIn(st: RunState, t: Task): TaskState {
    return st.tasks[t.id]?.state ?? (t.done ? "verified" : "queued");
  }

  /** The one way a task changes state: through the table. An invalid pair changes nothing and leaves a line in the log. */
  private transition(chat: string, id: string, event: TaskEvent, patch: Partial<TaskRun> = {}): TaskResult | null {
    const task = this.taskLine(chat, id);
    const base: TaskState = task?.done ? "verified" : "queued";
    const box: { r: TaskResult | null; why: string; from: TaskState } = { r: null, why: "", from: base };
    this.update(chat, (s) => {
      const cur = s.tasks[id] ?? emptyTaskRun(base);
      box.from = cur.state;
      const r = nextTask(cur.state, event, { attempts: cur.attempts, escalations: cur.escalations, max: this.max });
      if (isInvalid(r)) {
        box.why = r.invalid;
        return;
      }
      const next: TaskRun = { ...cur, ...patch, state: r.state, attempts: r.attempts, escalations: r.escalations };
      if (next.reason === undefined) delete next.reason;
      s.tasks[id] = next;
      box.r = r;
    });
    if (!box.r && box.why) this.log(chat, `${id}: ${event} while ${box.from}: ${box.why}`);
    return box.r;
  }

  private log(chat: string, line: string): void {
    try {
      const dir = this.deps.chat(chat).featureDir;
      if (!existsSync(dir)) return;
      mkdirSync(join(dir, "run", "logs"), { recursive: true });
      appendFileSync(join(dir, "run", "logs", "loop.log"), `${new Date(this.deps.clock.now()).toISOString()} ${line}\n`);
    } catch {
      // A log line is never worth a failure.
    }
  }

  private publish(chat: string): void {
    this.deps.publish(chat);
  }

  private track(p: Promise<unknown>): void {
    const q: Promise<unknown> = p.finally(() => this.work.delete(q));
    this.work.add(q);
  }
}

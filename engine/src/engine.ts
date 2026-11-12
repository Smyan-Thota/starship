/**
 * The engine: one of each part, connected. (PLAN.md "Design rules", "Task loop", "Chats, repos and stages")
 *
 *   Sessions ──events──▶ the loop, the chat service, the notes, the orchestrator, the questions, the usage switch
 *   RunQueue ◀──checks── the loop, `starship check`, the usage switch
 *
 * `createEngine` builds the parts and the one fan-out of agent events. `start` rebuilds what the last run left
 * (sessions, running builds, conversations, answers that wait). `stop` ends the engine's own timers and
 * subscriptions: the agents keep running in tmux.
 *
 * The routes (api.ts) call the operations of `Engine`. A refusal is a `Refused`: the route turns it into 400, 404 or 409.
 */
import { chmodSync, existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { rolePrompt } from "./agents/roles.ts";
import { shellQuote } from "./agents/tmux.ts";
import { ChatService, adminCwd } from "./chat.ts";
import { ChatError, appendMessage, getChat, listChats, saveChat } from "./chats.ts";
import { type Config, home, loadConfig, paths, workerCount } from "./config.ts";
import { markRead, parseNotes } from "./folder/notes.ts";
import { findTask, parseTasks } from "./folder/tasks.ts";
import { writeRunFile } from "./folder/write.ts";
import { HEAVY, type Repo, getRepo } from "./repos.ts";
import { type HaltDeps, haltChat, resumeChat } from "./run/halt.ts";
import { type ChatInfo, BuildLoop, activeTask } from "./run/loop.ts";
import { changedFiles } from "./run/commit.ts";
import { Orchestrator, type CommandBy, type TaskCommand, type TaskCommandResult } from "./run/orchestrator.ts";
import { NoteDelivery } from "./run/notes-loop.ts";
import { Questions } from "./run/park.ts";
import type { AgentEvent, AgentPort, AgentSpec, CheckPort } from "./run/ports.ts";
import { systemClock } from "./run/ports.ts";
import { type CheckResult, type Job, RunQueue, tailLines } from "./run/queue.ts";
import { emptyTaskRun, readRunState, updateRunState } from "./run/state.ts";
import { recoverEngine } from "./restart.ts";
import { type SendFixListDeps, sendFixList, startReview } from "./review/start.ts";
import { Sessions } from "./sessions.ts";
import { hhmm } from "./time.ts";
import type { AgentView, EngineEvent, QueueItem, Role, Stage, Tool, UsageMove } from "./types.ts";
import { UsageSwitch } from "./usage/executor.ts";

/** An operation that the rules refuse. The route answers with this status and `{ error, ...extra }`. */
export class Refused extends Error {
  constructor(
    message: string,
    public status: 400 | 404 | 409 = 409,
    public extra: Record<string, unknown> = {},
  ) {
    super(message);
    this.name = "Refused";
  }
}

export interface EngineOptions {
  publish: (e: EngineEvent) => void;
  /** The argv that starts each tool. Default: `bins` of the config, which is ["claude"] and ["codex"] unless the owner changed it. */
  bins?: { claude: string[]; codex: string[] };
  /** The tmux session name prefix. Default `ss-`. Tests use `sst-` plus a random part. */
  prefix?: string;
  /** Extra environment for every agent session. */
  env?: Record<string, string>;
  pollMs?: number;
  stallMs?: number;
  readyMs?: number;
  /** How long a new Codex agent's role line may take before the next line goes in. Default 30000. The option is for tests. */
  roleTurnMs?: number;
  /** Where Codex keeps its rollout files. Default: the Codex home. Tests point it at a temp folder. */
  codexSessionsDir?: string;
  /** The argv that runs this same program. The hook command and `<home>/bin/starship` use it. */
  self: string[];
}

export interface CheckAnswer {
  outcome: CheckResult["outcome"];
  exit: number | null;
  tail: string;
}

export interface Engine {
  readonly sessions: Sessions;
  /** The sessions, plus the role line that a Codex agent gets first. */
  readonly agents: AgentPort;
  readonly chat: ChatService;
  /** Made when it is first used: it makes the folder of the heavy lock. */
  readonly queue: RunQueue;
  readonly loop: BuildLoop;
  readonly notes: NoteDelivery;
  readonly orchestrator: Orchestrator;
  readonly questions: Questions;
  readonly usage: UsageSwitch;
  /** Starts the sessions, then recovers what the last run left half done. */
  start(): Promise<void>;
  /** Ends the engine's timers and subscriptions. Agents keep running in tmux. */
  stop(): void;
  /** The agents of a chat from the sessions, with the task each one works on. */
  agentViews(chatId: string): AgentView[];
  queueItems(chatId: string): QueueItem[];
  agentRole(chatId: string, agent: string): Role | null;
  halt(chatId: string): Promise<boolean>;
  resume(chatId: string): Promise<boolean>;
  setStage(chatId: string, stage: Stage): Promise<void>;
  pauseAgent(chatId: string, agent: string): Promise<void>;
  resumeAgent(chatId: string, agent: string): Promise<void>;
  restartAgent(chatId: string, agent: string, change?: { tool?: Tool; model?: string }): Promise<{ resumed: boolean }>;
  /** The tmux session name of an agent. */
  tmuxOf(chatId: string, agent: string): string;
  taskCommand(chatId: string, agent: string, c: TaskCommand): TaskCommandResult;
  /** Runs the task's verify command through the run queue. It does not check the task off and is not an attempt. */
  runCheck(chatId: string, taskId: string): Promise<CheckAnswer>;
  sendFixes(chatId: string): { phase: number | null; sent: number };
}

const ROLES: readonly Role[] = ["admin", "orchestrator", "worker", "reviewer", "cardRunner"];
const WORKER_IDS = ["worker-a", "worker-b", "worker-c"];
const ORCHESTRATOR = "orchestrator";
/** A task in one of these states has a worker in a turn, or about to be in one. */
const IN_A_TURN = ["assigned", "working", "failed"];
/** How long `ensure` of a Codex agent waits for the turn of its role line. */
const ROLE_TURN_MS = 30_000;

const key = (chat: string, agent: string) => `${chat}\n${agent}`;
const warn = (what: string, e: unknown) => console.error(`engine: ${what}: ${e instanceof Error ? e.message : String(e)}`);

function writeFile(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

/** What an agent's json file (written by Sessions) says. null when there is no readable file. */
function readAgentFile(chat: string, agent: string): { role: Role; tool: Tool; promptFile: string | null } | null {
  try {
    const f: unknown = JSON.parse(readFileSync(join(paths.chat(chat), "agents", `${agent}.json`), "utf8"));
    if (typeof f !== "object" || f === null) return null;
    const o = f as Record<string, unknown>; // checked just above: an object
    const role = ROLES.find((r) => r === o.role);
    if (!role || (o.tool !== "claude" && o.tool !== "codex")) return null;
    return { role, tool: o.tool, promptFile: typeof o.promptFile === "string" ? o.promptFile : null };
  } catch {
    return null;
  }
}

/** True when the command is heavy by the repo's own rule: a named check says so, or a pattern word is in the command. */
export function isHeavy(repo: Repo | null, cmd: string): boolean {
  const c = cmd.trim();
  if (repo) for (const k of Object.values(repo.checks)) if (k.cmd.trim() === c) return k.heavy;
  const words = repo ? repo.heavyPatterns : HEAVY;
  return words.some((w) => w !== "" && c.toLowerCase().includes(w.toLowerCase()));
}

const settingFor = (cfg: Config, tool: Tool): string => {
  for (const r of [cfg.roles.worker, cfg.roles.reviewer1, cfg.roles.reviewer2]) if (r.tool === tool) return r.model;
  return "";
};

export function createEngine(o: EngineOptions): Engine {
  const clock = systemClock;
  const bin = join(home(), "bin");
  const publish = o.publish;
  const changed = (chatId: string) => publish({ type: "chat", id: chatId });
  const config = loadConfig();
  const bins = o.bins ?? config.bins;

  const sessions = new Sessions({
    bins,
    hookEntry: o.self,
    codexArgs: config.codexArgs,
    claudeArgs: config.claudeArgs,
    env: { ...(o.env ?? {}), PATH: `${bin}:${process.env.PATH ?? ""}` },
    ...(o.prefix !== undefined ? { prefix: o.prefix } : {}),
    ...(o.pollMs !== undefined ? { pollMs: o.pollMs } : {}),
    // The option is for tests. Without it the setting of the config counts.
    stallMs: o.stallMs ?? config.stallMin * 60_000,
    ...(o.readyMs !== undefined ? { readyMs: o.readyMs } : {}),
    ...(o.codexSessionsDir !== undefined ? { codexSessionsDir: o.codexSessionsDir } : {}),
  });

  // ───────────── the first subscription: the Codex role line ─────────────
  // Sessions passes no role prompt to Codex. A new Codex session gets one line that points at its prompt file, before any
  // other line. Codex reports a turn only when it ends, as a turnStart and a turnEnd together: the loop must not take
  // the turn of the role line for the turn of a task, so these two events are marked quiet and the other listeners skip them.
  // The role turn is known by its prompt, which is the role line, and not by a time window: Codex may end it long after the
  // next line went in (on 2026-11-11 that made a task `checking` before its turn).
  const needsRole = new Set<string>();
  const roleTurn = new Map<string, () => void>();
  /** The role line that was sent to each Codex agent. */
  const roleLines = new Map<string, string>();
  /** Agents whose turnStart was the role turn's: the turnEnd that follows is the role turn's too. */
  const roleEnding = new Set<string>();
  const quiet = new WeakSet<AgentEvent>();
  sessions.on((e) => {
    if (e.type === "started") {
      if (!e.resumed) needsRole.add(key(e.chat, e.agent));
      // The start may come after `ensure` returned: the owner answered a trust question in the terminal. Nobody calls `ensure`
      // again for the agent, so its role line and the lines that waited for it go out now. A second caller joins this one.
      settle(e.chat, e.agent).catch((err: unknown) => warn(`the start of ${e.agent}`, err));
    } else if (e.type === "turnStart") {
      const k = key(e.chat, e.agent);
      if (roleTurn.has(k) || (roleLines.has(k) && e.prompt.trim() === roleLines.get(k))) {
        quiet.add(e);
        roleEnding.add(k);
      }
    } else if (e.type === "turnEnd") {
      const k = key(e.chat, e.agent);
      if (roleEnding.delete(k)) {
        quiet.add(e);
        roleTurn.get(k)?.();
      }
    }
  });

  async function greet(chat: string, agent: string): Promise<void> {
    const k = key(chat, agent);
    if (sessions.status(chat, agent) === "halted") return; // a halted agent takes no line: the next ensure, after Resume, sends it
    if (!needsRole.delete(k)) return;
    const f = readAgentFile(chat, agent);
    if (!f || f.tool !== "codex" || !f.promptFile) return;
    const done = new Promise<void>((res) => roleTurn.set(k, res));
    const line = `Read ${f.promptFile} first. It is your role. Then wait for your task.`;
    roleLines.set(k, line);
    try {
      await sessions.send(chat, agent, line);
      await Promise.race([done, Bun.sleep(o.roleTurnMs ?? ROLE_TURN_MS)]);
    } catch (e) {
      warn(`the role line of ${agent} was not sent`, e);
    } finally {
      roleTurn.delete(k);
    }
  }

  // A line for an agent that waits at its trust question. The admin agent and the workers do not use this: the chat service keeps
  // the owner's messages queued, and the loop hands a task out again. The orchestrator, the reviewers and the card runner have no
  // such queue, so the engine holds their line until the owner has answered.
  const waitingLines = new Map<string, string[]>();
  const holdsLines = (role: Role | undefined): boolean => role === "orchestrator" || role === "reviewer" || role === "cardRunner";

  async function flushLines(chat: string, agent: string): Promise<void> {
    const k = key(chat, agent);
    if (sessions.need(chat, agent) !== null) return; // it still waits
    const lines = waitingLines.get(k);
    waitingLines.delete(k);
    for (const line of lines ?? []) {
      try {
        await sessions.send(chat, agent, line);
      } catch (e) {
        warn(`a line for ${agent} that waited for its trust question was not sent`, e);
        return;
      }
    }
  }

  /** After a start: the Codex role line first, then the lines that waited. One run at a time for an agent. */
  const settling = new Map<string, Promise<void>>();
  function settle(chat: string, agent: string): Promise<void> {
    const k = key(chat, agent);
    const running = settling.get(k);
    if (running) return running;
    const p: Promise<void> = (async () => {
      await greet(chat, agent);
      await flushLines(chat, agent);
    })().finally(() => {
      if (settling.get(k) === p) settling.delete(k);
    });
    settling.set(k, p);
    return p;
  }

  const agents: AgentPort = {
    async ensure(chat, spec) {
      await sessions.ensure(chat, spec);
      await settle(chat, spec.id);
    },
    async send(chat, agent, line) {
      if (sessions.need(chat, agent) === "trust" && holdsLines(readAgentFile(chat, agent)?.role)) {
        waitingLines.set(key(chat, agent), [...(waitingLines.get(key(chat, agent)) ?? []), line]);
        return;
      }
      await sessions.send(chat, agent, line);
    },
    interrupt: (chat, agent) => sessions.interrupt(chat, agent),
    async restart(chat, agent, change) {
      waitingLines.delete(key(chat, agent));
      const r = await sessions.restart(chat, agent, change);
      await settle(chat, agent);
      return r;
    },
    async stop(chat, agent) {
      waitingLines.delete(key(chat, agent));
      await sessions.stop(chat, agent);
    },
    status: (chat, agent) => sessions.status(chat, agent),
    mark: (chat, agent, status) => sessions.mark(chat, agent, status),
    agents: (chat) => sessions.agents(chat),
    on(listener) {
      return sessions.on((e) => {
        if (!quiet.has(e)) listener(e);
      });
    },
  };

  // ───────────── the chat, the repo and the agents' specs ─────────────

  const chatInfo = (id: string): ChatInfo => {
    const c = getChat(id);
    if (!c.worktree || !c.featureDir || !c.slug) throw new ChatError(`chat "${id}" has no worktree, so it has no build`, 404);
    const repo = c.repo ? getRepo(c.repo) : null;
    return { worktree: c.worktree, featureDir: c.featureDir, slug: c.slug, halted: c.halted !== null, heavy: (cmd) => isHeavy(repo, cmd), commitPlanFiles: repo ? repo.commitPlanFiles : true };
  };
  const featureOf = (id: string): { featureDir: string; halted: boolean } => {
    const c = getChat(id);
    if (!c.featureDir) throw new ChatError(`chat "${id}" has no feature folder`, 404);
    return { featureDir: c.featureDir, halted: c.halted !== null };
  };

  const hasFolder = (id: string): boolean => {
    try {
      return getChat(id).featureDir !== null;
    } catch {
      return false;
    }
  };

  const specFor = (chatId: string, id: string, role: Role, setting: { tool: Tool; model: string }, cwd: string): AgentSpec => {
    const c = getChat(chatId);
    const promptFile = join(paths.chat(chatId), "agents", `${id}.prompt.md`);
    writeFile(promptFile, `${rolePrompt(role, { chatTitle: c.title, stage: c.stage, worktree: c.worktree, featureFolder: c.featureDir })}\n`);
    return { id, role, tool: setting.tool, model: setting.model, cwd, promptFile };
  };
  const adminSpec = (chatId: string): AgentSpec => specFor(chatId, "admin", "admin", loadConfig().roles.admin, adminCwd(chatId));
  const orchestratorSpec = (chatId: string): AgentSpec => specFor(chatId, ORCHESTRATOR, "orchestrator", loadConfig().roles.orchestrator, adminCwd(chatId));
  const workerSpecs = (chatId: string): AgentSpec[] => {
    const cfg = loadConfig();
    return WORKER_IDS.slice(0, workerCount(cfg)).map((id) => specFor(chatId, id, "worker", cfg.roles.worker, adminCwd(chatId)));
  };

  // ───────────── the parts ─────────────

  // The conflict pairs are the repos' own `conflicts` lists. The queue holds this one array and reads it each time it decides what
  // may start, so each enqueue reads the repo files again: a pair that the owner adds to a repo counts from the next check on.
  const conflicts: [string, string][] = [];
  const readConflicts = (): void => {
    const now: [string, string][] = [];
    let names: string[] = [];
    try {
      names = readdirSync(paths.repos());
    } catch {
      // No repos yet: no conflict pairs.
    }
    for (const name of names) {
      if (!name.endsWith(".json") || name.endsWith(".map.json")) continue;
      try {
        for (const pair of getRepo(name.slice(0, -".json".length)).conflicts) if (pair.length === 2) now.push([pair[0] ?? "", pair[1] ?? ""]);
      } catch {
        // One repo file that cannot be read does not take the pairs of the other repos away.
      }
    }
    conflicts.splice(0, conflicts.length, ...now);
  };
  readConflicts();
  // The queue makes the lock folder. It is made at the first check, so an engine that cannot write its home still starts to report that.
  let madeQueue: RunQueue | undefined;
  const queue = (): RunQueue => (madeQueue ??= new RunQueue({ lockDir: join(home(), "locks"), timeoutMs: config.checkTimeoutMin * 60_000, conflicts }));
  const jobs = new Map<string, Job>();
  const checks: CheckPort = {
    enqueue(job) {
      jobs.set(job.id, job);
      changed(job.chat);
      readConflicts();
      const p = queue().enqueue(job);
      const done = () => {
        jobs.delete(job.id);
        changed(job.chat);
      };
      p.then(done, done);
      return p;
    },
    drop: (chat) => queue().drop(chat),
  };

  // A9: a turn with no reply text shows "Done" and the files that changed in the chat's worktree. A chat with no worktree has none.
  const filesOf = (chatId: string): string[] => {
    const worktree = getChat(chatId).worktree;
    if (!worktree) return [];
    try {
      return changedFiles(worktree);
    } catch (e) {
      warn(`the changed files of ${chatId} were not listed`, e);
      return [];
    }
  };
  const chat = new ChatService({ agents, publish, clock, adminSpec, changedFiles: filesOf });

  // The holders let the loop, the orchestrator and the notes refer to each other.
  const holder: { orchestrator?: Orchestrator; notes?: NoteDelivery; usage?: UsageSwitch } = {};
  const boundary = (chatId: string) => {
    holder.notes?.boundary(chatId).catch((e: unknown) => warn(`notes at a boundary of ${chatId}`, e));
  };

  const loop = new BuildLoop({
    agents,
    checks,
    clock,
    publish: changed,
    chat: chatInfo,
    workers: workerSpecs,
    orchestrator: {
      escalated: (c, t, tail) => holder.orchestrator?.escalated(c, t, tail),
      checkpointFailed: (c, n, tail) => holder.orchestrator?.checkpointFailed(c, n, tail),
      planChanged: (c, files) => holder.orchestrator?.planChanged(c, files),
    },
    onBoundary: boundary,
    onTaskEnded: (c, agent) => {
      holder.usage?.taskEnded(c, agent).catch((e: unknown) => warn(`usage switch after ${agent}`, e));
    },
    maxAttempts: config.checkAttempts,
  });

  const taskState = (chatId: string, taskId: string): string | null => {
    try {
      return readRunState(featureOf(chatId).featureDir).tasks[taskId]?.state ?? null;
    } catch {
      return null;
    }
  };

  const orchestrator = new Orchestrator({ agents, clock, chat: featureOf, spec: orchestratorSpec, loop, taskState, publish: changed });
  holder.orchestrator = orchestrator;

  const notes = new NoteDelivery({
    agents,
    clock,
    chat: featureOf,
    buildStarted: (id) => loop.buildStatus(id).status !== "notStarted",
    taskInTurn: (id) => {
      try {
        return Object.values(readRunState(featureOf(id).featureDir).tasks).some((t) => IN_A_TURN.includes(t.state));
      } catch {
        return false;
      }
    },
    orchestratorSpec,
    publish: changed,
    busy: (id) => orchestrator.busy(id),
  });
  holder.notes = notes;

  const questions = new Questions({
    agents,
    loop,
    chat: (id) => {
      const f = featureOf(id);
      return f;
    },
    tellAdmin: (id, line, text) => chat.tellAdmin(id, line, text),
    taskAgent: (id, taskId) => {
      try {
        return readRunState(featureOf(id).featureDir).tasks[taskId]?.agent ?? null;
      } catch {
        return null;
      }
    },
    publish: changed,
  });

  // ───────────── views ─────────────

  const taskOfAgent = (chatId: string, agent: string): string | null => {
    try {
      const st = readRunState(featureOf(chatId).featureDir);
      return activeTask(st, agent) ?? Object.entries(st.tasks).find(([, t]) => t.agent === agent && t.state === "checking")?.[0] ?? null;
    } catch {
      return null;
    }
  };
  const agentViews = (chatId: string): AgentView[] =>
    sessions.agents(chatId).map((a) => {
      const need = sessions.need(chatId, a.id);
      return { ...a, task: a.role === "worker" ? taskOfAgent(chatId, a.id) : null, contextPct: sessions.contextPct(chatId, a.id), ...(need ? { need } : {}) };
    });

  const queueItems = (chatId: string): QueueItem[] =>
    (madeQueue?.pending() ?? [])
      .filter((p) => p.chat === chatId)
      .map((p) => {
        const job = jobs.get(p.id);
        return { id: p.id, chat: p.chat, task: job?.name ?? "", command: job?.cmd ?? "", state: p.state === "running" ? "running" : "waiting" };
      });

  // ───────────── checks ─────────────

  const runCheck = async (chatId: string, taskId: string): Promise<CheckAnswer> => {
    const info = chatInfo(chatId);
    if (info.halted) throw new Refused("The chat is halted");
    const file = join(info.featureDir, "TASKS.md");
    if (!existsSync(file)) throw new Refused("The chat has no TASKS.md", 404);
    const task = findTask(parseTasks(readFileSync(file, "utf8"), "TASKS.md"), taskId);
    if (!task) throw new Refused(`There is no task ${taskId} in TASKS.md`, 404);
    if (!task.verify) throw new Refused(`Task ${taskId} has no verify command that the engine can run`, 400);
    // The run counter of the task goes up with every run, so the log never overwrites another.
    const box = { run: 0 };
    updateRunState(info.featureDir, (s) => {
      const t = (s.tasks[taskId] ??= emptyTaskRun(task.done ? "verified" : "queued"));
      t.runs += 1;
      box.run = t.runs;
    });
    mkdirSync(join(info.featureDir, "run", "logs"), { recursive: true });
    const logPath = join(info.featureDir, "run", "logs", `${taskId}-${box.run}.log`);
    const result = await checks.enqueue({ id: `${chatId}:${taskId}:${box.run}`, chat: chatId, name: taskId, cmd: task.verify, cwd: info.worktree, heavy: info.heavy(task.verify), logPath });
    return { outcome: result.outcome, exit: result.exit, tail: tailLines(result.logPath, 60) };
  };

  // ───────────── the usage switch ─────────────

  const movesFile = join(home(), "usage-moves.json");
  const usage = new UsageSwitch({
    agents,
    clock,
    config: () => {
      const s = loadConfig();
      return { enabled: s.switch.enabled, thresholdPct: s.switch.at, contextRestartPct: s.contextRestartAt };
    },
    workers: () =>
      listChats().flatMap((c) =>
        sessions
          .agents(c.id)
          .filter((a) => a.role === "worker")
          .map((a) => ({ id: a.id, chat: c.id, tool: a.tool, task: taskOfAgent(c.id, a.id), contextPct: sessions.contextPct(c.id, a.id) })),
      ),
    runCheck: async (chatId, taskId) => {
      try {
        return (await runCheck(chatId, taskId)).outcome === "pass" ? "pass" : "fail";
      } catch {
        return "fail";
      }
    },
    pickup: (chatId, agent, checkResult) => {
      const task = taskOfAgent(chatId, agent);
      const f = readAgentFile(chatId, agent);
      let prompt = "";
      try {
        const dir = join(featureOf(chatId).featureDir, "run", "prompts");
        const mine = readdirSync(dir).filter((n) => task !== null && n.startsWith(`${agent}-${task}-v`)).sort();
        const last = mine[mine.length - 1];
        if (last) prompt = ` Its prompt is ${join(dir, last)}.`;
      } catch {
        // No prompt file: the task line alone has to do.
      }
      const role = f?.promptFile ? ` Read ${f.promptFile} first. It is your role.` : "";
      const result = checkResult === null ? "" : ` The check of ${task ?? "your task"} ${checkResult === "pass" ? "passed" : "failed"}.`;
      return `You are the new ${agent} of chat ${chatId}.${role}${task ? ` Pick up task ${task}.${prompt}` : " You have no task now. Wait for one."}${result}`;
    },
    modelFor: (tool) => settingFor(loadConfig(), tool),
    needsYou: (chatId, agent, text) => {
      try {
        appendMessage(chatId, { id: crypto.randomUUID(), who: "system", at: hhmm(), stage: getChat(chatId).stage, text: agent ? `${agent}: ${text}` : text });
      } catch (e) {
        warn("a usage notice was not written", e);
      }
      changed(chatId);
    },
    saveMoves: (moves) => {
      try {
        writeFile(movesFile, `${JSON.stringify(moves, null, 2)}\n`);
      } catch (e) {
        warn("the moves were not saved", e);
      }
    },
    loadMoves: (): UsageMove[] => {
      try {
        const v: unknown = JSON.parse(readFileSync(movesFile, "utf8"));
        return Array.isArray(v) ? (v as UsageMove[]) : []; // a file this engine wrote
      } catch {
        return [];
      }
    },
    publish: () => publish({ type: "usage" }),
  });
  holder.usage = usage;

  // ───────────── the one fan-out of agent events ─────────────
  // The sessions change an agent's status before the event goes out, so the loop sees the new status.
  // Each step has its own guard: a step that throws must not take the steps after it, or the other listeners' turn, away.
  const safely = (what: string, step: () => void): void => {
    try {
      step();
    } catch (e) {
      warn(`${what} of an agent event`, e);
    }
  };
  const offFan = sessions.on((e) => {
    if (quiet.has(e)) return;
    if (e.type === "usage") {
      safely("the usage switch", () => usage.onEvent(e));
      return;
    }
    // The orchestrator's turn for an ask ended: a note that waited for that turn goes now. A turn that delivered notes does not
    // call this, so an unacked note is not pasted again at once.
    let afterAsk = false;
    safely("the ask check", () => {
      afterAsk = e.type === "turnEnd" && e.agent === ORCHESTRATOR && orchestrator.busy(e.chat);
    });
    safely("the loop", () => loop.handle(e));
    safely("the usage switch", () => usage.onEvent(e));
    safely("the answers", () => {
      if (e.type === "started" && readAgentFile(e.chat, e.agent)?.role === "worker" && hasFolder(e.chat)) {
        questions.agentBack(e.chat).catch((err: unknown) => warn("answers after a start", err));
      }
    });
    if (afterAsk) queueMicrotask(() => !orchestrator.busy(e.chat) && boundary(e.chat));
    safely("the publish", () => changed(e.chat));
  });

  // ───────────── operations ─────────────

  const haltDeps: HaltDeps = {
    agents,
    checks,
    clock,
    chat: (id) => {
      const f = featureOf(id);
      return { worktree: getChat(id).worktree ?? f.featureDir, featureDir: f.featureDir, halted: f.halted };
    },
    setHalted: (id, time) => saveChat({ ...getChat(id), halted: time }),
    loop,
    publish: changed,
  };

  const halt = async (chatId: string): Promise<boolean> => {
    const c = getChat(chatId);
    if (!c.featureDir) throw new Refused(`Chat "${chatId}" has no feature folder, so there is nothing to halt`);
    if (!c.worktree) {
      // A chat on a folder alone has no loop, no checks and no workers: Halt is the flag.
      if (c.halted !== null) return false;
      saveChat({ ...c, halted: hhmm() });
      changed(chatId);
      return true;
    }
    return haltChat(haltDeps, chatId);
  };

  const resume = async (chatId: string): Promise<boolean> => {
    const c = getChat(chatId);
    if (!c.featureDir) throw new Refused(`Chat "${chatId}" has no feature folder, so there is nothing to resume`);
    if (!c.worktree) {
      if (c.halted === null) return false;
      saveChat({ ...c, halted: null });
      chat.pump(chatId).catch((e: unknown) => warn("the chat queue after Resume", e));
      changed(chatId);
      return true;
    }
    const did = await resumeChat(haltDeps, chatId);
    chat.pump(chatId).catch((e: unknown) => warn("the chat queue after Resume", e));
    await questions.resumed(chatId);
    notes.resumed(chatId).catch((e: unknown) => warn("notes after Resume", e));
    orchestrator.resumed(chatId);
    changed(chatId);
    return did;
  };

  const reviewDeps = (chatId: string) => {
    const c = getChat(chatId);
    const repo = c.repo ? getRepo(c.repo) : null;
    if (!c.worktree || !c.featureDir || !c.branch || !repo) throw new Refused(`Chat "${chatId}" has no worktree and repo to review`);
    const cfg = loadConfig();
    const address = repo.review.address ?? repo.review.appAddress ?? repo.review.url ?? null;
    return {
      agents,
      chat: () => ({ title: c.title, worktree: c.worktree ?? "", featureDir: c.featureDir ?? "", baseBranch: repo.baseBranch, branch: c.branch ?? "", appAddress: address }),
      roles: { reviewer1: cfg.roles.reviewer1, reviewer2: cfg.roles.reviewer2, cardRunner: cfg.roles.cardRunner },
      publish: changed,
    };
  };

  const setStage = async (chatId: string, stage: Stage): Promise<void> => {
    const c = getChat(chatId);
    if (c.stage === null) throw new Refused(`Chat "${chatId}" has no stage: it has no repo`);
    if (stage === "build") {
      if (!c.worktree) throw new Refused(`Chat "${chatId}" has no worktree, so it has no build`);
      const r = loop.start(chatId);
      if (!r.ok) throw new Refused("The plan is not valid", 409, { problems: r.problems });
    } else if (stage === "review") {
      if (loop.buildStatus(chatId).status !== "done") throw new Refused("The build is not done");
    }
    const was = c.stage;
    if (was !== stage) {
      saveChat({ ...getChat(chatId), stage });
      chat.tellAdmin(chatId, `stage-${stage}-${Date.now()}`, `The chat is now in the ${stage} stage.`);
    }
    changed(chatId);
    // These start agents, which takes seconds. The route answers now; a failure shows in the chat.
    if (stage === "build") boundary(chatId);
    if (stage === "review") {
      startReview(reviewDeps(chatId), chatId).catch((e: unknown) => {
        warn(`the review of ${chatId} did not start`, e);
        try {
          appendMessage(chatId, { id: crypto.randomUUID(), who: "system", at: hhmm(), stage: "review", text: `The review did not start: ${e instanceof Error ? e.message : String(e)}` });
        } catch {
          // The chat is gone.
        }
        changed(chatId);
      });
    }
  };

  const sendFixes = (chatId: string): { phase: number | null; sent: number } => {
    const c = getChat(chatId);
    if (!c.featureDir) throw new Refused(`Chat "${chatId}" has no feature folder`);
    if (loop.buildStatus(chatId).status !== "done") throw new Refused("The build is not done");
    const dir = c.featureDir;
    const deps: SendFixListDeps = {
      orchestrator,
      chat: () => ({ featureDir: dir }),
      lastSent: () => readRunState(dir).lastFixSent,
      setLastSent: (_id, n) => {
        updateRunState(dir, (s) => {
          s.lastFixSent = n;
        });
      },
      markFixNotesRead: (_id, numbers) => {
        writeRunFile(join(dir, "run", "handoffs.md"), (text) => {
          let cur = text;
          for (const n of numbers) {
            const note = parseNotes(cur).notes.find((x) => x.n === n);
            if (note?.status === "queued") cur = markRead(cur, n, hhmm());
          }
          return cur;
        });
      },
      buildRunning: (id) => loop.taskAdded(id),
      publish: changed,
    };
    const r = sendFixList(deps, chatId);
    if (!r.ok) throw new Refused(r.error);
    if (r.phase !== null && c.stage !== "build") {
      saveChat({ ...getChat(chatId), stage: "build" });
      chat.tellAdmin(chatId, `stage-build-${Date.now()}`, "The chat is now in the build stage.");
    }
    changed(chatId);
    return { phase: r.phase, sent: r.sent };
  };

  const existing = (chatId: string, agent: string): AgentView => {
    const a = sessions.agents(chatId).find((x) => x.id === agent);
    if (!a) throw new Refused(`Chat "${chatId}" has no agent "${agent}"`, 404);
    return a;
  };

  const pauseAgent = async (chatId: string, agent: string): Promise<void> => {
    const a = existing(chatId, agent);
    if (a.role === "worker") {
      await loop.pause(chatId, agent);
    } else {
      // The admin agent, the orchestrator and a reviewer have no task: Escape, and the status says paused.
      if (a.status === "stopped" || a.status === "starting") throw new Refused(`Agent "${agent}" is ${a.status}`);
      await sessions.interrupt(chatId, agent);
      sessions.mark(chatId, agent, "paused");
    }
    changed(chatId);
  };

  const resumeAgent = async (chatId: string, agent: string): Promise<void> => {
    const a = existing(chatId, agent);
    if (a.role === "worker") {
      await loop.resumeAgent(chatId, agent);
      await questions.agentBack(chatId);
    } else {
      if (a.status !== "paused") throw new Refused(`Agent "${agent}" is not paused`);
      sessions.mark(chatId, agent, "idle");
      await sessions.send(chatId, agent, "continue");
      if (a.role === "admin") chat.pump(chatId).catch((e: unknown) => warn("the chat queue after Resume", e));
    }
    changed(chatId);
  };

  const restart = async (chatId: string, agent: string, change?: { tool?: Tool; model?: string }): Promise<{ resumed: boolean }> => {
    existing(chatId, agent);
    const r = await agents.restart(chatId, agent, change);
    changed(chatId);
    if (existing(chatId, agent).role === "worker") await questions.agentBack(chatId);
    return r;
  };

  const taskCommand = (chatId: string, agent: string, c: TaskCommand): TaskCommandResult => {
    const role = readAgentFile(chatId, agent)?.role;
    if (!role) throw new Refused(`Chat "${chatId}" has no agent "${agent}"`, 404);
    // The Orchestrator checks the role at run time and refuses any role but these two with its own words.
    const by: CommandBy = { agent, role: role as CommandBy["role"] };
    const r = orchestrator.taskCommand(chatId, by, c);
    changed(chatId);
    return r;
  };

  // ───────────── start and stop ─────────────

  const start = async (): Promise<void> => {
    mkdirSync(bin, { recursive: true });
    const script = join(bin, "starship");
    writeFileSync(script, `#!/bin/sh\nexec ${o.self.map(shellQuote).join(" ")} "$@"\n`);
    chmodSync(script, 0o755);
    sessions.start();
    // A step of the recovery that fails is reported, and the chats still get their look below: one chat's refusal must not keep
    // the other chats' builds from starting.
    try {
      await recoverEngine({
        chats: () => listChats().map((c) => ({ id: c.id, featureDir: c.worktree ? c.featureDir : null, halted: c.halted !== null })),
        rebuildSessions: async () => {
          sessions.rebuild();
        },
        recoverChat: () => chat.recover(),
        loop,
        resumed: (id) => {
          questions.resumed(id).catch((e: unknown) => warn(`answers of ${id} after the start`, e));
        },
      });
    } catch (e) {
      warn("the recovery at the start", e);
    }
    // A chat whose build is not running still gets one look: a pending commit finishes, a stopped build may run again.
    for (const c of listChats()) {
      if (!c.worktree || !c.featureDir) continue;
      try {
        loop.kick(c.id);
      } catch (e) {
        warn(`chat ${c.id} was not kicked`, e);
      }
    }
  };

  const stop = (): void => {
    offFan();
    sessions.dispose();
    chat.dispose();
    notes.close();
    orchestrator.close();
    // A check that runs when the engine stops would run on with nobody to hear its result, and the next start runs it again (D16):
    // two heavy commands at once. Each check ends as `dropped`, which the loop leaves alone.
    const q = madeQueue;
    if (q) for (const c of new Set(q.pending().map((p) => p.chat))) q.drop(c);
  };

  return {
    sessions,
    agents,
    chat,
    get queue() {
      return queue();
    },
    loop,
    notes,
    orchestrator,
    questions,
    usage,
    start,
    stop,
    agentViews,
    queueItems,
    agentRole: (chatId, agent) => readAgentFile(chatId, agent)?.role ?? null,
    halt,
    resume,
    setStage,
    pauseAgent,
    resumeAgent,
    restartAgent: restart,
    tmuxOf: (chatId, agent) => existing(chatId, agent).tmux,
    taskCommand,
    runCheck,
    sendFixes,
  };
}

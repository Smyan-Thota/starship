/**
 * The chat registry: one folder per chat under ~/.starship/chats/<id>/ with chat.json, messages.jsonl and
 * events.jsonl. `chatState` reads the chat and its feature folder into the one shape the window shows.
 *
 * A chat on a repo gets its own worktree and feature folder (createWorktree). A chat may also adopt a
 * feature folder that already exists on disk, with no repo.
 */
import { appendFileSync, existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, statSync, writeFileSync } from "node:fs";
import { basename, isAbsolute, join, relative, sep } from "node:path";
import { home, paths } from "./config.ts";
import { listFiles } from "./folder/folder.ts";
import { readFindings } from "./folder/findings.ts";
import { parseNotes } from "./folder/notes.ts";
import { validatePlan } from "./folder/plan.ts";
import { parseQuestions } from "./folder/questions.ts";
import { ParseError, allTasks, parseTasks } from "./folder/tasks.ts";
import { readCards } from "./review/cards.ts";
import { readFixes } from "./review/fixes.ts";
import { type RunState, readRunState } from "./run/state.ts";
import { getRepo, mapFile } from "./repos.ts";
import { hhmm } from "./time.ts";
import type {
  AgentStatus,
  AgentView,
  BuildView,
  Chat,
  ChatState,
  ChatSummary,
  MessageView,
  NeedView,
  PlanProblem,
  PlanView,
  PromptVersion,
  QueueItem,
  ReviewView,
  Role,
  Stage,
  TaskState,
  TasksView,
  Tool,
  Wireframe,
} from "./types.ts";
import { WorktreeError, createWorktree } from "./worktree.ts";
import { listWireframes } from "./wireframes.ts";

export interface StoredAgent {
  id: string;
  name: string;
  role: Role;
  tool: Tool;
  model: string;
  tmux: string;
  sessionId?: string;
  status: AgentStatus;
  task: string | null;
  history: { at: string; text: string }[];
}

/** What chat.json holds: the fields of Chat except needsYou, plus the agents. */
export interface StoredChat extends Omit<Chat, "needsYou"> {
  agents: Record<string, StoredAgent>;
}

export class ChatError extends Error {
  constructor(
    message: string,
    /** 404 for an unknown chat, 400 for bad input, 500 for a chat file that cannot be read. */
    public status: 400 | 404 | 500 = 400,
  ) {
    super(message);
    this.name = "ChatError";
  }
}

export const CHAT_ID = /^[a-z0-9][a-z0-9-]*$/;
const STAGES: readonly Stage[] = ["map", "plan", "build", "review"];
const TASK_STATES: readonly TaskState[] = ["queued", "assigned", "working", "checking", "verified", "failed", "escalated", "parked", "blocked", "dropped"];
const MAX_EVENTS = 50;

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

/** "Recipe search!" → "recipe-search". */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[̀-ͯ]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 48)
    .replace(/-+$/g, "");
  return s || "chat";
}

function chatFile(id: string): string {
  return join(paths.chat(id), "chat.json");
}

function checkId(id: string): void {
  if (typeof id !== "string" || !CHAT_ID.test(id)) throw new ChatError(`no chat "${id}"`, 404);
}

function writeJson(file: string, value: unknown): void {
  const tmp = `${file}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`;
  writeFileSync(tmp, JSON.stringify(value, null, 2) + "\n");
  renameSync(tmp, file);
}

export interface NewChat {
  title: string;
  repo?: string;
  /** A feature folder that exists on the repo's base branch. The chat adopts it in a new worktree. Needs `repo`. */
  feature?: string;
  /** Absolute path of a feature folder that exists. The chat uses it where it is, with no worktree. */
  folder?: string;
  stage?: Stage;
}

/** A feature name is one folder name: it never leaves the features folder. */
const FEATURE = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

export function createChat(input: NewChat): StoredChat {
  const title = typeof input.title === "string" ? input.title.replace(/\s+/g, " ").trim() : "";
  if (!title) throw new ChatError("a chat needs a title");
  if (input.stage !== undefined && !STAGES.includes(input.stage)) throw new ChatError(`"${String(input.stage)}" is not a stage`);

  let repo: string | null = null;
  if (input.repo !== undefined) {
    if (typeof input.repo !== "string" || !input.repo) throw new ChatError("the repo must be a name");
    repo = getRepo(input.repo).name;
  }

  if (input.feature !== undefined) {
    if (repo === null) throw new ChatError("a feature needs a repo");
    if (input.folder !== undefined) throw new ChatError("give a folder or a feature, not both");
    if (typeof input.feature !== "string" || !FEATURE.test(input.feature) || input.feature.includes("..")) throw new ChatError(`"${String(input.feature)}" is not a feature name`);
  }

  let featureDir: string | null = null;
  if (input.folder !== undefined) {
    if (typeof input.folder !== "string" || !isAbsolute(input.folder)) throw new ChatError("the folder must be an absolute path");
    if (!existsSync(input.folder) || !statSync(input.folder).isDirectory()) throw new ChatError(`${input.folder} is not a folder`);
    featureDir = realpathSync(input.folder);
  }

  // A chat on a repo gets a worktree. It is made first, so a git failure leaves no chat behind (edge C14).
  let wt: { path: string; branch: string; slug: string } | null = null;
  let stage: Stage | null = featureDir || repo ? (input.stage ?? "plan") : (input.stage ?? null);
  if (repo !== null && featureDir === null) {
    const r = getRepo(repo);
    try {
      const made = createWorktree({
        repoPath: r.path,
        baseBranch: r.baseBranch,
        slug: input.feature ?? slugify(title),
        worktreesDir: join(home(), "worktrees", r.name),
        featureDir: r.featureDir,
        adopt: input.feature !== undefined,
      });
      wt = { path: made.path, branch: made.branch, slug: made.slug };
      featureDir = made.featureFolder;
    } catch (e) {
      if (e instanceof WorktreeError) throw new ChatError(e.message);
      throw e;
    }
    stage = input.stage ?? (input.feature !== undefined || existsSync(mapFile(r.name)) ? "plan" : "map");
  }

  mkdirSync(paths.chats(), { recursive: true });
  const base = slugify(title);
  let id = base;
  for (let n = 2; ; n++) {
    try {
      mkdirSync(paths.chat(id));
      break;
    } catch (e) {
      if ((e as { code?: string }).code !== "EEXIST") throw e;
      id = `${base}-${n}`;
    }
  }

  const chat: StoredChat = {
    id,
    title,
    repo,
    stage,
    halted: null,
    slug: wt ? wt.slug : featureDir ? basename(featureDir) : null,
    worktree: wt ? wt.path : null,
    branch: wt ? wt.branch : null,
    featureDir,
    createdAt: new Date().toISOString(),
    agents: {},
  };
  writeFileSync(join(paths.chat(id), "messages.jsonl"), "");
  writeFileSync(join(paths.chat(id), "events.jsonl"), "");
  writeJson(chatFile(id), chat);
  return chat;
}

function readStored(id: string): StoredChat {
  const file = chatFile(id);
  if (!existsSync(file)) throw new ChatError(`no chat "${id}"`, 404);
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ChatError(`${file}: not valid JSON (${(e as Error).message})`, 500);
  }
  if (!isObject(raw) || raw.id !== id || typeof raw.title !== "string") throw new ChatError(`${file}: needs "id" and "title"`, 500);
  const str = (v: unknown) => (typeof v === "string" ? v : null);
  const stage = STAGES.includes(raw.stage as Stage) ? (raw.stage as Stage) : null;
  const agents: Record<string, StoredAgent> = {};
  if (isObject(raw.agents)) {
    for (const [key, a] of Object.entries(raw.agents)) {
      if (!isObject(a)) continue;
      const agent: StoredAgent = {
        id: typeof a.id === "string" ? a.id : key,
        name: typeof a.name === "string" ? a.name : key,
        role: (a.role as Role) ?? "worker",
        tool: (a.tool as Tool) ?? "claude",
        model: typeof a.model === "string" ? a.model : "",
        tmux: typeof a.tmux === "string" ? a.tmux : "",
        status: (a.status as AgentStatus) ?? "stopped",
        task: str(a.task),
        history: Array.isArray(a.history) ? a.history.filter((h): h is { at: string; text: string } => isObject(h) && typeof h.at === "string" && typeof h.text === "string") : [],
      };
      if (typeof a.sessionId === "string") agent.sessionId = a.sessionId;
      agents[key] = agent;
    }
  }
  return {
    id,
    title: raw.title,
    repo: str(raw.repo),
    stage,
    halted: str(raw.halted),
    slug: str(raw.slug),
    worktree: str(raw.worktree),
    branch: str(raw.branch),
    featureDir: str(raw.featureDir),
    createdAt: str(raw.createdAt) ?? "",
    agents,
  };
}

/** One chat. An unknown or malformed id is a ChatError with status 404. */
export function getChat(id: string): StoredChat {
  checkId(id);
  return readStored(id);
}

export function saveChat(chat: StoredChat): void {
  checkId(chat.id);
  if (!existsSync(paths.chat(chat.id))) throw new ChatError(`no chat "${chat.id}"`, 404);
  writeJson(chatFile(chat.id), chat);
}

/** Every chat that can be read, newest first. A chat whose chat.json cannot be read is left out. */
export function listChats(): StoredChat[] {
  if (!existsSync(paths.chats())) return [];
  const out: StoredChat[] = [];
  for (const name of readdirSync(paths.chats())) {
    if (!CHAT_ID.test(name)) continue;
    try {
      out.push(readStored(name));
    } catch {
      // A broken chat.json must not hide the other chats.
    }
  }
  return out.sort((a, b) => b.createdAt.localeCompare(a.createdAt) || a.id.localeCompare(b.id));
}

export function appendMessage(id: string, message: MessageView): void {
  getChat(id);
  appendFileSync(join(paths.chat(id), "messages.jsonl"), JSON.stringify(message) + "\n");
}

function jsonLines(file: string): unknown[] {
  if (!existsSync(file)) return [];
  const out: unknown[] = [];
  for (const line of readFileSync(file, "utf8").split("\n")) {
    if (!line.trim()) continue;
    try {
      out.push(JSON.parse(line));
    } catch {
      // A line that is not JSON is skipped.
    }
  }
  return out;
}

export function readMessages(id: string): MessageView[] {
  getChat(id);
  return jsonLines(join(paths.chat(id), "messages.jsonl")).filter(
    (m): m is MessageView => isObject(m) && typeof m.id === "string" && typeof m.text === "string" && typeof m.at === "string" && (m.who === "you" || m.who === "admin" || m.who === "system"),
  );
}

function readText(file: string): string | null {
  try {
    return existsSync(file) ? readFileSync(file, "utf8") : null;
  } catch {
    return null;
  }
}

/** run/state.json. A missing or bad file gives nothing; it is never fatal. */
function readRun(dir: string): RunState | null {
  try {
    return readRunState(dir);
  } catch {
    return null;
  }
}

function tasksOf(dir: string, run: RunState | null): { tasks: TasksView | null; tasksError: ChatState["tasksError"] } {
  const text = readText(join(dir, "TASKS.md"));
  if (text === null) return { tasks: null, tasksError: null };
  let doc: ReturnType<typeof parseTasks>;
  try {
    doc = parseTasks(text, "TASKS.md");
  } catch (e) {
    if (e instanceof ParseError) return { tasks: null, tasksError: { file: e.file, line: e.line, reason: e.reason } };
    throw e;
  }
  let verified = 0;
  let total = 0;
  const phases = doc.phases.map((p) => ({
    n: p.n,
    title: p.title,
    checkpoint: p.checkpoint ? { text: p.checkpoint.text, command: p.checkpoint.command } : null,
    tasks: p.tasks.map((t) => {
      const r = run?.tasks[t.id];
      total++;
      if (t.done) verified++;
      // A state name that is not a task state is ignored; the task stays queued.
      const named = r && TASK_STATES.includes(r.state) ? r.state : "queued";
      const state: TaskState = t.done ? "verified" : named;
      return {
        id: t.id,
        phase: t.phase,
        parallel: t.parallel,
        text: t.text,
        files: t.files,
        verify: t.verify,
        verifyNote: t.verifyNote,
        trace: t.trace,
        done: t.done,
        state,
        agent: r?.agent ?? null,
        attempts: r?.attempts ?? 0,
      };
    }),
  }));
  return { tasks: { phases, verified, total }, tasksError: null };
}

function wireframesOf(dir: string): Wireframe[] {
  return listWireframes(dir).map((w) => ({ name: w.name, path: w.file, url: w.link }));
}

/** The text of a prompt file as a version of the prompt page: its lines, and the note each one came from. */
function promptVersion(v: number, file: string, shown: string): PromptVersion {
  const text = readText(file) ?? "";
  const lines = text
    .split("\n")
    .map((l) => l.replace(/\r$/, "").trim())
    .filter(Boolean)
    .map((l) => {
      const n = l.match(/\(note (\d+)\)/);
      return n ? { text: l, note: Number(n[1]) } : { text: l };
    });
  return { v, at: hhmm(statSync(file).mtime), file: shown, text, lines };
}

/**
 * The role prompt that an agent was started with: the file named in its agent record (a reviewer's is in run/prompts/), else
 * `agents/<agent>.prompt.md` of the chat's state folder. It is version 1. A worker has none: its prompts are one per task.
 * `file` is relative to the feature folder when the prompt is inside it, else to the chat's state folder.
 */
function rolePromptOf(chat: string, dir: string | null, agent: string, role: Role): PromptVersion | null {
  if (role === "worker") return null;
  const state = paths.chat(chat);
  let file = join(state, "agents", `${agent}.prompt.md`);
  const rec = readText(join(state, "agents", `${agent}.json`));
  if (rec !== null) {
    try {
      const named: unknown = (JSON.parse(rec) as Record<string, unknown> | null)?.promptFile;
      if (typeof named === "string" && named !== "" && existsSync(named)) file = named;
    } catch {
      // an agent record that is not JSON: the default file counts
    }
  }
  if (!existsSync(file)) return null;
  const inFeature = dir !== null && file.startsWith(`${dir}${sep}`);
  const shown = inFeature ? relative(dir, file).split(sep).join("/") : file.startsWith(`${state}${sep}`) ? relative(state, file).split(sep).join("/") : file;
  return promptVersion(1, file, shown);
}

/** The prompts of one agent: its role prompt first (not for a worker), then the versions in run/prompts/. */
function promptsOf(chat: string, dir: string | null, agent: string, role: Role): PromptVersion[] {
  const out: PromptVersion[] = [];
  const roleVersion = rolePromptOf(chat, dir, agent, role);
  if (roleVersion) out.push(roleVersion);
  const pdir = dir === null ? null : join(dir, "run", "prompts");
  if (pdir === null || !existsSync(pdir)) return out;
  const pattern = /^(?:T\d{3}[A-Za-z]?-)?v(\d+)\.md$/;
  const versions: PromptVersion[] = [];
  for (const f of readdirSync(pdir).sort()) {
    if (!f.startsWith(agent + "-")) continue;
    const m = f.slice(agent.length + 1).match(pattern);
    if (!m) continue;
    versions.push(promptVersion(Number(m[1]), join(pdir, f), `run/prompts/${f}`));
  }
  versions.sort((a, b) => a.v - b.v || a.file.localeCompare(b.file));
  return [...out, ...versions];
}

function eventsOf(id: string): { at: string; text: string }[] {
  const out: { at: string; text: string }[] = [];
  for (const e of jsonLines(join(paths.chat(id), "events.jsonl"))) {
    if (isObject(e) && e.type === "log" && typeof e.at === "string" && typeof e.text === "string") out.push({ at: e.at, text: e.text });
  }
  return out.reverse().slice(0, MAX_EVENTS);
}

export interface StateExtra {
  queue?: QueueItem[];
  handEdits?: string[];
  /** The live agents (status, tool, model, tmux name, task). They replace the agents stored in chat.json. */
  agents?: AgentView[];
  /** Numbers of the notes that the engine stopped delivering (B9, `NoteDelivery.needsYou`). Each shows once, with the notes the rule below finds. */
  stuckNotes?: number[];
}

// ---- The Plan page: the lines of the TL;DR

interface Heading {
  level: number;
  /** As written in the file. */
  text: string;
  /** 0-based index of the line. */
  at: number;
}

/** Every Markdown heading outside a code fence. */
function headingsOf(lines: string[]): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  lines.forEach((raw, at) => {
    const s = raw.replace(/\r$/, "");
    const f = s.match(/^\s*(```+|~~~+)/);
    if (f) {
      const mark = (f[1] ?? "").slice(0, 3);
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      return;
    }
    if (fence !== null) return;
    const h = s.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) out.push({ level: (h[1] ?? "").length, text: (h[2] ?? "").trim(), at });
  });
  return out;
}

/**
 * The lines under the first heading whose lowercase text `start` matches. They end at the next heading of any
 * level, or with `nested` at the next heading of the same or a higher level.
 */
function sectionOf(text: string, start: RegExp, nested: boolean): { heading: string; lines: string[] } | null {
  const lines = text.split("\n");
  const hs = headingsOf(lines);
  const i = hs.findIndex((h) => start.test(h.text.toLowerCase()));
  const first = hs[i];
  if (!first) return null;
  const next = hs.slice(i + 1).find((h) => !nested || h.level <= first.level);
  return { heading: first.text, lines: lines.slice(first.at + 1, next ? next.at : lines.length) };
}

const firstLine = (lines: string[]): string | null => lines.map((l) => l.trim()).find(Boolean) ?? null;

/** Top-level list items: bullets and numbers with no indent, outside a code fence. */
function itemCount(lines: string[]): number {
  let fence = false;
  let n = 0;
  for (const l of lines) {
    if (/^\s*(```|~~~)/.test(l)) fence = !fence;
    else if (!fence && /^(?:[-*+]|\d+[.)])\s+\S/.test(l)) n++;
  }
  return n;
}

/** The ADR folder of a worktree. A chat with no worktree uses the validator's own default. */
export function planProblems(featureDir: string, worktree: string | null): PlanProblem[] {
  return validatePlan(featureDir, worktree ? { adrDir: join(worktree, "docs", "adr") } : {});
}

function planLines(dir: string): PlanView["lines"] {
  const out: PlanView["lines"] = [];
  const spec = readText(join(dir, "SPEC.md"));
  const plan = readText(join(dir, "PLAN.md"));

  const problem = spec === null ? null : sectionOf(spec, /^problem\b/, false);
  const problemText = problem ? firstLine(problem.lines) : null;
  if (problem && problemText) out.push({ label: "Problem", value: problemText, file: "SPEC.md", heading: problem.heading });

  const inScope = plan === null ? null : sectionOf(plan, /^in scope\b/, true);
  const outScope = plan === null ? null : sectionOf(plan, /^out of scope\b/, true);
  if (inScope && outScope) out.push({ label: "Scope", value: `${itemCount(inScope.lines)} in scope, ${itemCount(outScope.lines)} out`, file: "PLAN.md", heading: inScope.heading });

  const tasksText = readText(join(dir, "TASKS.md"));
  if (tasksText !== null) {
    try {
      const doc = parseTasks(tasksText, "TASKS.md");
      out.push({ label: "Tasks", value: `${allTasks(doc).length} in ${doc.phases.length} phases`, file: "TASKS.md", heading: null });
    } catch {
      // A TASKS.md that does not parse has no line; the validator reports it.
    }
  }

  const tests = plan === null ? null : sectionOf(plan, /\btests?\b/, false);
  const testsText = tests ? firstLine(tests.lines) : null;
  if (tests && testsText) out.push({ label: "Tests", value: testsText, file: "PLAN.md", heading: tests.heading });

  const wdir = join(dir, "wireframes");
  if (existsSync(wdir) && statSync(wdir).isDirectory()) out.push({ label: "Wireframes", value: String(listWireframes(dir).length), file: "wireframes", heading: null });
  return out;
}

// ---- The Review page

function reviewOf(dir: string): ReviewView | null {
  let any = false;
  try {
    any = readdirSync(join(dir, "run", "review"), { withFileTypes: true }).some((d) => d.isFile());
  } catch {
    // no run/review/ folder
  }
  if (!any) return null;
  const doc = readFindings(dir);
  return { findings: doc.findings, none: doc.none, cards: readCards(dir).cards, fixes: readFixes(dir).fixes };
}

/** One note that the engine delivered this many times with no ack stays queued, and waits for the owner. */
const DELIVERIES = 3;

/** The whole chat state the window shows. Reading never creates a file or a folder. */
export function chatState(id: string, extra: StateExtra = {}): ChatState {
  const stored = getChat(id);
  const dir = stored.featureDir;
  const folderMissing = dir !== null && (!existsSync(dir) || !statSync(dir).isDirectory());
  const live = dir !== null && !folderMissing;

  const run = live ? readRun(dir) : null;
  const { tasks, tasksError } = live ? tasksOf(dir, run) : { tasks: null, tasksError: null };
  const notesDoc = live ? parseNotes(readText(join(dir, "run", "handoffs.md")) ?? "") : { notes: [], unreadable: [] };
  const questions = live ? parseQuestions(readText(join(dir, "run", "questions.md")) ?? "").questions : [];
  const review = live ? reviewOf(dir) : null;

  const agents: AgentView[] = extra.agents
    ? extra.agents.map((a) => ({ ...a, prompts: promptsOf(id, live ? dir : null, a.id, a.role), history: stored.agents[a.id]?.history ?? a.history }))
    : Object.entries(stored.agents).map(([key, a]) => ({
        id: a.id || key,
        name: a.name,
        role: a.role,
        tool: a.tool,
        model: a.model,
        tmux: a.tmux,
        status: a.status,
        task: a.task,
        prompts: promptsOf(id, live ? dir : null, a.id || key, a.role),
        history: a.history,
      }));

  const build: BuildView =
    stored.repo !== null && run
      ? { status: run.build.status, reason: run.build.reason, outside: run.outside, dropped: run.dropped, lastFixSent: run.lastFixSent }
      : { status: "notStarted", reason: null, outside: [], dropped: [], lastFixSent: 0 };

  const needs: NeedView[] = [];
  for (const q of questions) {
    if (q.status === "open") needs.push({ kind: "question", text: q.question, agent: q.agent, task: q.task === "-" ? null : q.task });
  }
  for (const a of agents) {
    if (a.status === "needsYou") {
      // The engine knows why the agent waits. A start question is not a permission.
      if (a.need === "trust") needs.push({ kind: "trust", text: `${a.name}: trust question`, agent: a.id, task: a.task });
      else if (a.need === "other") needs.push({ kind: "permission", text: `${a.name}: a dialog waits`, agent: a.id, task: a.task });
      else needs.push({ kind: "permission", text: `${a.name} needs a permission`, agent: a.id, task: a.task });
    }
    else if (a.status === "stalled") needs.push({ kind: "stalled", text: `${a.name} stalled`, agent: a.id, task: a.task });
    else if (a.status === "stopped") needs.push({ kind: "stopped", text: `${a.name} stopped`, agent: a.id, task: a.task });
  }
  for (const t of tasks ? tasks.phases.flatMap((p) => p.tasks) : []) {
    if (t.state === "blocked") needs.push({ kind: "blocked", text: `${t.id} is blocked: ${t.text}`, agent: t.agent, task: t.id });
  }
  if (build.status === "stopped") needs.push({ kind: "build", text: build.reason?.text || "The build stopped", agent: null, task: null });
  for (const c of run?.foreignCommits ?? []) {
    needs.push({ kind: "build", text: `A commit the engine did not make: ${c.sha.slice(0, 7)} ${c.subject}`, agent: null, task: null });
  }
  for (const f of review?.findings ?? []) {
    if (f.status === "disputed") needs.push({ kind: "finding", text: `F${f.n} is disputed: ${f.text} (${f.where})`, agent: f.dispute?.reviewer ?? null, task: null });
  }
  // One pass over the notes, so a note that both the engine's list and this rule name is listed once.
  const stuck = new Set(extra.stuckNotes ?? []);
  for (const n of notesDoc.notes) {
    if (n.status === "queued" && ((run?.notes[String(n.n)]?.deliveries ?? 0) >= DELIVERIES || stuck.has(n.n))) needs.push({ kind: "note", text: `Note ${n.n} was never confirmed: ${n.note}`, agent: null, task: null });
  }

  const { agents: _agents, ...rest } = stored;
  return {
    chat: { ...rest, needsYou: needs.length },
    build,
    needs,
    plan: live && stored.repo !== null ? { problems: planProblems(dir, stored.worktree), lines: planLines(dir) } : null,
    review,
    folderMissing,
    tasks,
    tasksError,
    notes: notesDoc.notes,
    unreadableNotes: notesDoc.unreadable,
    questions,
    files: live ? listFiles(dir) : [],
    wireframes: live ? wireframesOf(dir) : [],
    messages: readMessages(id),
    agents,
    queue: extra.queue ?? [],
    events: eventsOf(id),
    handEdits: extra.handEdits ?? [],
  };
}

export function chatSummary(id: string, extra: StateExtra = {}): ChatSummary {
  const { chat } = chatState(id, extra);
  return { id: chat.id, title: chat.title, repo: chat.repo, stage: chat.stage, halted: chat.halted, needsYou: chat.needsYou };
}

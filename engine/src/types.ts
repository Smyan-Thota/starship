/**
 * The shapes the engine sends to the window. The window imports this file and nothing else from the engine.
 */
import type { FileInfo } from "./folder/folder.ts";
import type { Note, NoteStatus, NoteTarget, Stage, Unreadable } from "./folder/notes.ts";
import type { Question } from "./folder/questions.ts";

import type { Finding, FindingStatus } from "./folder/findings.ts";
import type { PlanProblem } from "./folder/plan.ts";
import type { MapFile, MapBox, MapPipe, MapFlow, MapPath, MapStep } from "./map/schema.ts";
import type { Card } from "./review/cards.ts";
import type { Fix } from "./review/fixes.ts";

export type { FileInfo, Note, NoteStatus, NoteTarget, Question, Stage, Unreadable };
export type { Card, Finding, FindingStatus, Fix, MapBox, MapFile, MapFlow, MapPath, MapPipe, MapStep, PlanProblem };

export type Tool = "claude" | "codex";
export type Role = "admin" | "orchestrator" | "worker" | "reviewer" | "cardRunner";
export type AgentStatus = "starting" | "working" | "idle" | "needsYou" | "stalled" | "stopped" | "halted" | "paused";
export type TaskState = "queued" | "assigned" | "working" | "checking" | "verified" | "failed" | "escalated" | "parked" | "blocked" | "dropped";
export type MessageState = "queued" | "sent" | "answered" | "notSent" | "interrupted";

export interface ChatSummary {
  id: string;
  title: string;
  repo: string | null;
  /** null for a chat with no repo. */
  stage: Stage | null;
  /** HH:MM when the chat is halted. */
  halted: string | null;
  /** How many things wait for the owner: open questions, permissions, stalled agents. */
  needsYou: number;
}

export interface Chat extends ChatSummary {
  slug: string | null;
  worktree: string | null;
  branch: string | null;
  /** Absolute path of docs/features/<slug>/ in the worktree. */
  featureDir: string | null;
  createdAt: string;
}

export interface PromptLine {
  text: string;
  /** The note this line came from. */
  note?: number;
}

export interface PromptVersion {
  v: number;
  /** HH:MM */
  at: string;
  /** Path inside the feature folder. */
  file: string;
  /** The exact text the agent got. */
  text: string;
  lines: PromptLine[];
}

export interface AgentView {
  /** "admin", "orchestrator", "worker-a", "reviewer-1", "card-runner". */
  id: string;
  name: string;
  role: Role;
  tool: Tool;
  model: string;
  tmux: string;
  status: AgentStatus;
  task: string | null;
  /** How full the agent's conversation is, in percent. null when not known. Not set when the engine does not run. */
  contextPct?: number | null;
  /** Why the agent is `needsYou`: a trust question, a permission prompt, or something else. Not set for an agent that is not waiting, or when the engine does not run. */
  need?: "trust" | "permission" | "other";
  prompts: PromptVersion[];
  history: { at: string; text: string }[];
}

export interface TaskView {
  id: string;
  phase: number;
  parallel: boolean;
  text: string;
  files: string[];
  verify: string | null;
  verifyNote: string;
  trace: string;
  done: boolean;
  state: TaskState;
  agent: string | null;
  attempts: number;
}

export interface PhaseView {
  n: number;
  title: string;
  tasks: TaskView[];
  checkpoint: { text: string; command: string | null } | null;
}

export interface TasksView {
  phases: PhaseView[];
  verified: number;
  total: number;
}

export interface MessageView {
  id: string;
  who: "you" | "admin" | "system";
  /** HH:MM */
  at: string;
  stage: Stage | null;
  text: string;
  state?: MessageState;
  /** The note the admin agent wrote in this turn. */
  note?: number;
  fromTerminal?: boolean;
  /** Files that changed in a turn with no reply text. */
  files?: string[];
}

export interface Wireframe {
  name: string;
  /** Path inside the feature folder. */
  path: string;
  /** An artifact address, when the agent reported one. */
  url: string | null;
}

export interface QueueItem {
  id: string;
  chat: string;
  task: string;
  command: string;
  state: "running" | "waiting";
}

export type BuildStatus = "notStarted" | "running" | "stopped" | "done";

/** The build of one chat, from run/state.json. */
export interface BuildView {
  status: BuildStatus;
  /** Why the build is stopped. Only a stop on a checkpoint is ended by Resume. */
  reason: { kind: "tasks" | "folder" | "checkpoint"; text: string } | null;
  /** Changed files that no task lists. */
  outside: string[];
  dropped: { task: string; text: string; reason: string }[];
  /** The number of the last fix that was sent to Build. */
  lastFixSent: number;
}

/** One thing that waits for the owner. `ChatSummary.needsYou` is the length of this list. */
export interface NeedView {
  kind: "question" | "permission" | "trust" | "stalled" | "stopped" | "blocked" | "build" | "finding" | "note";
  text: string;
  agent: string | null;
  task: string | null;
}

/** The Plan page: the validator's result and the short lines of the TL;DR. */
export interface PlanView {
  /** Empty when the plan is valid. "Start build" is refused while it is not empty. */
  problems: PlanProblem[];
  lines: { label: string; value: string; file: string; heading: string | null }[];
}

/** The Review page, from run/review/. */
export interface ReviewView {
  findings: Finding[];
  /** Reviewers that found nothing. */
  none: string[];
  cards: Card[];
  fixes: Fix[];
}

export interface ChatState {
  chat: Chat;
  build: BuildView;
  needs: NeedView[];
  /** null for a chat with no repo. */
  plan: PlanView | null;
  /** null until the chat has review files. */
  review: ReviewView | null;
  folderMissing: boolean;
  tasks: TasksView | null;
  /** Set when TASKS.md has a line the parser cannot read. */
  tasksError: { file: string; line: number; reason: string } | null;
  notes: Note[];
  unreadableNotes: Unreadable[];
  questions: Question[];
  files: FileInfo[];
  wireframes: Wireframe[];
  messages: MessageView[];
  agents: AgentView[];
  queue: QueueItem[];
  /** Newest first. */
  events: { at: string; text: string }[];
  /** Plan files that changed by hand since the engine last wrote or read them. */
  handEdits: string[];
}

export interface FileBody {
  info: FileInfo;
  /** null for a binary file, a file over 1 MB, and every .html file. */
  text: string | null;
  /** True for an .html file: the window opens it in the browser. */
  open: boolean;
}

export interface UsageWindow {
  window: string;
  usedPct: number;
  /** ISO time. */
  resetsAt: string | null;
  expired: boolean;
}

export interface Usage {
  tool: Tool;
  windows: UsageWindow[];
  updatedAt: string | null;
  stale: boolean;
}

export interface RepoInfo {
  name: string;
  path: string;
  baseBranch: string;
  hasMap: boolean;
}

/** Pushed over the WebSocket. The window reads the named thing again. */
export type EngineEvent = { type: "chats" } | { type: "chat"; id: string } | { type: "usage" } | { type: "repos" } | { type: "config" };

/** One move of a worker from one tool to the other. */
export interface UsageMove {
  /** HH:MM */
  at: string;
  chat: string;
  agent: string;
  from: Tool;
  to: Tool;
}

/** GET /api/usage */
export interface UsageState {
  tools: Usage[];
  moves: UsageMove[];
  switchOn: boolean;
  thresholdPct: number;
}

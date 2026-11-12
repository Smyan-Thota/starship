/**
 * The seams between the task loop and the rest of the engine.
 *
 * The loop (engine/src/run/) talks to agents, checks and the clock only through these interfaces.
 * `sessions.ts` implements AgentPort on real tmux sessions. `RunQueue` implements CheckPort.
 * Loop tests use small in-memory fakes of both, so they need no tmux and no real time.
 */
import type { AgentStatus, AgentView, Role, Tool } from "../types.ts";
import type { ToolUsage } from "../usage/read.ts";
import type { CheckResult, Job } from "./queue.ts";

/** What the engine needs to start one agent. */
export interface AgentSpec {
  /** "admin", "orchestrator", "worker-a", "reviewer-1", "card-runner". Unique in its chat. */
  id: string;
  role: Role;
  tool: Tool;
  model: string;
  /** The folder the agent runs in: the chat's worktree, or the chat's own folder for a chat with no repo. */
  cwd: string;
  /** The file with the role prompt. Its content is appended to the tool's own system prompt. */
  promptFile: string | null;
}

/** Everything an agent can tell the engine. One listener gets the events of every agent of every chat. */
export type AgentEvent =
  | { type: "started"; chat: string; agent: string; resumed: boolean }
  /** A turn began. `fromTerminal` is true when the engine did not paste the text: the owner typed it. */
  | { type: "turnStart"; chat: string; agent: string; prompt: string; fromTerminal: boolean }
  /** A turn ended by itself. An interrupted turn (Escape) gives no turnEnd. */
  | { type: "turnEnd"; chat: string; agent: string; reply: string; fromTerminal: boolean }
  /** The tool waits for the owner: a permission, or a start screen that the engine must not answer. */
  | { type: "needsYou"; chat: string; agent: string; reason: "permission" | "trust" | "other"; message: string }
  /** No signal and no screen change for the stall limit, or the tool reported its usage limit. */
  | { type: "stalled"; chat: string; agent: string; reason: "quiet" | "limit" }
  /** A stalled agent gave a signal again. */
  | { type: "signal"; chat: string; agent: string }
  /** The agent's process ended. */
  | { type: "ended"; chat: string; agent: string }
  /** A new usage reading for a tool. */
  | { type: "usage"; tool: Tool; usage: ToolUsage };

export class SendError extends Error {}

export interface AgentPort {
  /** Starts the agent's session if it is not running. Resolves when the tool is ready for text. */
  ensure(chat: string, spec: AgentSpec): Promise<void>;
  /**
   * Pastes one line and presses Enter. A text with more than one line never comes here:
   * the caller writes it to a file and sends one line that points at the file.
   * Throws SendError when tmux refuses.
   */
  send(chat: string, agent: string, line: string): Promise<void>;
  /** Escape: stops the agent's turn. */
  interrupt(chat: string, agent: string): Promise<void>;
  /** Ends the session if it runs, then starts it again: the tool's own resume when the session id is known, else a new session. */
  restart(chat: string, agent: string, change?: { tool?: Tool; model?: string }): Promise<{ resumed: boolean }>;
  /** Ends the session. */
  stop(chat: string, agent: string): Promise<void>;
  status(chat: string, agent: string): AgentStatus | null;
  /** Records a status the loop decides: paused, halted, idle after Resume. */
  mark(chat: string, agent: string, status: AgentStatus): void;
  agents(chat: string): AgentView[];
  /** Subscribes to agent events. Returns the function that ends the subscription. */
  on(listener: (e: AgentEvent) => void): () => void;
}

/** `RunQueue` has exactly these two methods. */
export interface CheckPort {
  enqueue(job: Job): Promise<CheckResult>;
  drop(chat: string): number;
}

export interface Clock {
  /** Epoch milliseconds. */
  now(): number;
}

export const systemClock: Clock = { now: () => Date.now() };

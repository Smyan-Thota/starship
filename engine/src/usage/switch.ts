/**
 * T081, the switch rule (G1, G2, G4, G5, G6, D12). A pure function: the caller reads the usage,
 * passes `now` (epoch seconds), and carries out the actions it gets back.
 */
import { overThreshold } from "./read.ts";
import type { ToolUsage } from "./read.ts";

type Tool = "claude" | "codex";

export interface SwitchWorker {
  id: string;
  chat: string;
  tool: Tool;
  /** True at the moment the worker's own task has just ended (its check gave a result that counts). */
  taskEnded: boolean;
  /** Null when unknown. */
  contextPct: number | null;
  /** D12: the tool reported a usage limit and the agent is stalled. */
  stalledOnLimit: boolean;
  /** The task in flight, or null. */
  task: string | null;
}

export type SwitchAction =
  | { kind: "move"; agent: string; chat: string; to: Tool; checkFirst: boolean }
  | { kind: "restart"; agent: string; chat: string }
  | { kind: "needsYou"; chat: string; agent: string | null; text: string };

export interface SwitchInput {
  enabled: boolean;
  thresholdPct: number;
  contextRestartPct: number;
  now: number;
  usage: { claude: ToolUsage | null; codex: ToolUsage | null };
  workers: SwitchWorker[];
}

type Level = "over" | "under" | "unknown";

const other = (t: Tool): Tool => (t === "claude" ? "codex" : "claude");

/**
 * Each worker gets at most one action, in the order of `workers`; a chat gets at most one `needsYou`.
 * Order of rules per worker: D12 (stalled), then G1 (task ended), then G6 (restart).
 * A `needsYou` takes the worker's place, so that worker does not also restart.
 */
export function decideSwitch(i: SwitchInput): SwitchAction[] {
  const level = (t: Tool): Level => {
    const u = i.usage[t];
    return u === null ? "unknown" : overThreshold(u, i.thresholdPct, i.now);
  };
  const actions: SwitchAction[] = [];
  const askedChats = new Set<string>();

  const needsYou = (w: SwitchWorker, text: string): void => {
    if (askedChats.has(w.chat)) return;
    askedChats.add(w.chat);
    actions.push({ kind: "needsYou", chat: w.chat, agent: w.id, text });
  };

  for (const w of i.workers) {
    const to = other(w.tool);
    const target = level(to);

    // D12: a stalled worker moves at once and never waits for taskEnded.
    if (w.stalledOnLimit) {
      if (target === "under") {
        actions.push({ kind: "move", agent: w.id, chat: w.chat, to, checkFirst: true });
        continue;
      }
      if (target === "over") {
        needsYou(w, `${w.tool} hit its usage limit and ${to} is over the ${i.thresholdPct}% threshold too.`);
        continue;
      }
      // Target unknown (G5): no move. A restart may still apply below.
    }

    // G1: the tool is at the threshold, the worker's task ended, the switch is on.
    if (i.enabled && w.taskEnded && level(w.tool) === "over") {
      if (target === "under") {
        // G2: with a task in flight, the engine runs its check before any new work.
        actions.push({ kind: "move", agent: w.id, chat: w.chat, to, checkFirst: w.task !== null });
        continue;
      }
      if (target === "over") {
        // G4
        needsYou(w, `Both tools are over the ${i.thresholdPct}% threshold.`);
        continue;
      }
      // Target unknown (G5): no move.
    }

    // G6: a full context restarts the worker, only when its task ended. An unknown context causes nothing.
    if (w.taskEnded && w.contextPct !== null && w.contextPct >= i.contextRestartPct) {
      actions.push({ kind: "restart", agent: w.id, chat: w.chat });
    }
  }
  return actions;
}

/**
 * Small label helpers shared by the components and pages.
 */
import type { AgentStatus, AgentView, ChatSummary, FileInfo, Note, Stage, TaskState } from "../../engine/src/types.ts";

type NoteTargetLabel = Note["to"];

export const STAGES: { id: Stage; label: string }[] = [
  { id: "map", label: "Map" },
  { id: "plan", label: "Plan" },
  { id: "build", label: "Build" },
  { id: "review", label: "Review" },
];

export function stageLabel(stage: Stage | null): string {
  return STAGES.find((s) => s.id === stage)?.label ?? "";
}

/** The CSS class of a status dot. */
export function agentDot(status: AgentStatus): string {
  switch (status) {
    case "starting":
    case "working":
      return "run";
    case "needsYou":
    case "stalled":
      return "wait";
    case "paused":
      return "pause";
    case "halted":
      return "halt";
    case "idle":
    case "stopped":
      return "";
  }
}

export function chatDot(c: ChatSummary): string {
  if (c.halted) return "halt";
  if (c.needsYou > 0) return "wait";
  if (c.stage === "build" || c.stage === "review") return "run";
  return "";
}

export const AGENT_STATUS: Record<AgentStatus, string> = {
  starting: "starting",
  working: "working",
  idle: "idle",
  needsYou: "needs you",
  stalled: "stalled",
  stopped: "stopped",
  halted: "halted",
  paused: "paused",
};

export const TASK_STATE: Record<TaskState, string> = {
  queued: "queued",
  assigned: "assigned",
  working: "working",
  checking: "checking",
  verified: "verified",
  failed: "failed",
  escalated: "escalated",
  parked: "parked",
  blocked: "needs you",
  dropped: "dropped",
};

export const NOTE_TARGET: Record<NoteTargetLabel, string> = {
  orchestrator: "Orchestrator",
  plan: "Plan",
  fixes: "Fixes",
  repo: "Repo notes",
};

export function agentName(agents: AgentView[], id: string | null): string {
  if (!id) return "";
  return agents.find((a) => a.id === id)?.name ?? id;
}

export function size(bytes: number): string {
  if (bytes < 1024) return `${bytes} B`;
  if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
  return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Kind words for a file: plan or run, then binary or over 1 MB. */
export function fileKind(info: FileInfo): string {
  const parts: string[] = [info.kind];
  if (info.html) parts.push("HTML");
  if (info.binary) parts.push("binary");
  if (info.tooLarge) parts.push("over 1 MB");
  return parts.join(" · ");
}

export function isMarkdown(path: string): boolean {
  return /\.(md|markdown)$/i.test(path);
}

export function isHtml(path: string): boolean {
  return /\.html?$/i.test(path);
}

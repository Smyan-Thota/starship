/**
 * Pure maps from the engine's shapes (engine/src/types.ts) to the props of the pages.
 * No React, so a test can call them.
 */
import type { AgentView, ChatState, TaskState, TaskView, UsageState } from "../../engine/src/types.ts";
import type { NeedItem } from "./components/NeedEntry.tsx";
import type { PromptVersionView } from "./pages/Agent.tsx";
import type { BuildAgent, BuildPageProps } from "./pages/Build.tsx";
import type { PlanPageProps } from "./pages/Plan.tsx";
import type { ReviewAgent, ReviewPageProps } from "./pages/Review.tsx";
import type { UsageBarsProps, UsageTool } from "./Usage.tsx";

/** A task is "now" while someone works on it, or while it waits on a decision. */
const NOW: TaskState[] = ["assigned", "working", "checking", "failed", "parked", "escalated"];

function allTasks(state: ChatState): TaskView[] {
  return state.tasks?.phases.flatMap((p) => p.tasks) ?? [];
}

function latestPrompt(a: AgentView): number {
  return a.prompts.reduce((n, p) => Math.max(n, p.v), 0);
}

function needsYou(state: ChatState): NeedItem[] {
  return state.needs.map((n) => ({ kind: n.kind, text: n.text, agent: n.agent, task: n.task }));
}

export type BuildData = Omit<BuildPageProps, "onHalt" | "onResume" | "onAgent" | "onTerminal" | "onOpenTasks">;

export function buildData(state: ChatState): BuildData {
  const agents: BuildAgent[] = state.agents
    .filter((a) => a.role !== "admin")
    .map((a) => ({ id: a.id, role: a.name, tool: a.tool, model: a.model, status: a.status, task: a.task, promptVersion: latestPrompt(a) }));
  return {
    status: state.build.status,
    reason: state.build.reason,
    halted: state.chat.halted,
    phases: (state.tasks?.phases ?? []).map((p) => ({ n: p.n, title: p.title, verified: p.tasks.filter((t) => t.state === "verified").length, total: p.tasks.length })),
    now: allTasks(state)
      .filter((t) => NOW.includes(t.state))
      .map((t) => ({ task: t.id, text: t.text, agent: t.agent, state: t.state })),
    outside: state.build.outside,
    dropped: state.build.dropped,
    needsYou: needsYou(state),
    agents,
  };
}

export type PlanData = Omit<PlanPageProps, "onOpenFile" | "onOpenWireframe" | "onStartBuild">;

export function planData(state: ChatState): PlanData {
  return {
    title: state.chat.title,
    lines: state.plan?.lines ?? [],
    problems: state.plan?.problems ?? [],
    wireframes: state.wireframes.map((w) => ({ name: w.name, link: w.url })),
    // The plan files are Markdown. A wireframe is an .html file and opens from its own list; wireframes/links.json is data.
    files: state.files.filter((f) => f.kind === "plan" && !f.html && !f.binary && /\.md$/i.test(f.path)).map((f) => f.path),
  };
}

export type ReviewData = Omit<ReviewPageProps, "onTerminal" | "onAgent" | "onOpenFile" | "onSendFixes">;

export function reviewData(state: ChatState): ReviewData {
  const r = state.review;
  const agents: ReviewAgent[] = state.agents
    .filter((a) => a.role === "reviewer" || a.role === "cardRunner")
    .map((a) => ({ id: a.id, role: a.name, tool: a.tool, model: a.model, status: a.status }));
  return {
    findings: r?.findings ?? [],
    none: r?.none ?? [],
    cards: r?.cards ?? [],
    fixes: r?.fixes ?? [],
    needsYou: needsYou(state),
    agents,
  };
}

/** The prompt versions of an agent. A line that names a note carries the owner's words from that note. */
export function promptVersions(agent: AgentView, state: ChatState): PromptVersionView[] {
  return agent.prompts.map((p) => ({
    version: p.v,
    file: p.file,
    at: p.at,
    text: p.text,
    lines: p.lines.map((l) => ({ text: l.text, said: l.note === undefined ? null : (state.notes.find((n) => n.n === l.note)?.said ?? null) })),
  }));
}

export type UsageData = Omit<UsageBarsProps, "onSwitch" | "onThreshold">;

/** The engine names a window as the tool does: five_hour, seven_day. The bar shows "5 hour", "7 day". */
const WINDOW_NAME: Record<string, string> = { five_hour: "5 hour", seven_day: "7 day" };
const windowName = (w: string): string => WINDOW_NAME[w] ?? w.replace(/_/g, " ");

export function usageData(u: UsageState, now: number): UsageData {
  const tools: UsageTool[] = u.tools.map((t) => ({
    tool: t.tool,
    windows: t.windows.map((w) => {
      const at = w.resetsAt === null ? Number.NaN : Date.parse(w.resetsAt);
      // A window that has reset holds no use.
      return { name: windowName(w.window), usedPct: w.expired ? 0 : w.usedPct, resetsAt: Number.isNaN(at) ? null : at };
    }),
    // The engine reports context per agent, not per tool.
    contextPct: null,
  }));
  return { tools, threshold: u.thresholdPct, switchOn: u.switchOn, now, moves: u.moves.map((m) => ({ at: m.at, agent: m.agent, from: m.from, to: m.to })) };
}

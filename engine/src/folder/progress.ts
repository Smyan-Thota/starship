/**
 * progress.md is derived. The engine writes it from the task file and its own state.
 * A hand edit to it is overwritten, so nothing reads it back.
 */
import type { PhaseCount } from "./tasks.ts";

export interface ProgressInput {
  title: string;
  phases: PhaseCount[];
  /** One line for each running, waiting or parked task: "T022 Worker A: working". */
  now: string[];
  /** Changed files that no task lists. */
  outside: string[];
  /** Tasks someone typed into from a terminal: "T022 Worker A, 15:20". */
  fromTerminal: string[];
  /** Manual checks that were done: "M1 2026-11-12 pass". */
  manual: string[];
  /** HH:MM when the chat is halted. */
  halted?: string;
}

function cell(s: string): string {
  return s.replaceAll("|", "\\|").replace(/\r?\n/g, " ");
}

function list(title: string, items: string[]): string[] {
  if (!items.length) return [];
  return ["", `## ${title}`, "", ...items.map((x) => `- ${x.replace(/\r?\n/g, " ")}`)];
}

export function renderProgress(p: ProgressInput): string {
  const verified = p.phases.reduce((a, x) => a + x.verified, 0);
  const total = p.phases.reduce((a, x) => a + x.total, 0);
  const out = [
    `# Progress — ${p.title.replace(/\r?\n/g, " ")}`,
    "",
    "| Phase | Verified | Total |",
    "| --- | --- | --- |",
    ...p.phases.map((x) => `| ${x.n} · ${cell(x.title)} | ${x.verified} | ${x.total} |`),
    "",
    `**${verified} / ${total}**`,
  ];
  if (p.halted) out.push("", `Halted ${p.halted}`);
  out.push(...list("Now", p.now));
  out.push(...list("Outside the task", p.outside));
  out.push(...list("From terminal", p.fromTerminal));
  out.push(...list("Manual checks", p.manual));
  return out.join("\n") + "\n";
}

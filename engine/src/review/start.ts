/**
 * T060 (roles part) and T062 (send): the start of the Review stage and the fix list that goes back to Build.
 *
 * `startReview` makes the story cards, then starts two reviewers and the card runner. An agent gets a role prompt
 * file and a brief file in run/inbox/, and ONE pasted line that points at the brief (a long text never goes in a paste).
 * `sendFixList` sends the fix list to Build as one new phase, once (edge H3).
 */
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readFindings } from "../folder/findings.ts";
import { parseNotes } from "../folder/notes.ts";
import { planFiles } from "../folder/plan.ts";
import { rolePrompt } from "../agents/roles.ts";
import type { AgentPort, AgentSpec } from "../run/ports.ts";
import type { Role, Tool } from "../types.ts";
import { cardsFromAcceptance, cardsPath, markEnvironmentDown, readCards, writeCards } from "./cards.ts";
import { FixesError, fixList, readFixes, sendFixes, writeFixes } from "./fixes.ts";

interface RoleSetting {
  tool: Tool;
  model: string;
}

export interface StartReviewDeps {
  agents: AgentPort;
  chat: (chatId: string) => { title: string; worktree: string; featureDir: string; baseBranch: string; branch: string; appAddress: string | null };
  roles: { reviewer1: RoleSetting; reviewer2: RoleSetting; cardRunner: RoleSetting };
  publish: (chatId: string) => void;
}

/** H2: the reason on every card when no address is set. */
export const NO_APP_ADDRESS = "No app address is set for this repo";

const read = (file: string): string => (existsSync(file) ? readFileSync(file, "utf8") : "");

function write(file: string, text: string): void {
  mkdirSync(join(file, ".."), { recursive: true });
  writeFileSync(file, text);
}

function reviewerBrief(c: ReturnType<StartReviewDeps["chat"]>, agent: string): string {
  const files = planFiles(c.featureDir).map((f) => `- ${join(c.featureDir, f)}`);
  return [
    `# Review brief for ${agent}`,
    "",
    `Chat: ${c.title}`,
    `Base branch: ${c.baseBranch}`,
    `Branch: ${c.branch}`,
    "",
    "Read the change with this command, run in the worktree:",
    "",
    `    git diff ${c.baseBranch}...${c.branch}`,
    "",
    "Plan files to read:",
    ...(files.length ? files : ["- (none found)"]),
    "",
    "How to report:",
    '- A problem: `starship finding add --sev <high|medium|low> --where <file:line> "<text>"`.',
    '- A finding of the other reviewer that you disagree with: `starship finding dispute <n> "<why>"`.',
    "- No problem: `starship finding none`.",
    "Write nothing else. Do not edit a file.",
    "",
  ].join("\n");
}

function runnerBrief(c: ReturnType<StartReviewDeps["chat"]>, address: string): string {
  return [
    "# Card runner brief",
    "",
    `Chat: ${c.title}`,
    `The app's address: ${address}`,
    `The story cards: ${cardsPath(c.featureDir)}`,
    "",
    "Act out each card in the app with your own browser tool. Do each step, then check each criterion on the screen.",
    'Record each result with `starship card result <card> pass|fail|unclear "<note>"`.',
    "Use `fail` only when you saw the app do the wrong thing. Use `unclear` when you could not tell.",
    "Write nothing else. Do not edit a file.",
    "",
  ].join("\n");
}

/** Starts the review. Calling it twice starts nothing twice. Resolves with the agents that run for this review and the card count. */
export async function startReview(deps: StartReviewDeps, chatId: string): Promise<{ agents: string[]; cards: number }> {
  const c = deps.chat(chatId);
  const dir = c.featureDir;

  // 1. The story cards. A cards file that already has results stays: a second start must not wipe them.
  const existing = readCards(dir).cards;
  if (!existing.some((x) => x.result !== null)) {
    writeCards(dir, cardsFromAcceptance(read(join(dir, "ACCEPTANCE.md"))));
  }

  const plan: { id: string; role: Role; setting: RoleSetting; brief: string }[] = [
    { id: "reviewer-1", role: "reviewer", setting: deps.roles.reviewer1, brief: reviewerBrief(c, "reviewer-1") },
    { id: "reviewer-2", role: "reviewer", setting: deps.roles.reviewer2, brief: reviewerBrief(c, "reviewer-2") },
  ];
  if (c.appAddress !== null) {
    plan.push({ id: "card-runner", role: "cardRunner", setting: deps.roles.cardRunner, brief: runnerBrief(c, c.appAddress) });
  } else {
    // H2: no app to act in, so every card is unclear, with the reason. None is fail.
    markEnvironmentDown(dir, NO_APP_ADDRESS);
  }

  const agents: string[] = [];
  for (const a of plan) {
    agents.push(a.id);
    const status = deps.agents.status(chatId, a.id);
    // An agent that already runs got its brief. Do not send it again.
    if (status !== null && status !== "stopped") continue;

    const promptFile = join(dir, "run", "prompts", `${a.id}-review-v1.md`);
    write(promptFile, rolePrompt(a.role, { chatTitle: c.title, stage: "review", worktree: c.worktree, featureFolder: dir }) + "\n");
    const briefFile = join(dir, "run", "inbox", `${a.id}-review.md`);
    write(briefFile, a.brief);

    const spec: AgentSpec = { id: a.id, role: a.role, tool: a.setting.tool, model: a.setting.model, cwd: c.worktree, promptFile };
    await deps.agents.ensure(chatId, spec);
    await deps.agents.send(chatId, a.id, `Your review brief is in ${briefFile}. Read it, then do what it says.`);
  }
  deps.publish(chatId);
  return { agents, cards: readCards(dir).cards.length };
}

export interface SendFixListDeps {
  orchestrator: { fixList(chatId: string, phase: number, fixes: { n: number; text: string; from: string }[]): void };
  chat: (chatId: string) => { featureDir: string };
  lastSent: (chatId: string) => number;
  setLastSent: (chatId: string, n: number) => void;
  markFixNotesRead: (chatId: string, noteNumbers: number[]) => void;
  buildRunning: (chatId: string) => void;
  publish: (chatId: string) => void;
}

/** Sends the fix list to Build as one new phase. A second call sends nothing and gives `phase: null` (H3). */
export function sendFixList(deps: SendFixListDeps, chatId: string): { ok: true; phase: number | null; sent: number } | { ok: false; error: string } {
  const dir = deps.chat(chatId).featureDir;
  const findings = readFindings(dir).findings;
  if (findings.some((f) => f.status === "disputed")) return { ok: false, error: "A finding is disputed" };

  const notes = parseNotes(read(join(dir, "run", "handoffs.md"))).notes;
  const fixes = fixList(findings, notes, readFixes(dir).fixes);
  let result: ReturnType<typeof sendFixes>;
  try {
    writeFixes(dir, fixes);
    result = sendFixes({ dir, findings, fixes, lastSent: deps.lastSent(chatId) });
  } catch (e) {
    if (e instanceof FixesError) return { ok: false, error: e.message };
    throw e;
  }
  if (result.phase === null) return { ok: true, phase: null, sent: 0 };

  deps.setLastSent(chatId, result.lastSent);
  const noteNumbers = result.sent.flatMap((f) => {
    const m = f.from.match(/^Note (\d+)$/);
    return m ? [Number(m[1])] : [];
  });
  if (noteNumbers.length) deps.markFixNotesRead(chatId, noteNumbers);
  deps.buildRunning(chatId);
  deps.orchestrator.fixList(chatId, result.phase, result.sent);
  deps.publish(chatId);
  return { ok: true, phase: result.phase, sent: result.sent.length };
}

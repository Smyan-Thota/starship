/**
 * Halt and Resume for one chat. (PLAN.md, "Chats, repos and stages", and the edge rows of table E)
 *
 * Halt stops every agent of the chat except the admin agent. It changes no task state. Other chats run on.
 * Resume undoes it. Both are no-ops when there is nothing to undo or to do (E5).
 */
import { existsSync } from "node:fs";
import { join } from "node:path";
import { hold, parseNotes, release } from "../folder/notes.ts";
import { writeRunFile } from "../folder/write.ts";
import type { AgentView } from "../types.ts";
import type { AgentPort, CheckPort, Clock } from "./ports.ts";
import { readRunState, updateRunState } from "./state.ts";
import { isInvalid, nextAgent, nextNote } from "./states.ts";
import { type HaltLoop, activeTask } from "./loop.ts";

export interface HaltDeps {
  agents: AgentPort;
  checks: CheckPort;
  clock: Clock;
  chat: (chatId: string) => { worktree: string; featureDir: string; halted: boolean };
  /** Sets or clears the chat's halted flag: "HH:MM" or null. */
  setHalted: (chatId: string, time: string | null) => void;
  /** The loop. `BuildLoop` implements it. */
  loop: HaltLoop;
  publish?: (chatId: string) => void;
}

/** An agent is in a turn when it works, waits for a permission, or has stalled in the middle of its work. */
const IN_A_TURN = ["working", "needsYou", "stalled"];

function hhmm(ms: number): string {
  const d = new Date(ms);
  return `${String(d.getHours()).padStart(2, "0")}:${String(d.getMinutes()).padStart(2, "0")}`;
}

const notAdmin = (a: AgentView) => a.role !== "admin";

/**
 * Halts one chat. Returns false when the chat is halted already (E5).
 * A commit that is pending finishes first (E3).
 */
export async function haltChat(deps: HaltDeps, chatId: string): Promise<boolean> {
  const info = deps.chat(chatId);
  if (info.halted) return false;

  deps.loop.finishPending(chatId);

  const time = hhmm(deps.clock.now());
  const agents = deps.agents.agents(chatId).filter(notAdmin);
  if (existsSync(info.featureDir)) {
    const inTurn = agents.filter((a) => IN_A_TURN.includes(a.status)).map((a) => a.id);
    updateRunState(info.featureDir, (s) => {
      s.halt = { inTurn };
    });
  }
  deps.setHalted(chatId, time);

  for (const a of agents) {
    const r = nextAgent(a.status, "halted");
    if (isInvalid(r)) continue;
    if (r.effects.includes("sendEscape")) await deps.agents.interrupt(chatId, a.id);
    if (r.state !== a.status) deps.agents.mark(chatId, a.id, r.state);
  }

  deps.checks.drop(chatId);
  // The dropped checks end in the next tick. The loop must see them end before Resume.
  await Promise.resolve();

  holdNotes(deps, chatId);
  deps.loop.writeProgress(chatId, time);
  deps.publish?.(chatId);
  return true;
}

/** B3: a note to the orchestrator that is `queued` becomes `held`. A note that is being read waits for its turn to end. */
function holdNotes(deps: HaltDeps, chatId: string): void {
  const dir = deps.chat(chatId).featureDir;
  const file = join(dir, "run", "handoffs.md");
  if (!existsSync(file)) return;
  const st = readRunState(dir);
  writeRunFile(file, (text) => {
    let cur = text;
    for (const n of parseNotes(text).notes) {
      if (n.to !== "orchestrator" || n.status !== "queued") continue;
      const run = st.notes[String(n.n)];
      const r = nextNote("orchestrator", "queued", "chatHalted", { deliveries: run?.deliveries ?? 0, beingRead: run?.reading ?? false, halted: true });
      if (!isInvalid(r) && r.status === "held") cur = hold(cur, n.n);
    }
    return cur;
  });
}

/** E4: a held note becomes `queued` again. */
function releaseNotes(deps: HaltDeps, chatId: string): void {
  const file = join(deps.chat(chatId).featureDir, "run", "handoffs.md");
  if (!existsSync(file)) return;
  writeRunFile(file, (text) => {
    let cur = text;
    for (const n of parseNotes(text).notes) {
      if (n.to !== "orchestrator" || n.status !== "held") continue;
      const r = nextNote("orchestrator", "held", "chatResumed");
      if (!isInvalid(r) && r.status === "queued") cur = release(cur, n.n);
    }
    return cur;
  });
}

/**
 * Resumes one chat. Returns false when there was nothing to undo: the chat is not halted and its build is
 * not stopped on its checkpoint (E5). One Resume clears the halt and the checkpoint stop together.
 */
export async function resumeChat(deps: HaltDeps, chatId: string): Promise<boolean> {
  const info = deps.chat(chatId);
  const build = deps.loop.buildStatus(chatId);
  const onCheckpoint = build.status === "stopped" && build.reasons.includes("checkpoint");
  if (!info.halted && !onCheckpoint) return false;

  if (info.halted) {
    const st = readRunState(info.featureDir);
    const inTurn = new Set(st.halt?.inTurn ?? []);
    deps.setHalted(chatId, null);

    for (const a of deps.agents.agents(chatId).filter(notAdmin)) {
      const r = nextAgent(a.status, "chatResumed", { inTurn: inTurn.has(a.id) });
      if (isInvalid(r)) continue;
      if (r.state !== a.status) deps.agents.mark(chatId, a.id, r.state);
      if (r.effects.includes("sendContinue")) {
        const task = activeTask(st, a.id);
        await deps.agents.send(chatId, a.id, task ? `continue ${task}` : "continue");
      }
    }

    if (existsSync(info.featureDir)) {
      updateRunState(info.featureDir, (s) => {
        delete s.halt;
      });
    }
    releaseNotes(deps, chatId);
    // E2: a check that Halt killed goes into the queue again.
    for (const [id, t] of Object.entries(st.tasks)) {
      if (t.state === "checking") deps.loop.recheck(chatId, id);
    }
  }

  if (onCheckpoint) deps.loop.resumeBuild(chatId);
  deps.loop.writeProgress(chatId);
  deps.loop.kick(chatId);
  deps.publish?.(chatId);
  return true;
}

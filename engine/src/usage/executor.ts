/**
 * T081, the executor: carries out what `decideSwitch` (switch.ts) decides.
 *
 * It keeps the newest usage reading of each tool, the workers that stalled on a limit (D12), and the moves.
 * It evaluates when a reading changes, when a worker stalls on its limit, and when a worker's own task ends.
 * A move runs the in-flight task's check first (G2), then restarts the worker on the other tool and sends ONE pickup line.
 */
import type { AgentEvent, AgentPort, Clock } from "../run/ports.ts";
import { hhmm } from "../time.ts";
import type { Usage, UsageMove, UsageState } from "../types.ts";
import { effectivePct, mergeUsage, overThreshold } from "./read.ts";
import type { ToolUsage } from "./read.ts";
import { decideSwitch } from "./switch.ts";
import type { SwitchAction, SwitchWorker } from "./switch.ts";

type Tool = "claude" | "codex";

export interface UsageSwitchDeps {
  agents: AgentPort;
  clock: Clock;
  config: () => { enabled: boolean; thresholdPct: number; contextRestartPct: number };
  workers: () => { id: string; chat: string; tool: Tool; task: string | null; contextPct: number | null }[];
  runCheck: (chatId: string, taskId: string) => Promise<"pass" | "fail">;
  pickup: (chatId: string, agent: string, checkResult: "pass" | "fail" | null) => string;
  modelFor: (tool: Tool) => string;
  needsYou: (chatId: string, agent: string | null, text: string) => void;
  saveMoves: (moves: UsageMove[]) => void;
  loadMoves: () => UsageMove[];
  publish: () => void;
}

/** A reading older than this is stale, in seconds. */
const STALE_AFTER = 10 * 60;
const MAX_MOVES = 50;

const toSeconds = (t: number): number => (t > 1e11 ? t / 1000 : t);
const keyOf = (chat: string, agent: string): string => `${chat}\u0000${agent}`;
/** An agent gets only one-line pastes. */
const oneLine = (s: string): string => s.replace(/\s*\r?\n\s*/g, " ").trim();

export class UsageSwitch {
  private usage: { claude: ToolUsage | null; codex: ToolUsage | null } = { claude: null, codex: null };
  /** Workers whose tool reported its usage limit (D12), until they move or give a signal. */
  private stalled = new Set<string>();
  /** A worker with a move or a restart in progress. It is never moved twice at the same time. */
  private busy = new Set<string>();
  /** The needs-you text asked for each chat, so one situation asks once. */
  private asked = new Map<string, string>();
  private levels = "";
  private moves: UsageMove[];
  private running = new Set<Promise<void>>();

  constructor(private deps: UsageSwitchDeps) {
    this.moves = deps.loadMoves().slice(0, MAX_MOVES);
  }

  onEvent(e: AgentEvent): void {
    if (e.type === "usage") {
      this.usage[e.tool] = mergeUsage(this.usage[e.tool], e.usage);
      this.deps.publish();
      this.start(null);
    } else if (e.type === "stalled" && e.reason === "limit") {
      this.stalled.add(keyOf(e.chat, e.agent));
      this.start(null);
    } else if (e.type === "signal" || e.type === "ended") {
      this.stalled.delete(keyOf(e.chat, e.agent));
    }
  }

  /** That worker's own task just ended (G1, G6). Resolves when the actions that follow are done. */
  async taskEnded(chatId: string, agent: string): Promise<void> {
    await this.start({ chat: chatId, agent });
  }

  /** Resolves when every move in progress is done. For tests and for a clean stop. */
  async idle(): Promise<void> {
    while (this.running.size) await Promise.all([...this.running]);
  }

  state(): UsageState {
    const nowSec = toSeconds(this.deps.clock.now());
    const tools: Usage[] = (["claude", "codex"] as const).map((tool) => {
      const u = this.usage[tool];
      if (!u) return { tool, windows: [], updatedAt: null, stale: true };
      const windows: Usage["windows"] = [];
      for (const w of u.windows) {
        if (w.usedPct === null) continue;
        const resets = w.resetsAt === null ? null : toSeconds(w.resetsAt);
        windows.push({
          window: w.name,
          // G3: a window whose reset time has passed counts as 0.
          usedPct: effectivePct(w, nowSec) ?? 0,
          resetsAt: resets === null ? null : new Date(resets * 1000).toISOString(),
          expired: resets !== null && resets <= nowSec,
        });
      }
      const at = toSeconds(u.at);
      return { tool, windows, updatedAt: new Date(at * 1000).toISOString(), stale: nowSec - at > STALE_AFTER };
    });
    const cfg = this.deps.config();
    return { tools, moves: this.moves.slice(0, MAX_MOVES), switchOn: cfg.enabled, thresholdPct: cfg.thresholdPct };
  }

  // ---- evaluation

  private start(ended: { chat: string; agent: string } | null): Promise<void> {
    const p = this.evaluate(ended);
    this.running.add(p);
    const done = () => this.running.delete(p);
    p.then(done, done);
    return p;
  }

  private async evaluate(ended: { chat: string; agent: string } | null): Promise<void> {
    const cfg = this.deps.config();
    const nowSec = toSeconds(this.deps.clock.now());

    // A change in which tool is over the threshold is a new situation: it may ask the owner again.
    const level = (t: Tool) => {
      const u = this.usage[t];
      return u === null ? "unknown" : overThreshold(u, cfg.thresholdPct, nowSec);
    };
    const levels = `${level("claude")}/${level("codex")}`;
    if (levels !== this.levels) {
      this.levels = levels;
      this.asked.clear();
    }

    const workers: SwitchWorker[] = this.deps.workers().map((w) => ({
      id: w.id,
      chat: w.chat,
      tool: w.tool,
      task: w.task,
      contextPct: w.contextPct,
      taskEnded: ended !== null && ended.chat === w.chat && ended.agent === w.id,
      stalledOnLimit: this.stalled.has(keyOf(w.chat, w.id)),
    }));
    const actions = decideSwitch({ enabled: cfg.enabled, thresholdPct: cfg.thresholdPct, contextRestartPct: cfg.contextRestartPct, now: nowSec, usage: this.usage, workers });

    const jobs: Promise<void>[] = [];
    for (const a of actions) {
      if (a.kind === "needsYou") {
        if (this.asked.get(a.chat) === a.text) continue;
        this.asked.set(a.chat, a.text);
        this.deps.needsYou(a.chat, a.agent, a.text);
        this.deps.publish();
        continue;
      }
      const key = keyOf(a.chat, a.agent);
      if (this.busy.has(key)) continue; // a move or restart of this worker is already running
      this.busy.add(key);
      const w = workers.find((x) => x.chat === a.chat && x.id === a.agent);
      jobs.push(this.carryOut(a, w?.task ?? null, w?.tool ?? null).finally(() => this.busy.delete(key)));
    }
    await Promise.all(jobs);
  }

  private async carryOut(a: Exclude<SwitchAction, { kind: "needsYou" }>, task: string | null, from: Tool | null): Promise<void> {
    const d = this.deps;
    try {
      if (a.kind === "restart") {
        // G6: same tool, new session, a pickup line.
        await d.agents.restart(a.chat, a.agent);
        await d.agents.send(a.chat, a.agent, oneLine(d.pickup(a.chat, a.agent, null)));
        return;
      }
      // G2: the in-flight task's check runs before any new work.
      let result: "pass" | "fail" | null = null;
      if (a.checkFirst && task !== null) result = await d.runCheck(a.chat, task);
      await d.agents.restart(a.chat, a.agent, { tool: a.to, model: d.modelFor(a.to) });
      this.stalled.delete(keyOf(a.chat, a.agent));
      this.moves = [{ at: hhmm(new Date(d.clock.now())), chat: a.chat, agent: a.agent, from: from ?? (a.to === "claude" ? "codex" : "claude"), to: a.to }, ...this.moves].slice(0, MAX_MOVES);
      d.saveMoves(this.moves);
      d.publish();
      await d.agents.send(a.chat, a.agent, oneLine(d.pickup(a.chat, a.agent, result)));
    } catch (e) {
      // The worker did not move or did not get its line. Tell the owner once, and leave the stall flag so the next change tries again.
      const text = `Could not ${a.kind === "move" ? `move ${a.agent} to ${a.to}` : `restart ${a.agent}`}: ${e instanceof Error ? e.message : String(e)}`;
      if (this.asked.get(a.chat) !== text) {
        this.asked.set(a.chat, text);
        d.needsYou(a.chat, a.agent, text);
        d.publish();
      }
    }
  }
}

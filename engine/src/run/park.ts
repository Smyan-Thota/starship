/**
 * Questions from workers. (PLAN.md, "Task loop": `working` ─starship ask─▶ `parked` ─the answer─▶ `working`)
 *
 * The HTTP route writes the question to run/questions.md first, then calls `asked`. The question is on disk
 * before anyone is told, so it does not matter whether the admin agent is in a turn, is gone, or the chat is
 * halted: `tellAdmin` queues the line and the admin agent reads the file when it is idle (A15).
 *
 * An answer is written to a file in run/inbox/ and the worker gets one line that points at it. When the worker
 * is gone, paused or halted, the file waits. `run/state.json` lists the answers that were sent, so an answer
 * goes out once, and the files that are not on that list are the answers still waiting.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeRunFile } from "../folder/write.ts";
import type { AgentPort } from "./ports.ts";
import { readRunState, updateRunState } from "./state.ts";

export interface QuestionsDeps {
  agents: AgentPort;
  loop: { asked(chat: string, task: string): void; answered(chat: string, task: string): void };
  chat: (chatId: string) => { featureDir: string; halted: boolean };
  /** Queues one line for the admin agent. A line with the same id is queued once. */
  tellAdmin: (chatId: string, id: string, line: string) => void;
  /** The worker that has the task, or null. */
  taskAgent: (chatId: string, taskId: string) => string | null;
  publish: (chatId: string) => void;
}

const HEADER = /^# Answer to Q(\d+) about (\S+)$/;
const FILE = /^answer-q(\d+)\.md$/;
/** An agent in one of these states cannot take a paste now. */
const NOT_NOW = new Set(["stopped", "halted", "paused", "starting"]);

interface Waiting {
  n: number;
  task: string;
  file: string;
  id: string;
}

export class Questions {
  constructor(private readonly deps: QuestionsDeps) {}

  /** The question is already in run/questions.md. Park its task and tell the admin agent. */
  asked(chatId: string, q: { n: number; task: string; agent: string; text: string }): void {
    const file = join(this.deps.chat(chatId).featureDir, "run", "questions.md");
    // A question with no task ("-") parks nothing.
    if (q.task !== "-") this.deps.loop.asked(chatId, q.task);
    this.deps.tellAdmin(chatId, `q${q.n}`, `${q.agent} asks Q${q.n} about ${q.task}. Read ${file} and ask the owner.`);
    this.deps.publish(chatId);
  }

  /** The owner answered. Write the answer file, unpark the task, and send the worker one line when it can take it. */
  async answered(chatId: string, q: { n: number; task: string; text: string }): Promise<void> {
    const dir = this.inbox(chatId);
    mkdirSync(dir, { recursive: true });
    const file = join(dir, `answer-q${q.n}.md`);
    // The file is written once: a second call for the same question never overwrites an answer that went out.
    if (!existsSync(file)) writeRunFile(file, () => `# Answer to Q${q.n} about ${q.task}\n\n${q.text.trim()}\n`);
    if (q.task !== "-") this.deps.loop.answered(chatId, q.task);
    this.deps.publish(chatId);
    await this.flush(chatId);
  }

  /** Resume ended: every answer that waits goes out now. */
  async resumed(chatId: string): Promise<void> {
    await this.flush(chatId);
  }

  /** An agent is back (started again, or no longer paused): the answers that wait for it go out. */
  async agentBack(chatId: string): Promise<void> {
    await this.flush(chatId);
  }

  // ───────────────────────────── sending ─────────────────────────────

  private inbox(chatId: string): string {
    return join(this.deps.chat(chatId).featureDir, "run", "inbox");
  }

  /** The answer files that are not on the `sent` list, oldest question first. */
  private waiting(chatId: string): Waiting[] {
    const dir = this.inbox(chatId);
    if (!existsSync(dir)) return [];
    const sent = new Set(readRunState(this.deps.chat(chatId).featureDir).sent);
    const out: Waiting[] = [];
    for (const name of readdirSync(dir)) {
      const m = name.match(FILE);
      if (!m) continue;
      const id = `answer-q${m[1]}`;
      if (sent.has(id)) continue;
      const file = join(dir, name);
      const head = readFileSync(file, "utf8").split("\n", 1)[0]?.match(HEADER);
      if (!head) continue;
      out.push({ n: Number(head[1]), task: head[2] ?? "", file, id });
    }
    return out.sort((a, b) => a.n - b.n);
  }

  /** Never throws: an answer that cannot go out now waits for the next look. */
  private async flush(chatId: string): Promise<void> {
    try {
      for (const w of this.waiting(chatId)) await this.send(chatId, w);
    } catch (e) {
      console.error(`chat ${chatId}: answers were not sent: ${(e as Error).message}`);
    }
  }

  /** Records the id first, then sends. A failed send takes the id back, so the answer waits. */
  private async send(chatId: string, w: Waiting): Promise<void> {
    const info = this.deps.chat(chatId);
    if (info.halted) return;
    const agent = this.deps.taskAgent(chatId, w.task);
    if (!agent) return;
    const status = this.deps.agents.status(chatId, agent);
    if (status === null || NOT_NOW.has(status)) return;
    const box = { fresh: false };
    updateRunState(info.featureDir, (s) => {
      if (s.sent.includes(w.id)) return;
      s.sent = [...s.sent, w.id];
      box.fresh = true;
    });
    if (!box.fresh) return;
    try {
      await this.deps.agents.send(chatId, agent, `Answer to Q${w.n} about ${w.task}: read ${w.file} and go on.`);
    } catch {
      updateRunState(info.featureDir, (s) => {
        s.sent = s.sent.filter((x) => x !== w.id);
      });
    }
  }
}

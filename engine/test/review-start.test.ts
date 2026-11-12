import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { readCards, recordCardResult } from "../src/review/cards.ts";
import { sendFixList, startReview } from "../src/review/start.ts";
import type { SendFixListDeps, StartReviewDeps } from "../src/review/start.ts";
import { parseTasks } from "../src/folder/tasks.ts";
import type { AgentPort, AgentSpec } from "../src/run/ports.ts";
import type { AgentStatus, AgentView } from "../src/types.ts";
import { drop, tempDir } from "./helpers.ts";

const CHAT = "chat-1";

class FakeAgents implements AgentPort {
  statuses = new Map<string, AgentStatus>();
  specs: AgentSpec[] = [];
  sent: { agent: string; line: string }[] = [];
  async ensure(_chat: string, spec: AgentSpec): Promise<void> {
    this.specs.push(spec);
    this.statuses.set(spec.id, "idle");
  }
  async send(_chat: string, agent: string, line: string): Promise<void> {
    this.sent.push({ agent, line });
  }
  async interrupt(): Promise<void> {}
  async restart(): Promise<{ resumed: boolean }> {
    return { resumed: true };
  }
  async stop(): Promise<void> {}
  status(_chat: string, agent: string): AgentStatus | null {
    return this.statuses.get(agent) ?? null;
  }
  mark(): void {}
  agents(): AgentView[] {
    return [];
  }
  on(): () => void {
    return () => {};
  }
}

const ACCEPTANCE = ["# Acceptance", "", "## Behavior", "", "- [ ] The list shows each repo. It is sorted by name.", "- [ ] A new repo can be added.", ""].join("\n");

let dir = "";
let agents: FakeAgents;
let published: string[];
let chatInfo: { title: string; worktree: string; featureDir: string; baseBranch: string; branch: string; appAddress: string | null };

function deps(): StartReviewDeps {
  return {
    agents,
    chat: () => chatInfo,
    roles: { reviewer1: { tool: "codex", model: "" }, reviewer2: { tool: "claude", model: "sonnet" }, cardRunner: { tool: "codex", model: "luna" } },
    publish: (id) => published.push(id),
  };
}

beforeEach(() => {
  dir = tempDir("starship-review-start-");
  agents = new FakeAgents();
  published = [];
  writeFileSync(join(dir, "ACCEPTANCE.md"), ACCEPTANCE);
  writeFileSync(join(dir, "SPEC.md"), "# Spec\n");
  writeFileSync(join(dir, "PLAN.md"), "# Plan\n");
  chatInfo = { title: "Repos command", worktree: join(dir, "wt"), featureDir: dir, baseBranch: "main", branch: "starship/repos", appAddress: "http://localhost:3000" };
});
afterEach(() => drop(dir));

describe("startReview", () => {
  test("step 1: it builds the story cards from ACCEPTANCE.md and keeps results on a second start", async () => {
    const r = await startReview(deps(), CHAT);
    expect(r.cards).toBe(2);
    const cards = readCards(dir).cards;
    expect(cards.map((c) => c.id)).toEqual(["C1", "C2"]);
    expect(cards.every((c) => c.result === null)).toBe(true);

    recordCardResult(dir, "C1", "pass", "ok");
    writeFileSync(join(dir, "ACCEPTANCE.md"), ACCEPTANCE + "- [ ] A third thing.\n");
    const again = await startReview(deps(), CHAT);
    expect(again.cards).toBe(2); // the file had results, so it was not written again
    expect(readCards(dir).cards.find((c) => c.id === "C1")?.result).toBe("pass");
  });

  test("step 2: it writes a role prompt file and a brief file for each agent", async () => {
    await startReview(deps(), CHAT);
    for (const id of ["reviewer-1", "reviewer-2", "card-runner"]) {
      expect(existsSync(join(dir, "run", "prompts", `${id}-review-v1.md`))).toBe(true);
      expect(existsSync(join(dir, "run", "inbox", `${id}-review.md`))).toBe(true);
    }
    expect(readFileSync(join(dir, "run", "prompts", "reviewer-1-review-v1.md"), "utf8")).toContain("Try to break the change");
    expect(readFileSync(join(dir, "run", "prompts", "card-runner-review-v1.md"), "utf8")).toContain("story card");
    const brief = readFileSync(join(dir, "run", "inbox", "reviewer-1-review.md"), "utf8");
    expect(brief).toContain("git diff main...starship/repos");
    expect(brief).toContain(join(dir, "SPEC.md"));
    expect(brief).toContain(join(dir, "PLAN.md"));
    expect(brief).toContain("starship finding add");
    const runner = readFileSync(join(dir, "run", "inbox", "card-runner-review.md"), "utf8");
    expect(runner).toContain("http://localhost:3000");
    expect(runner).toContain(join(dir, "run", "review", "story-cards.md"));
  });

  test("step 3: it ensures three agents in the worktree and sends each one line that points at its brief", async () => {
    const r = await startReview(deps(), CHAT);
    expect(r.agents).toEqual(["reviewer-1", "reviewer-2", "card-runner"]);
    expect(agents.specs.map((s) => [s.id, s.role, s.tool, s.model, s.cwd])).toEqual([
      ["reviewer-1", "reviewer", "codex", "", chatInfo.worktree],
      ["reviewer-2", "reviewer", "claude", "sonnet", chatInfo.worktree],
      ["card-runner", "cardRunner", "codex", "luna", chatInfo.worktree],
    ]);
    expect(agents.specs[0]?.promptFile).toBe(join(dir, "run", "prompts", "reviewer-1-review-v1.md"));
    expect(agents.sent).toHaveLength(3);
    for (const s of agents.sent) {
      expect(s.line).not.toContain("\n");
      expect(s.line).toContain(join(dir, "run", "inbox", `${s.agent}-review.md`));
    }
    expect(published).toEqual([CHAT]);
  });

  test("step 3: a second call starts nothing twice and sends no brief again", async () => {
    await startReview(deps(), CHAT);
    const r = await startReview(deps(), CHAT);
    expect(agents.specs).toHaveLength(3);
    expect(agents.sent).toHaveLength(3);
    expect(r.agents).toEqual(["reviewer-1", "reviewer-2", "card-runner"]);
  });

  test("H2: with no app address the card runner does not start and every card is unclear, none fail", async () => {
    chatInfo.appAddress = null;
    const r = await startReview(deps(), CHAT);
    expect(r.agents).toEqual(["reviewer-1", "reviewer-2"]);
    expect(agents.specs.map((s) => s.id)).toEqual(["reviewer-1", "reviewer-2"]);
    const cards = readCards(dir).cards;
    expect(cards).toHaveLength(2);
    expect(cards.every((c) => c.result === "unclear" && c.note === "No app address is set for this repo")).toBe(true);
    expect(cards.some((c) => c.result === "fail")).toBe(false);
  });
});

// ───────────────────────────── sendFixList ─────────────────────────────

const TASKS = "# Tasks\n\n## Phase 1 — Build\n\n- [x] T001 first — `a.ts` — verify: `bun test`\n";
const finding = (n: number, status: string, extra = "") => `\n## F${n} · high · codex · src/a.ts:${n}\nProblem ${n}\nStatus: ${status}\n${extra}`;
const note = (n: number, to: string, status = "queued") => `\n## Note ${n} · 2026-11-11 15:05 · review → ${to}\nYou: fix it\nNote: Fix thing ${n}\nStatus: ${status}\n`;

function seedReview(findings: string, notes: string) {
  mkdirSync(join(dir, "run", "review"), { recursive: true });
  writeFileSync(join(dir, "TASKS.md"), TASKS);
  writeFileSync(join(dir, "run", "review", "findings.md"), "# Findings\n" + findings);
  writeFileSync(join(dir, "run", "handoffs.md"), "# Handoffs\n" + notes);
}

describe("sendFixList", () => {
  let last: number;
  let calls: string[];
  let sentToOrchestrator: { chatId: string; phase: number; fixes: { n: number; text: string; from: string }[] }[];
  let readNotes: number[][];

  function sendDeps(): SendFixListDeps {
    return {
      orchestrator: { fixList: (chatId, phase, fixes) => sentToOrchestrator.push({ chatId, phase, fixes }) },
      chat: () => ({ featureDir: dir }),
      lastSent: () => last,
      setLastSent: (_id, n) => {
        last = n;
        calls.push(`setLastSent ${n}`);
      },
      markFixNotesRead: (_id, nums) => {
        readNotes.push(nums);
        calls.push("markFixNotesRead");
      },
      buildRunning: () => calls.push("buildRunning"),
      publish: () => calls.push("publish"),
    };
  }
  beforeEach(() => {
    last = 0;
    calls = [];
    sentToOrchestrator = [];
    readNotes = [];
  });

  test("it adds one phase, stores lastSent, marks the fixes notes read, sets Build running and hands the fixes over", () => {
    seedReview(finding(1, "open") + finding(2, "rejected") + finding(3, "accepted"), note(1, "fixes") + note(2, "orchestrator") + note(3, "fixes", "undone"));
    const r = sendFixList(sendDeps(), CHAT);
    expect(r).toEqual({ ok: true, phase: 2, sent: 3 });
    expect(parseTasks(readFileSync(join(dir, "TASKS.md"), "utf8")).phases.map((p) => p.title)).toEqual(["Build", "Fixes"]);
    expect(last).toBe(3);
    expect(readNotes).toEqual([[1]]);
    expect(calls).toContain("buildRunning");
    expect(sentToOrchestrator).toHaveLength(1);
    expect(sentToOrchestrator[0]?.phase).toBe(2);
    expect(sentToOrchestrator[0]?.fixes.map((f) => f.from)).toEqual(["F1", "F3", "Note 1"]);
    expect(readFileSync(join(dir, "run", "review", "fixes.md"), "utf8")).toContain("- X1 Problem 1 (src/a.ts:1) — from F1");
  });

  test("it is refused while a finding is disputed, and nothing changes", () => {
    seedReview(finding(1, "open") + finding(2, "disputed", "Dispute: claude: wrong\n"), "");
    const r = sendFixList(sendDeps(), CHAT);
    expect(r).toEqual({ ok: false, error: "A finding is disputed" });
    expect(readFileSync(join(dir, "TASKS.md"), "utf8")).toBe(TASKS);
    expect(calls).toEqual([]);
    expect(sentToOrchestrator).toEqual([]);
  });

  test("H3: sent twice, it adds one phase, once, and the second call sends nothing", () => {
    seedReview(finding(1, "open"), note(1, "fixes"));
    const first = sendFixList(sendDeps(), CHAT);
    const afterFirst = readFileSync(join(dir, "TASKS.md"), "utf8");
    const second = sendFixList(sendDeps(), CHAT);
    expect(first).toEqual({ ok: true, phase: 2, sent: 2 });
    expect(second).toEqual({ ok: true, phase: null, sent: 0 });
    expect(readFileSync(join(dir, "TASKS.md"), "utf8")).toBe(afterFirst);
    expect(parseTasks(afterFirst).phases.filter((p) => p.title === "Fixes")).toHaveLength(1);
    expect(sentToOrchestrator).toHaveLength(1);
    expect(readNotes).toEqual([[1]]);
    expect(calls.filter((c) => c === "buildRunning")).toHaveLength(1);
  });

  test("a later fix goes out in a new phase and the old ones do not go twice", () => {
    seedReview(finding(1, "open"), "");
    sendFixList(sendDeps(), CHAT);
    writeFileSync(join(dir, "run", "handoffs.md"), "# Handoffs\n" + note(1, "fixes"));
    const r = sendFixList(sendDeps(), CHAT);
    expect(r).toEqual({ ok: true, phase: 3, sent: 1 });
    expect(sentToOrchestrator[1]?.fixes.map((f) => f.from)).toEqual(["Note 1"]);
    expect(last).toBe(2);
  });

  test("an empty list adds no phase and calls nothing", () => {
    seedReview("", "");
    expect(sendFixList(sendDeps(), CHAT)).toEqual({ ok: true, phase: null, sent: 0 });
    expect(calls).toEqual([]);
  });
});

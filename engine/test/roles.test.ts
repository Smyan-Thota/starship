import { describe, expect, test } from "bun:test";
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { rolePrompt, templatesDir } from "../src/agents/roles.ts";
import { parseTasks } from "../src/folder/tasks.ts";
import type { Role, Stage } from "../src/types.ts";

const WT = "/work/wt";
const FF = "/work/wt/docs/features/demo";
const TASK = { id: "T042", text: "Match recipe numbers without the dash", files: ["src/recipes/match.ts", "src/recipes/match.test.ts"], verify: "bun test src/recipes/match.test.ts" };

function prompt(role: Role, stage: Stage | null = "build", extra: { task?: typeof TASK } = {}): string {
  return rolePrompt(role, { chatTitle: "Recipe search", stage, worktree: WT, featureFolder: FF, ...extra });
}

describe("admin prompt", () => {
  test("every stage: the only agent, one note for each instruction, plan files only, a worker's question", () => {
    for (const stage of ["map", "plan", "build", "review"] as const) {
      const p = prompt("admin", stage);
      expect(p).toContain("You are the only agent the owner talks to.");
      expect(p).toContain('starship note --to <orchestrator|plan|fixes|repo> --said "<the owner\'s own words>" "<one instruction>"');
      expect(p).toContain("exactly one note");
      expect(p).toContain("Never talk to the orchestrator, a worker or a reviewer in another way.");
      expect(p).toContain("plan files and decision records only");
      expect(p).toContain("never edit code");
      expect(p).toContain("Answer the owner in plain words, short.");
      expect(p).toContain('starship answer <Qn> "<text>"');
      expect(p).toContain("Recipe search");
    }
    expect(prompt("admin", null)).toContain("You are the only agent the owner talks to.");
  });

  test("plan: the steps come in the order of the plan", () => {
    const p = prompt("admin", "plan");
    const marks = [
      "Settle the data model first",
      "Reuse an existing table or type before you add one",
      "spans many tables",
      "Ask about each layer",
      "one question at a time",
      "clearly in scope or out of scope",
      "wireframes/<name>.html",
      "never inside the app",
      "publish it as an artifact",
      "test strategy",
      "staff checklist",
      "data, API, errors, edge cases, tests, rollout",
      `Start from the templates in ${templatesDir()}`,
      "starship map overlay <file>",
      "starship plan check",
    ];
    let at = -1;
    for (const m of marks) {
      const i = p.indexOf(m);
      if (i < 0) throw new Error(`missing: ${m}`);
      if (i <= at) throw new Error(`out of order: ${m}`);
      at = i;
    }
    expect(p).toContain("before you say the plan is ready");
    expect(p).toContain(FF);
  });

  test("build: no change to TASKS.md, a change is a note to the orchestrator, progress comes from run/progress.md", () => {
    const p = prompt("admin", "build");
    expect(p).toContain("Do not change TASKS.md");
    expect(p).toContain("--to orchestrator");
    expect(p).toContain("run/progress.md");
    expect(p).toContain("The chat is in the build stage now.");
    expect(p).toContain("starship task retry <id>");
    // One admin session lives through every stage, so the prompt carries the rules of all of them.
    expect(p).toContain("Stage rules for Plan");
    expect(p).toContain("Stage rules for Review");
  });

  test("review: a fix is a note to fixes, a disputed finding is accepted or rejected", () => {
    const p = prompt("admin", "review");
    expect(p).toContain("--to fixes");
    expect(p).toContain("starship finding accept <n>");
    expect(p).toContain('starship finding reject <n> "<why>"');
    expect(p).toContain("The chat is in the review stage now.");
  });

  test("the admin prompt differs by stage", () => {
    const all = (["map", "plan", "build", "review"] as const).map((s) => prompt("admin", s));
    all.push(prompt("admin", null));
    expect(new Set(all).size).toBe(5);
  });

  test("map: the admin agent builds the map", () => {
    const p = prompt("admin", "map");
    expect(p).toContain("starship map validate <file>");
    expect(p).toContain("starship map import <file> --repo <repo>");
    expect(p).toContain("starship map build");
    expect(p).toContain("map.example.json");
    expect(p).toContain("Do not invent a box, a chip or a pipe.");
  });
});

describe("other role prompts", () => {
  test("orchestrator: decides only what the rules cannot, acts through starship task and note ack, never types to a worker", () => {
    const p = prompt("orchestrator");
    expect(p).toContain("You decide only what the engine's rules cannot.");
    expect(p).toContain("starship task add|edit|split|block|drop|retry");
    expect(p).toContain("starship note ack <n>");
    expect(p).toContain("You never type to a worker");
    expect(p).toContain("never write a file");
    expect(p).toContain("Confirm each note you read");
    expect(p).not.toContain("starship note --to");
  });

  test("worker: one task, its files, check before the turn ends, ask when blocked, never commit or push", () => {
    const p = prompt("worker", "build", { task: TASK });
    expect(p).toContain("exactly one task");
    expect(p).toContain("T042");
    expect(p).toContain("Match recipe numbers without the dash");
    for (const f of TASK.files) expect(p).toContain(f);
    expect(p).toContain("bun test src/recipes/match.test.ts");
    expect(p).toContain("Change only its listed files");
    expect(p).toContain("starship check T042");
    expect(p).toContain('starship ask --task T042 "<question>"');
    expect(p).toContain("Never commit");
    expect(p).toContain("never push");
    expect(p).toContain("never run a typecheck, test suite, build or install directly");
    expect(p).toContain(WT);
  });

  test("worker: a prompt without a task still names the commands", () => {
    const p = prompt("worker");
    expect(p).toContain("starship check <task>");
    expect(p).toContain('starship ask --task <id> "<question>"');
  });

  test("reviewer: tries to break the change, reports findings, disputes, writes nothing", () => {
    const p = prompt("reviewer", "review");
    expect(p).toContain("Try to break the change.");
    expect(p).toContain('starship finding add --sev <high|medium|low> --where <file:line> "<text>"');
    expect(p).toContain('starship finding dispute <n> "<why>"');
    expect(p).toContain("Write nothing.");
  });

  test("card runner: acts out each card, records results, an unreachable app is unclear and never fail", () => {
    const p = prompt("cardRunner", "review");
    expect(p).toContain("Act out each story card in the running app with your own browser tool.");
    expect(p).toContain('starship card result <card> pass|fail|unclear "<note>"');
    expect(p).toContain("every card is unclear, never fail");
    expect(p).toContain("Write nothing.");
  });

  test("every prompt says who the agent is and which chat it serves", () => {
    for (const role of ["admin", "orchestrator", "worker", "reviewer", "cardRunner"] as const) {
      const p = prompt(role, "build");
      expect(p).toContain('chat "Recipe search"');
      expect(p.startsWith("You are the ")).toBe(true);
    }
  });

  test("a chat with no worktree and no feature folder still gets a prompt", () => {
    for (const role of ["admin", "orchestrator", "worker", "reviewer", "cardRunner"] as const) {
      const p = rolePrompt(role, { chatTitle: "Plain talk", stage: null, worktree: null, featureFolder: null });
      expect(p.length).toBeGreaterThan(100);
      expect(p).not.toContain("null");
      expect(p).not.toContain("undefined");
    }
  });

  test("no prompt tells an agent to push, to commit, or to write under the tools' own folders", () => {
    for (const role of ["admin", "orchestrator", "worker", "reviewer", "cardRunner"] as const) {
      const p = prompt(role, "build", { task: TASK });
      expect(p).not.toMatch(/\bgit (push|commit)\b/);
    }
  });
});

describe("templates", () => {
  const FILES = ["SPEC.md", "PLAN.md", "TASKS.md", "ACCEPTANCE.md", "PROMPTS.md", "ADR.md"];
  const read = (f: string) => readFileSync(join(templatesDir(), f), "utf8");

  test("the templates folder is engine/templates and holds every file", () => {
    expect(templatesDir().endsWith(join("engine", "templates"))).toBe(true);
    for (const f of FILES) expect([f, existsSync(join(templatesDir(), f))]).toEqual([f, true]);
  });

  test("the PLAN template has the staff checklist headings, and numbered In scope items", () => {
    const plan = read("PLAN.md");
    for (const h of ["## Goal", "## In scope", "## Out of scope", "## Design rules", "## Data", "## Interfaces (API)", "## Error and edge behavior", "## Test strategy", "## Rollout", "## Risks"]) {
      expect(plan).toContain(`\n${h}\n`);
    }
    expect(plan).toMatch(/\n1\. .*\(in scope #1\)/);
  });

  test("the SPEC template has the sections of Starship's own spec", () => {
    const spec = read("SPEC.md");
    for (const h of ["## What it is", "## Problem", "## Scope", "## Deferred", "## Defaults, with the why", "## Success measure"]) expect(spec).toContain(`\n${h}\n`);
  });

  test("the TASKS template uses the grammar of the parser and traces an in-scope item", () => {
    const doc = parseTasks(read("TASKS.md"));
    const tasks = doc.phases.flatMap((p) => p.tasks);
    expect(tasks.length).toBeGreaterThanOrEqual(2);
    expect(tasks.some((t) => /in scope #\d/.test(t.trace))).toBe(true);
    expect(doc.phases.some((p) => p.checkpoint)).toBe(true);
    expect(read("TASKS.md")).toContain("## Done when");
  });

  test("the ACCEPTANCE, PROMPTS and ADR templates keep the structure of docs/templates", () => {
    const acc = read("ACCEPTANCE.md");
    for (const h of ["## Behavior", "## Errors", "## Tests"]) expect(acc).toContain(`\n${h}\n`);
    const prompts = read("PROMPTS.md");
    for (const h of ["## Prompt 0 — inspect", "## Final prompt — docs and acceptance"]) expect(prompts).toContain(`\n${h}\n`);
    const adr = read("ADR.md");
    for (const h of ["## Context", "## Decision drivers", "## Decision", "## Alternatives", "## Consequences", "## Confirmation", "## Anchors", "## Revisit when", "## Open questions"]) {
      expect(adr).toContain(`\n${h}\n`);
    }
    expect(adr).toContain("Status: Proposed");
  });

  test("no template names the Python tool of the originals", () => {
    for (const f of FILES) {
      const t = read(f);
      expect([f, t.includes("uv run")]).toEqual([f, false]);
      expect([f, t.includes(".py")]).toEqual([f, false]);
    }
  });
});

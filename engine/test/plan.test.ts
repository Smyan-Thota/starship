import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type PlanProblem, planFiles, validatePlan } from "../src/folder/plan.ts";
import { drop, repoRoot, tempDir } from "./helpers.ts";

let root: string;
let feat: string;
let adr: string;

const SPEC = "# SPEC\n\n## Problem\n\nA problem.\n\n## Scope\n\n- one\n";
const PLAN = [
  "# PLAN",
  "",
  "## Goal",
  "",
  "A goal.",
  "",
  "## In scope",
  "",
  "1. Alpha",
  "2. Beta",
  "",
  "## Out of scope",
  "",
  "- Gamma",
  "",
  "## Data",
  "",
  "## Interfaces",
  "",
  "## Errors",
  "",
  "## Edge cases",
  "",
  "## Tests",
  "",
  "## Rollout",
  "",
].join("\n");
const TASKS = [
  "# TASKS",
  "",
  "## Phase 0 — Foundation",
  "",
  "- [ ] T001 Do alpha — `a.ts` — verify: `bun test a` (plan: In scope #1)",
  "- [ ] T002 Do beta — `b.ts` — verify: `bun test b` (in scope #2)",
  "",
].join("\n");
const ACCEPTANCE = "# Acceptance\n\n## Behavior\n\n- Alpha works.\n";

const put = (name: string, text: string) => {
  mkdirSync(join(feat, name, ".."), { recursive: true });
  writeFileSync(join(feat, name), text);
};
const good = () => {
  put("SPEC.md", SPEC);
  put("PLAN.md", PLAN);
  put("TASKS.md", TASKS);
  put("ACCEPTANCE.md", ACCEPTANCE);
};
const codes = (ps: PlanProblem[]) => ps.map((p) => p.code);
const check = () => validatePlan(feat, { adrDir: adr });

beforeEach(() => {
  root = tempDir();
  feat = join(root, "docs", "features", "demo");
  adr = join(root, "docs", "adr");
  mkdirSync(feat, { recursive: true });
  mkdirSync(adr, { recursive: true });
});
afterEach(() => drop(root));

describe("validatePlan", () => {
  test("a small good plan has no problem", () => {
    good();
    expect(check()).toEqual([]);
  });

  test("this repo's own plan has no problem", () => {
    const own = join(repoRoot, "docs", "features", "starship");
    expect(validatePlan(own, { adrDir: join(repoRoot, "docs", "adr") })).toEqual([]);
  });

  test("a missing plan file is reported once, with no section problem for it", () => {
    good();
    rmSync(join(feat, "ACCEPTANCE.md"));
    const ps = check();
    expect(ps).toEqual([{ file: "ACCEPTANCE.md", line: null, code: "missing-file", text: "ACCEPTANCE.md is missing" }]);
  });

  test("an empty or absent folder reports four missing files and does not throw", () => {
    const ps = validatePlan(join(root, "nowhere"), { adrDir: adr });
    expect(codes(ps)).toEqual(["missing-file", "missing-file", "missing-file", "missing-file"]);
  });

  test("SPEC without a scope section and PLAN without goal and out of scope", () => {
    good();
    put("SPEC.md", "# SPEC\n\n## Problem\n\nx\n");
    put("PLAN.md", PLAN.replace("## Goal", "## Aim").replace("## Out of scope", "## Later"));
    const ps = check();
    expect(ps.map((p) => [p.file, p.code])).toEqual([
      ["SPEC.md", "missing-section"],
      ["PLAN.md", "missing-section"],
      ["PLAN.md", "missing-section"],
    ]);
    expect(ps[0]?.text).toBe("SPEC.md has no section for scope");
  });

  test("headings match without regard to case and trailing text", () => {
    good();
    put("SPEC.md", "# SPEC\n\n## PROBLEM STATEMENT\n\n## scope (v1)\n");
    put("PLAN.md", PLAN.replace("## In scope", "## IN SCOPE (v1)").replace("## Goal", "### goal and measure"));
    expect(check()).toEqual([]);
  });

  test("a heading inside a code fence does not count", () => {
    good();
    put("SPEC.md", "# SPEC\n\n## Problem\n\n```\n## Scope\n```\n");
    expect(codes(check())).toEqual(["missing-section"]);
  });

  test("ACCEPTANCE with no check item", () => {
    good();
    put("ACCEPTANCE.md", "# Acceptance\n\n## Behavior\n\nNothing listed.\n");
    const ps = check();
    expect(ps).toEqual([{ file: "ACCEPTANCE.md", line: null, code: "missing-section", text: "ACCEPTANCE.md has no check item" }]);
  });

  test("a checkbox or numbered item counts as a check item", () => {
    good();
    put("ACCEPTANCE.md", "# A\n\n1. Alpha works.\n");
    expect(check()).toEqual([]);
    put("ACCEPTANCE.md", "# A\n\n- [ ] Alpha works.\n");
    expect(check()).toEqual([]);
  });

  test("TASKS.md that does not parse gives its line", () => {
    good();
    put("TASKS.md", `${TASKS}\n- [ ] T003 broken line\n`);
    const ps = check();
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatchObject({ file: "TASKS.md", code: "tasks-unreadable", line: 8 });
  });

  test("TASKS.md with no task", () => {
    good();
    put("TASKS.md", "# TASKS\n\n## Phase 0 — Foundation\n\nGoal: x\n");
    const ps = check();
    expect(ps).toEqual([{ file: "TASKS.md", line: null, code: "tasks-unreadable", text: "TASKS.md has no task" }]);
  });

  test("an in scope item without a task, with the line of the item", () => {
    good();
    put("PLAN.md", PLAN.replace("2. Beta", "2. Beta\n3. Delta"));
    const ps = check();
    expect(ps).toEqual([{ file: "PLAN.md", line: 11, code: "scope-without-task", text: "In scope #3 has no task" }]);
  });

  test("one trace can name several items", () => {
    good();
    put("TASKS.md", TASKS.replace("(in scope #2)", "(in scope #2, #3; plan: Edge C1)"));
    put("PLAN.md", PLAN.replace("2. Beta", "2. Beta\n3. Delta"));
    expect(check()).toEqual([]);
  });

  test("a number in another part of a trace does not name an item", () => {
    good();
    put("TASKS.md", TASKS.replace("(in scope #2)", "(plan: Edge #2)"));
    expect(codes(check())).toEqual(["scope-without-task"]);
  });

  test("scope check is skipped when TASKS.md is unreadable", () => {
    good();
    put("TASKS.md", "nothing here\n");
    expect(codes(check())).toEqual(["tasks-unreadable"]);
  });

  test.each(["Rejected", "Superseded"])("a %s decision record that the plan names", (status) => {
    good();
    writeFileSync(join(adr, "2026-11-11-use-sqlite.md"), `# Use sqlite\n\nStatus: ${status}\nDate: 2026-11-11\n`);
    put("PLAN.md", PLAN.replace("## Goal", "ADRs: 2026-11-11-use-sqlite\n\n## Goal"));
    const ps = check();
    expect(ps).toEqual([
      { file: "PLAN.md", line: 3, code: "decision-status", text: `Decision record use-sqlite is ${status}` },
    ]);
  });

  test("TASKS.md can name a decision record too", () => {
    good();
    writeFileSync(join(adr, "2026-11-11-use-sqlite.md"), "# x\n\nStatus: Rejected\n");
    put("TASKS.md", TASKS.replace("(in scope #2)", "(in scope #2; ADR use-sqlite: Confirmation 1)"));
    const ps = check();
    expect(ps.map((p) => [p.file, p.code])).toEqual([["TASKS.md", "decision-status"]]);
  });

  test("Proposed and Accepted records pass, and a Rejected record the plan never names is ignored", () => {
    good();
    writeFileSync(join(adr, "2026-11-11-aaa.md"), "# a\n\nStatus: Proposed\n");
    writeFileSync(join(adr, "2026-11-11-bbb.md"), "# b\n\nStatus: Accepted\n");
    writeFileSync(join(adr, "2026-11-11-ccc.md"), "# c\n\nStatus: Rejected\n");
    put("PLAN.md", `${PLAN}\nADR aaa and ADR bbb.\n`);
    expect(check()).toEqual([]);
  });

  test("a slug inside a longer slug is not a name", () => {
    good();
    writeFileSync(join(adr, "2026-11-11-db.md"), "# a\n\nStatus: Rejected\n");
    put("PLAN.md", `${PLAN}\nSee 2026-11-11-db-pool and adr-db-x.\n`);
    expect(check()).toEqual([]);
  });

  test("a missing decision folder is not a problem", () => {
    good();
    expect(validatePlan(feat, { adrDir: join(root, "no-adr") })).toEqual([]);
  });

  test.each([
    ["data", "## Data"],
    ["API or interfaces", "## Interfaces"],
    ["errors", "## Errors"],
    ["edge cases", "## Edge cases"],
    ["tests", "## Tests"],
    ["rollout", "## Rollout"],
  ])("the staff checklist wants a section for %s", (what, heading) => {
    good();
    put("PLAN.md", PLAN.replace(`${heading}\n`, "## Other\n"));
    expect(check()).toEqual([
      { file: "PLAN.md", line: null, code: "staff-checklist", text: `PLAN.md has no section for ${what}` },
    ]);
  });

  test("a checklist word inside a longer heading counts, in any case", () => {
    good();
    put("PLAN.md", PLAN.replace("## Interfaces", "## HTTP API").replace("## Errors", "## Error and edge behavior").replace("## Edge cases", "## Other").replace("## Tests", "## Test strategy"));
    expect(check()).toEqual([]);
  });
});

describe("planFiles", () => {
  test("lists the plan files that exist, as relative paths", () => {
    put("SPEC.md", SPEC);
    put("PLAN.md", PLAN);
    put("PROMPTS.md", "x");
    put("wireframes/home.html", "<p>x</p>");
    put("wireframes/links.json", "{}");
    put("run/state.json", "{}");
    put("notes.txt", "x");
    expect(planFiles(feat)).toEqual(["SPEC.md", "PLAN.md", "PROMPTS.md", "wireframes/home.html"]);
  });

  test("a folder that is not there gives an empty list", () => {
    expect(planFiles(join(root, "nowhere"))).toEqual([]);
  });
});

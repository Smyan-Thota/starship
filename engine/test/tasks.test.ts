import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  ParseError,
  addPhase,
  addTask,
  allTasks,
  checkTask,
  counts,
  editTask,
  findTask,
  nextIdInPhase,
  nextPhaseStartId,
  parseTasks,
  serialize,
  taskLine,
} from "../src/folder/tasks.ts";
import { fixture, repoRoot } from "./helpers.ts";

const read = (p: string) => readFileSync(p, "utf8");
const SMALL = [
  "# TASKS — demo",
  "",
  "## Phase 0 — Foundation",
  "",
  "Blocks every later phase.",
  "",
  "- [x] T001 Add the type — `src/a.ts` — verify: `bun test a` (plan: Interfaces)",
  "- [ ] T002 [P] Add the reader — `src/b.ts`, `test/b.test.ts` — verify: `bun test b` still green (plan: In scope #1)",
  "- [ ] T003 [P] Add the writer — `src/c.ts` — verify: same (plan: In scope #1)",
  "",
  "Checkpoint: both work — `bun test`",
  "",
  "## Phase 1 — Screen",
  "",
  "Goal: one screen.",
  "",
  "- [ ] T010 Show the list — `src/d.tsx` — verify: open the page and look (in scope #2)",
  "",
  "Checkpoint: `bun run build`",
  "",
  "## Done when",
  "",
  "- [ ] Every in-scope behavior has a checked task",
  "",
].join("\n");

describe("fixtures", () => {
  test("fixtures: the resilient-github-client file parses and writes back the same bytes", () => {
    const text = read(fixture("rate-limited-cli", "resilient-github-client-TASKS.md"));
    const doc = parseTasks(text, "resilient");
    expect(serialize(doc)).toBe(text);
    expect(doc.phases.map((p) => p.n)).toEqual([0, 1, 2, 3, 4, 5]);

    const t001 = findTask(doc, "T001")!;
    expect(t001.files).toEqual(["src/rate_limited_cli/auth.py", "tests/test_auth.py"]);
    expect(t001.verify).toBe("uv run pytest tests/test_auth.py");
    expect(t001.trace).toBe("plan: Interfaces");
    expect(t001.parallel).toBe(false);
    expect(findTask(doc, "T002")!.parallel).toBe(true);

    const t005 = findTask(doc, "T005")!;
    expect(t005.verify).toBe("uv run pytest");
    expect(t005.verifyNote).toBe("still green");
    expect(t005.trace).toBe("plan: Design rules");

    const t013 = findTask(doc, "T013")!;
    expect(t013.verify).toContain("grep -q GITHUB_TOKEN");
    expect(t013.verify).toContain("grep -q -- --token");
    expect(t013.trace).toBe("ADR token-from-environment: Confirmation 1 and 3");

    const t021 = findTask(doc, "T021")!;
    expect(t021.verify).toBe(findTask(doc, "T020")!.verify);
    expect(t021.verifyNote).toBe("same");

    const t053 = findTask(doc, "T053")!;
    expect(t053.verify).toBeNull();
    expect(t053.verifyNote).toContain("index matches");

    expect(doc.phases[0]!.checkpoint).toMatchObject({ command: "uv run pytest", text: "constructor accepts the four collaborators and v1 tests pass" });
    expect(doc.phases[1]!.checkpoint).toMatchObject({ command: "uv run pytest tests/test_auth.py tests/test_cli.py", text: "" });
    expect(allTasks(doc).every((t) => t.files.length > 0 && !t.done)).toBe(true);
  });

  test("fixtures: the v1-repos-command file parses and writes back the same bytes", () => {
    const text = read(fixture("rate-limited-cli", "v1-repos-command-TASKS.md"));
    const doc = parseTasks(text, "v1");
    expect(serialize(doc)).toBe(text);
    expect(doc.phases.map((p) => p.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7]);
    for (const id of ["T021", "T022", "T023", "T024"]) {
      expect(findTask(doc, id)!.verify).toBe(findTask(doc, "T020")!.verify);
    }
    expect(findTask(doc, "T011")!.verify).toBeNull();
    expect(findTask(doc, "T070")!.verify).toBeNull();
    expect(doc.phases[1]!.checkpoint!.command).toBe("uv run ruff check src/rate_limited_cli/models.py");
    const ids = allTasks(doc).map((t) => t.id);
    expect(new Set(ids).size).toBe(ids.length);
  });

  test("fixtures: Starship's own task file parses and writes back the same bytes", () => {
    const text = read(join(repoRoot, "docs", "features", "starship", "TASKS.md"));
    const doc = parseTasks(text, "starship");
    expect(serialize(doc)).toBe(text);
    expect(doc.phases.map((p) => p.n)).toEqual([0, 1, 2, 3, 4, 5, 6, 7, 8]);
    const tasks = allTasks(doc);
    expect(tasks.length).toBeGreaterThan(60);
    expect(tasks.every((t) => t.files.length > 0 && t.trace.length > 0)).toBe(true);
    expect(findTask(doc, "T091")!.verify).toBeNull();
    expect(findTask(doc, "T009")!.verify).toContain("find .");
    expect(doc.phases.every((p) => p.n === 8 || p.checkpoint !== undefined)).toBe(true);
  });

  test("fixtures: the sample folder's task file parses", () => {
    const text = read(fixture("recipe-search", "TASKS.md"));
    const doc = parseTasks(text);
    expect(serialize(doc)).toBe(text);
    const c = counts(doc);
    expect(c.total).toBe(20);
    expect(c.verified).toBe(9);
    expect(findTask(doc, "T022")!.parallel).toBe(true);
  });
});

describe("parse", () => {
  test("reads phases, tasks, flags, files, commands, notes and traces", () => {
    const doc = parseTasks(SMALL);
    expect(doc.phases.map((p) => [p.n, p.title, p.tasks.length])).toEqual([
      [0, "Foundation", 3],
      [1, "Screen", 1],
    ]);
    const [a, b, c] = doc.phases[0]!.tasks;
    expect(a).toMatchObject({ id: "T001", done: true, parallel: false, text: "Add the type", files: ["src/a.ts"], verify: "bun test a", line: 7 });
    expect(b).toMatchObject({ id: "T002", done: false, parallel: true, files: ["src/b.ts", "test/b.test.ts"], verify: "bun test b", verifyNote: "still green", trace: "plan: In scope #1" });
    expect(c).toMatchObject({ id: "T003", verify: "bun test b", verifyNote: "same" });
    expect(doc.phases[1]!.tasks[0]).toMatchObject({ id: "T010", verify: null, verifyNote: "open the page and look", trace: "in scope #2" });
    expect(doc.phases[0]!.checkpoint).toEqual({ text: "both work", command: "bun test", line: 11 });
    expect(doc.phases[1]!.checkpoint).toMatchObject({ text: "", command: "bun run build" });
  });

  test("a checkbox outside a phase is not a task", () => {
    const doc = parseTasks(SMALL);
    expect(allTasks(doc).map((t) => t.id)).toEqual(["T001", "T002", "T003", "T010"]);
  });

  test("C2: a line the parser cannot read gives the file and the line number, and no guess", () => {
    const bad = SMALL.replace("- [ ] T003 [P] Add the writer", "- [ ] Add the writer");
    let err: unknown;
    try {
      parseTasks(bad, "docs/features/x/TASKS.md");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(ParseError);
    expect((err as ParseError).file).toBe("docs/features/x/TASKS.md");
    expect((err as ParseError).line).toBe(9);
    expect((err as ParseError).message).toContain("docs/features/x/TASKS.md:9");
  });

  test.each([
    ["no verify part", "- [ ] T004 Text — `src/x.ts`", "verify"],
    ["no files part", "- [ ] T004 Text — verify: `cmd`", "files"],
    ["empty verify", "- [ ] T004 Text — `src/x.ts` — verify: (plan: X)", "empty"],
    ["an id that is used", "- [ ] T001 Text — `src/x.ts` — verify: `cmd`", "already on line 7"],
    ["a broken box", "- [] T004 Text — `src/x.ts` — verify: `cmd`", "checkbox line"],
  ])("C2: refuses %s", (_name, line, word) => {
    const bad = SMALL.replace("\nCheckpoint: both work", "\n" + line + "\n\nCheckpoint: both work");
    expect(() => parseTasks(bad)).toThrow(ParseError);
    expect(() => parseTasks(bad)).toThrow(word);
  });

  test("C2: 'verify: same' with no earlier command is refused", () => {
    const bad = SMALL.replace("verify: `bun test a` (plan: Interfaces)", "verify: same (plan: Interfaces)");
    expect(() => parseTasks(bad)).toThrow("no earlier command");
  });

  test("C2: a file with no phase is refused", () => {
    expect(() => parseTasks("# TASKS\n\n- [ ] T001 x — `a` — verify: `b`\n")).toThrow("no '## Phase");
  });

  test("C2: a phase number used twice is refused", () => {
    expect(() => parseTasks(SMALL.replace("## Phase 1 — Screen", "## Phase 0 — Screen"))).toThrow("phase 0 is already on line 3");
  });

  test("Windows line ends parse and survive a write", () => {
    const crlf = SMALL.replaceAll("\n", "\r\n");
    const doc = parseTasks(crlf);
    expect(allTasks(doc).length).toBe(4);
    expect(serialize(doc)).toBe(crlf);
    expect(serialize(checkTask(doc, "T002"))).toBe(crlf.replace("- [ ] T002", "- [x] T002"));
  });
});

describe("write", () => {
  const diff = (a: string, b: string) => {
    const x = a.split("\n");
    const y = b.split("\n");
    return y.filter((l, i) => l !== x[i]).length + Math.abs(x.length - y.length);
  };

  test("checking a task changes that one line", () => {
    const doc = parseTasks(SMALL);
    const next = checkTask(doc, "T002");
    expect(findTask(next, "T002")!.done).toBe(true);
    expect(diff(SMALL, serialize(next))).toBe(1);
    expect(serialize(checkTask(next, "T002", false))).toBe(SMALL);
  });

  test("checking a task that does not exist is an error", () => {
    expect(() => checkTask(parseTasks(SMALL), "T999")).toThrow("no task T999");
  });

  test("a new phase goes before 'Done when' and starts at the next ten", () => {
    const doc = parseTasks(SMALL);
    expect(nextPhaseStartId(doc)).toBe("T020");
    const next = addPhase(doc, "Fixes from review", [
      { text: "Wait 250 ms between requests", files: ["src/SearchBox.tsx"], verify: "bun test search", trace: "Finding 1" },
      { text: "Match the copy", files: ["src/Results.tsx"], verify: null, verifyNote: "read the screen", trace: "Finding 3" },
    ]);
    expect(next.phases.map((p) => p.n)).toEqual([0, 1, 2]);
    expect(next.phases[2]!.tasks.map((t) => t.id)).toEqual(["T020", "T021"]);
    expect(next.phases[2]!.tasks[1]).toMatchObject({ verify: null, verifyNote: "read the screen", trace: "Finding 3" });
    const out = serialize(next);
    expect(out.indexOf("## Phase 2 — Fixes from review")).toBeLessThan(out.indexOf("## Done when"));
    expect(out.indexOf("## Phase 2 — Fixes from review")).toBeGreaterThan(out.indexOf("Checkpoint: `bun run build`"));
    expect(out.endsWith("- [ ] Every in-scope behavior has a checked task\n")).toBe(true);
  });

  test("a new phase at the end of a file with no later section", () => {
    const text = SMALL.slice(0, SMALL.indexOf("## Done when"));
    const next = addPhase(parseTasks(text), "More", [{ text: "One more", files: ["a.ts"], verify: "true" }]);
    expect(next.phases[2]!.tasks[0]!.id).toBe("T020");
    expect(serialize(next).endsWith("\n")).toBe(true);
  });

  test("a new task goes after the last task of its phase", () => {
    const doc = parseTasks(SMALL);
    expect(nextIdInPhase(doc, 0)).toBe("T004");
    const next = addTask(doc, 0, { text: "Follow-up for note 4", files: ["src/c.ts"], verify: "bun test c", trace: "note 4" });
    expect(next.phases[0]!.tasks.map((t) => t.id)).toEqual(["T001", "T002", "T003", "T004"]);
    expect(findTask(next, "T004")!.line).toBe(findTask(next, "T003")!.line + 1);
    expect(next.phases[0]!.checkpoint!.command).toBe("bun test");
  });

  test("a new id never takes an id of a later phase", () => {
    const lines = SMALL.split("\n");
    const many = [4, 5, 6, 7, 8, 9].map((n) => `- [ ] T00${n} More — \`src/m${n}.ts\` — verify: \`true\``);
    lines.splice(9, 0, ...many);
    const doc = parseTasks(lines.join("\n"));
    expect(nextIdInPhase(doc, 0)).toBe("T009a");
    const next = addTask(doc, 0, { text: "Extra", files: ["x.ts"], verify: "true" });
    expect(findTask(next, "T009a")).toBeDefined();
    expect(nextIdInPhase(next, 0)).toBe("T009b");
  });

  test("a task that is not done can change; a done task cannot", () => {
    const doc = parseTasks(SMALL);
    const next = editTask(doc, "T002", { text: "Add the reader, with paging", files: ["src/b.ts"] });
    expect(findTask(next, "T002")).toMatchObject({ text: "Add the reader, with paging", files: ["src/b.ts"], verify: "bun test b", parallel: true, trace: "plan: In scope #1" });
    expect(() => editTask(doc, "T001", { text: "Changed" })).toThrow("done and cannot change");
  });

  test.each([
    [{ text: "", files: ["a"], verify: "x" }, "needs text"],
    [{ text: "two\nlines", files: ["a"], verify: "x" }, "one line"],
    [{ text: "ok", files: [], verify: "x" }, "name its files"],
    [{ text: "ok", files: ["a`b"], verify: "x" }, "bad file path"],
    [{ text: "ok", files: ["a"], verify: "x `y`" }, "no backtick"],
    [{ text: "ok", files: ["a"], verify: null }, "who checks it"],
    [{ text: "ok — verify: no", files: ["a"], verify: "x" }, "must not contain"],
    [{ text: "ok", files: ["a"], verify: "x", trace: "plan (old)" }, "brackets"],
  ])("a bad new task is refused: %j", (t, word) => {
    expect(() => taskLine("T050", t)).toThrow(word);
  });

  test("a written line reads back as the same task", () => {
    const t = { text: "Open `.html` files in the browser", files: ["engine/src/open.ts", "engine/test/open.test.ts"], verify: "bun test engine/test/open.test.ts", verifyNote: "passes", trace: "plan: Edge C12", parallel: true };
    const doc = addTask(parseTasks(SMALL), 1, { ...t, id: "T011" });
    expect(findTask(doc, "T011")).toMatchObject(t);
  });

  test("counts", () => {
    expect(counts(parseTasks(SMALL))).toEqual({
      phases: [
        { n: 0, title: "Foundation", verified: 1, total: 3 },
        { n: 1, title: "Screen", verified: 0, total: 1 },
      ],
      verified: 1,
      total: 4,
    });
  });
});

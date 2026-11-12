import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname, join } from "node:path";
import { applyAside, changedFiles, commitPlanFiles, commitTask, commitsBetween, headCommit, setAside } from "../src/run/commit.ts";
import { runGit } from "../src/worktree.ts";
import { drop, tempDir } from "./helpers.ts";

let wt: string;
const FEATURE = join("docs", "features", "demo");

function git(cwd: string, ...args: string[]): string {
  const r = runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

function write(rel: string, text: string): void {
  const p = join(wt, rel);
  mkdirSync(dirname(p), { recursive: true });
  writeFileSync(p, text);
}
const read = (rel: string) => readFileSync(join(wt, rel), "utf8");
const head = () => git(wt, "rev-parse", "HEAD").trim();
const count = () => Number(git(wt, "rev-list", "--count", "HEAD").trim());
const filesOf = (rev: string) => git(wt, "show", "--name-only", "--format=", rev).split("\n").filter(Boolean).sort();
const subject = (rev: string) => git(wt, "log", "-1", "--format=%s", rev).trim();

beforeEach(() => {
  wt = tempDir("starship-commit-");
  git(wt, "init", "-q", "-b", "main");
  git(wt, "config", "user.name", "Test");
  git(wt, "config", "user.email", "test@example.com");
  git(wt, "config", "commit.gpgsign", "false");
  write("src/a.ts", "export const a = 1;\n");
  write("src/b.ts", "export const b = 1;\n");
  write("src/c.ts", "export const c = 1;\n");
  write(`${FEATURE}/PLAN.md`, "# Plan\n");
  write("docs/adr/2026-11-11-first.md", "# First\n");
  git(wt, "add", "-A");
  git(wt, "commit", "-q", "-m", "first");
  // What createWorktree does: run files are excluded.
  const excl = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
  mkdirSync(dirname(excl), { recursive: true });
  writeFileSync(excl, `${FEATURE.split("\\").join("/")}/run/\n`);
});
afterEach(() => drop(wt));

describe("changedFiles", () => {
  test("lists tracked changes, deletions and untracked files, but not the excluded run/ files", () => {
    write("src/a.ts", "export const a = 2;\n");
    git(wt, "rm", "-q", "src/c.ts");
    write("src/new/deep/d.ts", "d\n");
    write("with space.txt", "x\n");
    write(`${FEATURE}/run/state.json`, "{}\n");
    write(`${FEATURE}/run/patches/T1-1.patch`, "x\n");
    expect(changedFiles(wt)).toEqual(["src/a.ts", "src/c.ts", "src/new/deep/d.ts", "with space.txt"]);
  });

  test("is empty when nothing changed", () => {
    expect(changedFiles(wt)).toEqual([]);
  });

  test("a rename lists both paths", () => {
    git(wt, "mv", "src/a.ts", "src/z.ts");
    expect(changedFiles(wt)).toEqual(["src/a.ts", "src/z.ts"]);
  });
});

describe("commitTask", () => {
  test("commits only the task's listed files that changed, with the message '<id>: <text>'", () => {
    write("src/a.ts", "export const a = 2;\n");
    write("src/new.ts", "n\n");
    const before = count();
    const r = commitTask({ worktree: wt, taskId: "T022", text: "Add the search box", files: ["src/a.ts", "src/new.ts", "src/b.ts"] });
    expect(r.commit).toBe(head());
    expect(r.committed).toEqual(["src/a.ts", "src/new.ts"]);
    expect(r.outside).toEqual([]);
    expect(r.foreign).toEqual([]);
    expect(count()).toBe(before + 1);
    expect(subject("HEAD")).toBe("T022: Add the search box");
    expect(filesOf("HEAD")).toEqual(["src/a.ts", "src/new.ts"]);
    expect(changedFiles(wt)).toEqual([]);
  });

  test("commit is null and no commit is made when none of its files changed", () => {
    write("src/b.ts", "export const b = 2;\n");
    const before = head();
    const r = commitTask({ worktree: wt, taskId: "T1", text: "x", files: ["src/a.ts"] });
    expect(r.commit).toBeNull();
    expect(r.committed).toEqual([]);
    expect(head()).toBe(before);
    expect(r.outside).toEqual(["src/b.ts"]);
  });

  test("C5: a changed file that no task lists is not committed and goes to outside", () => {
    write("src/a.ts", "export const a = 2;\n");
    write("src/stray.ts", "stray\n");
    write("src/b.ts", "export const b = 2;\n");
    const r = commitTask({ worktree: wt, taskId: "T1", text: "x", files: ["src/a.ts"], otherTasks: { T2: ["src/c.ts"] } });
    expect(r.committed).toEqual(["src/a.ts"]);
    expect(r.outside).toEqual(["src/b.ts", "src/stray.ts"]);
    expect(r.foreign).toEqual([]);
    expect(filesOf("HEAD")).toEqual(["src/a.ts"]);
    expect(changedFiles(wt)).toEqual(["src/b.ts", "src/stray.ts"]);
  });

  test("C6: a changed file that another task lists is not committed and goes to foreign", () => {
    write("src/a.ts", "export const a = 2;\n");
    write("src/b.ts", "export const b = 2;\n");
    write("src/stray.ts", "stray\n");
    const r = commitTask({ worktree: wt, taskId: "T1", text: "x", files: ["src/a.ts"], otherTasks: { T2: ["src/b.ts"], T3: ["src/x.ts"] } });
    expect(r.committed).toEqual(["src/a.ts"]);
    expect(r.foreign).toEqual([{ file: "src/b.ts", task: "T2" }]);
    expect(r.outside).toEqual(["src/stray.ts"]);
    expect(filesOf("HEAD")).toEqual(["src/a.ts"]);
    // The task that lists it commits it later.
    const r2 = commitTask({ worktree: wt, taskId: "T2", text: "y", files: ["src/b.ts"] });
    expect(r2.committed).toEqual(["src/b.ts"]);
    expect(filesOf("HEAD")).toEqual(["src/b.ts"]);
  });

  test("a file the task lists that the worker already staged with other files commits alone", () => {
    write("src/a.ts", "export const a = 2;\n");
    write("src/c.ts", "export const c = 2;\n");
    git(wt, "add", "src/c.ts");
    const r = commitTask({ worktree: wt, taskId: "T1", text: "x", files: ["src/a.ts"] });
    expect(r.outside).toEqual(["src/c.ts"]);
    expect(filesOf("HEAD")).toEqual(["src/a.ts"]);
  });

  test("a deleted file that the task lists is committed as a deletion", () => {
    git(wt, "rm", "-q", "-f", "src/c.ts");
    const r = commitTask({ worktree: wt, taskId: "T1", text: "x", files: ["src/c.ts"] });
    expect(r.committed).toEqual(["src/c.ts"]);
    expect(git(wt, "ls-files", "src/c.ts")).toBe("");
  });

  test("a listed folder (a path that ends with /) covers the changed files under it", () => {
    write("src/new/one.ts", "1\n");
    write("src/new/two.ts", "2\n");
    const r = commitTask({ worktree: wt, taskId: "T1", text: "x", files: ["src/new/"] });
    expect(r.committed).toEqual(["src/new/one.ts", "src/new/two.ts"]);
  });

  test("run files are never committed", () => {
    write("src/a.ts", "export const a = 2;\n");
    write(`${FEATURE}/run/state.json`, "{}\n");
    const r = commitTask({ worktree: wt, taskId: "T1", text: "x", files: ["src/a.ts", `${FEATURE}/run/state.json`] });
    expect(r.committed).toEqual(["src/a.ts"]);
    expect(filesOf("HEAD")).toEqual(["src/a.ts"]);
  });
});

describe("commitPlanFiles", () => {
  test("commits the changed plan files and decision records with 'plan: <slug>', and nothing else", () => {
    write(`${FEATURE}/PLAN.md`, "# Plan 2\n");
    write(`${FEATURE}/SPEC.md`, "# Spec\n");
    write(`${FEATURE}/wireframes/search.html`, "<h1>x</h1>\n");
    write("docs/adr/2026-11-11-second.md", "# Second\n");
    write(`${FEATURE}/run/state.json`, "{}\n");
    write("src/a.ts", "export const a = 2;\n");
    const featureFolder = join(wt, FEATURE);
    const sha = commitPlanFiles({ worktree: wt, featureFolder, slug: "demo" });
    expect(sha).toBe(head());
    expect(subject("HEAD")).toBe("plan: demo");
    expect(filesOf("HEAD")).toEqual([
      "docs/adr/2026-11-11-second.md",
      `${FEATURE}/PLAN.md`,
      `${FEATURE}/SPEC.md`,
      `${FEATURE}/wireframes/search.html`,
    ]);
    expect(changedFiles(wt)).toEqual(["src/a.ts"]);
  });

  test("is null, and makes no commit, when no plan file changed", () => {
    write("src/a.ts", "export const a = 2;\n");
    const before = head();
    expect(commitPlanFiles({ worktree: wt, featureFolder: join(wt, FEATURE), slug: "demo" })).toBeNull();
    expect(head()).toBe(before);
  });

  test("takes a feature folder relative to the worktree, and another adrDir", () => {
    write("decisions/one.md", "# One\n");
    write("docs/adr/ignored.md", "# Ignored\n");
    const sha = commitPlanFiles({ worktree: wt, featureFolder: FEATURE, adrDir: "decisions", slug: "demo" });
    expect(sha).not.toBeNull();
    expect(filesOf("HEAD")).toEqual(["decisions/one.md"]);
  });

  test("does not take a folder that only starts with the same letters", () => {
    write("docs/features/demo-2/SPEC.md", "# Other chat\n");
    expect(commitPlanFiles({ worktree: wt, featureFolder: join(wt, FEATURE), slug: "demo" })).toBeNull();
  });
});

describe("setAside and applyAside", () => {
  const listed = ["src/a.ts", "src/new.ts", "src/c.ts", "src/fresh/x.ts"];

  function edit(): void {
    write("src/a.ts", "export const a = 2;\nexport const more = 3;\n");
    git(wt, "rm", "-q", "-f", "src/c.ts");
    write("src/new.ts", "brand new\n");
    write("src/fresh/x.ts", "fresh\n");
    write("src/b.ts", "export const b = 2; // not this task\n");
  }

  test("C15: saves the listed edits to run/patches and puts the files back as they were", () => {
    edit();
    const featureFolder = join(wt, FEATURE);
    const patch = setAside({ worktree: wt, featureFolder, taskId: "T022", run: 2, files: listed });
    expect(patch).toBe(join(featureFolder, "run", "patches", "T022-2.patch"));
    expect(existsSync(patch as string)).toBe(true);
    const text = readFileSync(patch as string, "utf8");
    expect(text).toContain("src/a.ts");
    expect(text).toContain("brand new");
    // Back as they were:
    expect(read("src/a.ts")).toBe("export const a = 1;\n");
    expect(read("src/c.ts")).toBe("export const c = 1;\n");
    expect(existsSync(join(wt, "src/new.ts"))).toBe(false);
    expect(existsSync(join(wt, "src/fresh"))).toBe(false);
    // Not this task's file: untouched. The patch itself is a run file, so it is not a change.
    expect(read("src/b.ts")).toBe("export const b = 2; // not this task\n");
    expect(changedFiles(wt)).toEqual(["src/b.ts"]);
  });

  test("C15: applyAside puts the edits back", () => {
    edit();
    const patch = setAside({ worktree: wt, featureFolder: join(wt, FEATURE), taskId: "T022", run: 1, files: listed }) as string;
    applyAside({ worktree: wt, patch });
    expect(read("src/a.ts")).toBe("export const a = 2;\nexport const more = 3;\n");
    expect(existsSync(join(wt, "src/c.ts"))).toBe(false);
    expect(read("src/new.ts")).toBe("brand new\n");
    expect(read("src/fresh/x.ts")).toBe("fresh\n");
    expect(changedFiles(wt)).toEqual(["src/a.ts", "src/b.ts", "src/c.ts", "src/fresh/x.ts", "src/new.ts"]);
  });

  test("C15: a staged new file is also saved and removed", () => {
    write("src/new.ts", "staged new\n");
    git(wt, "add", "src/new.ts");
    const patch = setAside({ worktree: wt, featureFolder: join(wt, FEATURE), taskId: "T1", run: 1, files: ["src/new.ts"] }) as string;
    expect(existsSync(join(wt, "src/new.ts"))).toBe(false);
    expect(git(wt, "status", "--porcelain")).toBe("");
    applyAside({ worktree: wt, patch });
    expect(read("src/new.ts")).toBe("staged new\n");
  });

  test("C15: it is null when there was nothing to save, and no patch file is written", () => {
    write("src/b.ts", "export const b = 2;\n");
    const featureFolder = join(wt, FEATURE);
    expect(setAside({ worktree: wt, featureFolder, taskId: "T1", run: 1, files: ["src/a.ts"] })).toBeNull();
    expect(existsSync(join(featureFolder, "run", "patches", "T1-1.patch"))).toBe(false);
  });

  test("C15: a patch that does not apply throws a clear error and changes nothing", () => {
    edit();
    const patch = setAside({ worktree: wt, featureFolder: join(wt, FEATURE), taskId: "T1", run: 1, files: listed }) as string;
    write("src/a.ts", "something else entirely\n");
    expect(() => applyAside({ worktree: wt, patch })).toThrow(/does not apply/);
    expect(read("src/a.ts")).toBe("something else entirely\n");
    expect(existsSync(join(wt, "src/new.ts"))).toBe(false);
  });

  test("a patch file that is not there throws a clear error", () => {
    expect(() => applyAside({ worktree: wt, patch: join(wt, "nope.patch") })).toThrow(/nope\.patch/);
  });
});

describe("headCommit and commitsBetween", () => {
  test("the head is the commit's id; a folder with no repo or no commit gives null", () => {
    expect(headCommit(wt)).toBe(head());
    const bare = tempDir("starship-nogit-");
    try {
      expect(headCommit(bare)).toBeNull();
    } finally {
      drop(bare);
    }
  });

  test("the commits above a base, oldest first; none when the base is the tip; the tip alone when git does not know the base", () => {
    const base = head();
    write("src/a.ts", "export const a = 2;\n");
    git(wt, "commit", "-q", "-am", "one");
    const one = head();
    write("src/b.ts", "export const b = 2;\n");
    git(wt, "commit", "-q", "-am", "two");
    const two = head();
    expect(commitsBetween(wt, base, two)).toEqual([
      { sha: one, subject: "one" },
      { sha: two, subject: "two" },
    ]);
    expect(commitsBetween(wt, two, two)).toEqual([]);
    expect(commitsBetween(wt, "0".repeat(40), two)).toEqual([{ sha: two, subject: "two" }]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { WorktreeError, createWorktree, removeWorktree, runGit, slugify } from "../src/worktree.ts";
import { drop, tempDir } from "./helpers.ts";

let repo: string;
let wts: string;

function git(cwd: string, ...args: string[]): string {
  const r = runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr}`);
  return r.stdout;
}

/** A temp repo on `main` with one commit that holds a feature folder `docs/features/existing/`. */
function makeRepo(): string {
  const dir = tempDir("starship-wt-repo-");
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  mkdirSync(join(dir, "docs", "features", "existing"), { recursive: true });
  writeFileSync(join(dir, "docs", "features", "existing", "SPEC.md"), "# Spec\n");
  writeFileSync(join(dir, "docs", "features", "existing", "PLAN.md"), "# Plan\n");
  writeFileSync(join(dir, "README.md"), "hello\n");
  git(dir, "add", "-A");
  git(dir, "commit", "-q", "-m", "first");
  return dir;
}

const branches = () => git(repo, "branch", "--format=%(refname:short)").split("\n").filter(Boolean);

beforeEach(() => {
  repo = makeRepo();
  wts = join(tempDir("starship-wt-dir-"), "repo");
});
afterEach(() => {
  drop(repo);
  drop(join(wts, ".."));
});

describe("slugify", () => {
  test("keeps a to z, 0 to 9 and dashes, in lowercase", () => {
    expect(slugify("Recipe Search: R-111 & more!")).toBe("recipe-search-r-111-more");
    expect(slugify("  --Hello   World--  ")).toBe("hello-world");
    expect(slugify("Café Menü")).toBe("cafe-menu");
  });

  test("is at most 40 characters and does not end with a dash", () => {
    const s = slugify("a".repeat(39) + " bbbbbbbbbb");
    expect(s.length).toBeLessThanOrEqual(40);
    expect(s.endsWith("-")).toBe(false);
    expect(slugify("x".repeat(100))).toHaveLength(40);
  });

  test("is never empty", () => {
    expect(slugify("")).not.toBe("");
    expect(slugify("!!! ???")).toMatch(/^[a-z0-9-]+$/);
    expect(slugify("日本語")).not.toBe("");
  });
});

describe("createWorktree", () => {
  test("makes the worktree on starship/<slug> from the base branch, with the feature folder and run/", () => {
    git(repo, "checkout", "-q", "-b", "dev");
    writeFileSync(join(repo, "dev-only.txt"), "dev\n");
    git(repo, "add", "-A");
    git(repo, "commit", "-q", "-m", "dev");
    git(repo, "checkout", "-q", "main");

    const r = createWorktree({ repoPath: repo, baseBranch: "dev", slug: "recipes", worktreesDir: wts });
    expect(r.slug).toBe("recipes");
    expect(r.path).toBe(join(wts, "recipes"));
    expect(r.branch).toBe("starship/recipes");
    expect(r.featureFolder).toBe(join(wts, "recipes", "docs", "features", "recipes"));
    expect(existsSync(join(r.path, "dev-only.txt"))).toBe(true);
    expect(git(r.path, "rev-parse", "--abbrev-ref", "HEAD").trim()).toBe("starship/recipes");
    expect(existsSync(join(r.featureFolder, "run"))).toBe(true);
    expect(readdirSync(join(r.featureFolder, "run"))).toEqual([]);
    expect(branches()).toContain("starship/recipes");
  });

  test("uses featureDir for the feature folder", () => {
    const r = createWorktree({ repoPath: repo, baseBranch: "main", slug: "x", worktreesDir: wts, featureDir: "plans" });
    expect(r.featureFolder).toBe(join(r.path, "plans", "x"));
    expect(existsSync(join(r.featureFolder, "run"))).toBe(true);
    expect(readFileSync(excludeOf(r.path), "utf8")).toContain("plans/x/run/\n");
  });

  const excludeOf = (wt: string) => {
    const p = git(wt, "rev-parse", "--path-format=absolute", "--git-path", "info/exclude").trim();
    return p;
  };

  test("adds the run/ line to the exclude file once, and git ignores run files", () => {
    const r = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    const text = readFileSync(excludeOf(r.path), "utf8");
    expect(text.split("\n").filter((l) => l === "docs/features/recipes/run/")).toHaveLength(1);
    writeFileSync(join(r.featureFolder, "run", "state.json"), "{}\n");
    expect(git(r.path, "status", "--porcelain", "--untracked-files=all")).toBe("");
  });

  test("C13: a second chat that asks for the same slug gets -2, then -3", () => {
    const a = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    const b = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    const c = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    expect([a.slug, b.slug, c.slug]).toEqual(["recipes", "recipes-2", "recipes-3"]);
    expect(b.path).toBe(join(wts, "recipes-2"));
    expect(b.branch).toBe("starship/recipes-2");
    expect(b.featureFolder).toBe(join(wts, "recipes-2", "docs", "features", "recipes-2"));
    expect(existsSync(join(b.featureFolder, "run"))).toBe(true);
  });

  test("C13: a branch that is already there, with no folder, also counts as used", () => {
    git(repo, "branch", "starship/recipes");
    const r = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    expect(r.slug).toBe("recipes-2");
  });

  test("C13: a folder that is already there, with no branch, also counts as used", () => {
    mkdirSync(join(wts, "recipes"), { recursive: true });
    const r = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    expect(r.slug).toBe("recipes-2");
    expect(branches()).not.toContain("starship/recipes");
  });

  test("C14: a base branch that does not exist throws git's text and leaves nothing behind", () => {
    let err: unknown;
    try {
      createWorktree({ repoPath: repo, baseBranch: "nope", slug: "recipes", worktreesDir: wts });
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(WorktreeError);
    expect((err as WorktreeError).message).toContain("nope");
    expect(existsSync(join(wts, "recipes"))).toBe(false);
    expect(branches()).toEqual(["main"]);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  test("C14: with adopt the slug is not changed, so a used branch throws and the branch stays", () => {
    git(repo, "branch", "starship/existing");
    expect(() => createWorktree({ repoPath: repo, baseBranch: "main", slug: "existing", worktreesDir: wts, adopt: true })).toThrow(WorktreeError);
    expect(branches()).toContain("starship/existing");
    expect(existsSync(join(wts, "existing"))).toBe(false);
  });

  test("adopt keeps the files of a feature folder on the base branch and adds run/", () => {
    const r = createWorktree({ repoPath: repo, baseBranch: "main", slug: "existing", worktreesDir: wts, adopt: true });
    expect(r.slug).toBe("existing");
    expect(readFileSync(join(r.featureFolder, "SPEC.md"), "utf8")).toBe("# Spec\n");
    expect(readFileSync(join(r.featureFolder, "PLAN.md"), "utf8")).toBe("# Plan\n");
    expect(existsSync(join(r.featureFolder, "run"))).toBe(true);
    expect(readFileSync(excludeOf(r.path), "utf8")).toContain("docs/features/existing/run/\n");
  });

  test("adopt with no such folder on the base branch throws and leaves nothing behind", () => {
    expect(() => createWorktree({ repoPath: repo, baseBranch: "main", slug: "missing", worktreesDir: wts, adopt: true })).toThrow(WorktreeError);
    expect(existsSync(join(wts, "missing"))).toBe(false);
    expect(branches()).toEqual(["main"]);
  });

  test("adopt looks at the base branch, not at the checked-out files", () => {
    // The folder exists in the main checkout only as an untracked file; the base branch has none.
    mkdirSync(join(repo, "docs", "features", "draft"), { recursive: true });
    writeFileSync(join(repo, "docs", "features", "draft", "SPEC.md"), "x\n");
    expect(() => createWorktree({ repoPath: repo, baseBranch: "main", slug: "draft", worktreesDir: wts, adopt: true })).toThrow(WorktreeError);
    expect(branches()).toEqual(["main"]);
  });
});

describe("removeWorktree", () => {
  test("removes the folder and the branch", () => {
    const r = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    writeFileSync(join(r.path, "scratch.txt"), "edits that were not committed\n");
    removeWorktree({ repoPath: repo, path: r.path, branch: r.branch });
    expect(existsSync(r.path)).toBe(false);
    expect(branches()).toEqual(["main"]);
    expect(git(repo, "worktree", "list", "--porcelain").match(/^worktree /gm)).toHaveLength(1);
  });

  test("a slug can be used again after the removal", () => {
    const r = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    removeWorktree({ repoPath: repo, path: r.path, branch: r.branch });
    const again = createWorktree({ repoPath: repo, baseBranch: "main", slug: "recipes", worktreesDir: wts });
    expect(again.slug).toBe("recipes");
  });
});

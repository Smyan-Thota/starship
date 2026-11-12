/**
 * One worktree for each chat, and the feature folder inside it. (ADR one-worktree-per-chat)
 *
 * Every git call of the engine goes through `runGit`: an argv array, an explicit folder, no shell.
 */
import { existsSync, mkdirSync, readFileSync, rmSync, writeFileSync } from "node:fs";
import { dirname, join, resolve } from "node:path";

export interface GitResult {
  code: number;
  stdout: string;
  stderr: string;
  /** The same output as bytes, for a patch that must not change. */
  bytes: Uint8Array;
}

/** The only place that starts git. */
export function runGit(cwd: string, args: string[]): GitResult {
  const p = Bun.spawnSync(["git", ...args], { cwd, stdout: "pipe", stderr: "pipe", stdin: "ignore" });
  return { code: p.exitCode ?? 1, stdout: p.stdout.toString(), stderr: p.stderr.toString(), bytes: new Uint8Array(p.stdout) };
}

/** A git failure. The message is git's own text. */
export class WorktreeError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "WorktreeError";
  }
}

export interface CreateWorktreeOptions {
  repoPath: string;
  baseBranch: string;
  slug: string;
  worktreesDir: string;
  /** Where feature folders live in the repo. Default `docs/features`. */
  featureDir?: string;
  /** Use a feature folder that already exists on `baseBranch`. */
  adopt?: boolean;
}

export interface CreatedWorktree {
  path: string;
  branch: string;
  /** The slug that was used. It differs from the asked one after a clash (`-2`, `-3`, ...). */
  slug: string;
  /** Absolute path of `<worktree>/<featureDir>/<slug>`. */
  featureFolder: string;
}

const gitText = (r: GitResult) => (r.stderr.trim() || r.stdout.trim() || `git exited with ${r.code}`);

/** Lowercase, a to z, 0 to 9 and `-` only, at most 40 characters, never empty. */
export function slugify(title: string): string {
  const s = title
    .normalize("NFKD")
    .replace(/[\u0300-\u036f]/g, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/^-+|-+$/g, "")
    .slice(0, 40)
    .replace(/-+$/g, "");
  return s || "chat";
}

const branchOf = (slug: string) => `starship/${slug}`;
const branchExists = (repo: string, branch: string) => runGit(repo, ["show-ref", "--verify", "--quiet", `refs/heads/${branch}`]).code === 0;

function slashed(p: string): string {
  return p.split("\\").join("/").replace(/^\.\//, "").replace(/\/+$/, "");
}

/** True when `<dir>` exists as a folder on the commit `base`. */
function folderOnBranch(repo: string, base: string, dir: string): boolean {
  const r = runGit(repo, ["ls-tree", `${base}:${dirname(dir) === "." ? "" : dirname(dir)}`]);
  if (r.code !== 0) return false;
  const name = dir.split("/").pop() ?? dir;
  return r.stdout.split("\n").some((l) => l.startsWith("040000 tree ") && l.endsWith(`\t${name}`));
}

export function createWorktree(o: CreateWorktreeOptions): CreatedWorktree {
  const featureDir = slashed(o.featureDir ?? "docs/features");
  const adopt = o.adopt === true;

  let slug = o.slug;
  if (adopt) {
    if (!folderOnBranch(o.repoPath, o.baseBranch, `${featureDir}/${slug}`)) {
      throw new WorktreeError(`The feature folder ${featureDir}/${slug} is not on ${o.baseBranch}.`);
    }
  } else {
    for (let n = 2; existsSync(join(o.worktreesDir, slug)) || branchExists(o.repoPath, branchOf(slug)); n++) {
      slug = `${o.slug}-${n}`;
    }
  }

  const path = join(o.worktreesDir, slug);
  const branch = branchOf(slug);
  const pathExisted = existsSync(path);
  const branchExisted = branchExists(o.repoPath, branch);

  const cleanUp = () => {
    if (!pathExisted) rmSync(path, { recursive: true, force: true });
    runGit(o.repoPath, ["worktree", "prune"]);
    if (!branchExisted && branchExists(o.repoPath, branch)) runGit(o.repoPath, ["branch", "-D", branch]);
  };

  mkdirSync(o.worktreesDir, { recursive: true });
  const add = runGit(o.repoPath, ["worktree", "add", "-b", branch, path, o.baseBranch]);
  if (add.code !== 0) {
    cleanUp();
    throw new WorktreeError(gitText(add));
  }

  try {
    const featureFolder = join(path, featureDir, slug);
    mkdirSync(join(featureFolder, "run"), { recursive: true });
    excludeRunFiles(path, `${featureDir}/${slug}/run/`);
    return { path, branch, slug, featureFolder };
  } catch (e) {
    // The worktree was made by this call, so it goes away with its branch.
    runGit(o.repoPath, ["worktree", "remove", "--force", path]);
    cleanUp();
    throw e instanceof WorktreeError ? e : new WorktreeError(e instanceof Error ? e.message : String(e));
  }
}

/** Adds one line to the repo's `info/exclude`, unless it is there. */
function excludeRunFiles(worktree: string, line: string): void {
  const r = runGit(worktree, ["rev-parse", "--git-path", "info/exclude"]);
  if (r.code !== 0) throw new WorktreeError(gitText(r));
  const file = resolve(worktree, r.stdout.trim());
  mkdirSync(dirname(file), { recursive: true });
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  if (text.split("\n").includes(line)) return;
  writeFileSync(file, `${text}${text === "" || text.endsWith("\n") ? "" : "\n"}${line}\n`);
}

/** Removes the worktree folder, with whatever is uncommitted in it, and its branch. */
export function removeWorktree(o: { repoPath: string; path: string; branch: string }): void {
  const rm = runGit(o.repoPath, ["worktree", "remove", "--force", o.path]);
  if (rm.code !== 0 && existsSync(o.path)) {
    // git does not know the folder (or cannot remove it): take the folder by hand, then forget it.
    rmSync(o.path, { recursive: true, force: true });
  }
  runGit(o.repoPath, ["worktree", "prune"]);
  if (branchExists(o.repoPath, o.branch)) {
    const br = runGit(o.repoPath, ["branch", "-D", o.branch]);
    if (br.code !== 0) throw new WorktreeError(gitText(br));
  }
}

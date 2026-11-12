/**
 * Commits made by the engine inside a chat's worktree. (ADR one-worktree-per-chat)
 *
 * The engine commits a verified task's listed files and the plan files. It never sends a commit
 * anywhere, and it leaves the repo's own signing setting alone.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, rmdirSync, writeFileSync } from "node:fs";
import { dirname, isAbsolute, join, relative, resolve } from "node:path";
import { runGit } from "../worktree.ts";

export interface CommitTaskResult {
  /** The new commit, or null when none of the task's files changed. */
  commit: string | null;
  committed: string[];
  /** Changed files that no task lists. Not committed. (C5) */
  outside: string[];
  /** Changed files that another task lists. Not committed. (C6) */
  foreign: { file: string; task: string }[];
}

function git(cwd: string, args: string[]): string {
  const r = runGit(cwd, args);
  if (r.code !== 0) throw new Error(`git ${args.join(" ")} failed: ${r.stderr.trim() || r.stdout.trim()}`);
  return r.stdout;
}

const slashed = (p: string) => p.split("\\").join("/").replace(/^\.\//, "");

/** A listed path matches itself, and, when it ends with `/`, every file under it. */
function listed(entry: string, file: string): boolean {
  const e = slashed(entry);
  return e === file || (e.endsWith("/") && file.startsWith(e));
}

/** A path as git wants it: relative to the worktree, with `/`. */
function inWorktree(worktree: string, p: string): string {
  return slashed(isAbsolute(p) ? relative(worktree, p) : p).replace(/\/+$/, "");
}

/** Tracked changes (staged or not) and untracked files, as relative paths, sorted. Excluded files do not show. */
export function changedFiles(worktree: string): string[] {
  const out = git(worktree, ["status", "--porcelain=v1", "-z", "--untracked-files=all"]);
  const parts = out.split("\0");
  const files = new Set<string>();
  for (let i = 0; i < parts.length; i++) {
    const entry = parts[i] ?? "";
    if (entry.length < 4) continue;
    files.add(entry.slice(3));
    // A rename or a copy is followed by the old path as its own entry.
    if (entry[0] === "R" || entry[0] === "C" || entry[1] === "R" || entry[1] === "C") {
      const old = parts[++i];
      if (old) files.add(old);
    }
  }
  return [...files].sort();
}

function commitFiles(worktree: string, files: string[], message: string): string {
  const there = files.filter((f) => existsSync(join(worktree, f)));
  const gone = files.filter((f) => !there.includes(f));
  if (there.length > 0) git(worktree, ["add", "-A", "--", ...there]);
  // `add` refuses a path that is gone from the folder and from the index, so a deletion is staged this way.
  if (gone.length > 0) git(worktree, ["rm", "-q", "--cached", "--ignore-unmatch", "--", ...gone]);
  // With paths, only these files go into the commit, even when the worker staged others.
  git(worktree, ["commit", "-q", "-m", message, "--", ...files]);
  return git(worktree, ["rev-parse", "HEAD"]).trim();
}

export function commitTask(o: {
  worktree: string;
  taskId: string;
  text: string;
  files: string[];
  otherTasks?: Record<string, string[]>;
}): CommitTaskResult {
  const changed = changedFiles(o.worktree);
  const committed: string[] = [];
  const outside: string[] = [];
  const foreign: { file: string; task: string }[] = [];
  for (const file of changed) {
    if (o.files.some((e) => listed(e, file))) {
      committed.push(file);
      continue;
    }
    const other = Object.entries(o.otherTasks ?? {}).find(([, list]) => list.some((e) => listed(e, file)));
    if (other) foreign.push({ file, task: other[0] });
    else outside.push(file);
  }
  if (committed.length === 0) return { commit: null, committed, outside, foreign };
  return { commit: commitFiles(o.worktree, committed, `${o.taskId}: ${o.text}`), committed, outside, foreign };
}

/** The commit that the worktree is at, or null when git cannot say (no commit yet, not a repo). */
export function headCommit(worktree: string): string | null {
  const r = runGit(worktree, ["rev-parse", "--verify", "--quiet", "HEAD"]);
  return r.code === 0 ? r.stdout.trim() || null : null;
}

/**
 * The commits that lead to `tip` and not to `base`, oldest first, at most 50. When `base` is not known to git, only `tip` itself.
 * When `base` is not an ancestor of `tip` (the branch was reset), these are the commits that `tip` has since the two paths split.
 */
export function commitsBetween(worktree: string, base: string, tip: string): { sha: string; subject: string }[] {
  const r = runGit(worktree, ["log", "--reverse", "--max-count=50", "--format=%H%x00%s", `${base}..${tip}`]);
  if (r.code !== 0) {
    const one = runGit(worktree, ["log", "-1", "--format=%H%x00%s", tip]);
    return one.code === 0 ? parseLog(one.stdout) : [];
  }
  return parseLog(r.stdout);
}

function parseLog(out: string): { sha: string; subject: string }[] {
  const list: { sha: string; subject: string }[] = [];
  for (const line of out.split("\n")) {
    const [sha, ...rest] = line.split("\0");
    if (sha) list.push({ sha, subject: rest.join("\0") });
  }
  return list;
}

/** Commits the changed plan files: the feature folder except `run/`, and the decision records. */
export function commitPlanFiles(o: { worktree: string; featureFolder: string; adrDir?: string; slug: string }): string | null {
  const folder = inWorktree(o.worktree, o.featureFolder);
  const adr = inWorktree(o.worktree, o.adrDir ?? "docs/adr");
  const files = changedFiles(o.worktree).filter(
    (f) => (f.startsWith(`${folder}/`) && !f.startsWith(`${folder}/run/`)) || f.startsWith(`${adr}/`),
  );
  if (files.length === 0) return null;
  return commitFiles(o.worktree, files, `plan: ${o.slug}`);
}

/** Removes empty folders from `dir` up to, but not including, `stop`. */
function pruneEmpty(dir: string, stop: string): void {
  let d = dir;
  while (d.length > stop.length && d.startsWith(stop) && existsSync(d) && readdirSync(d).length === 0) {
    rmdirSync(d);
    d = dirname(d);
  }
}

/**
 * Saves the task's edits to its listed files as `<featureFolder>/run/patches/<taskId>-<run>.patch`,
 * then puts those files back as they were. Returns the patch path, or null when there was nothing to save.
 */
export function setAside(o: { worktree: string; featureFolder: string; taskId: string; run: number; files: string[] }): string | null {
  const mine = changedFiles(o.worktree).filter((f) => o.files.some((e) => listed(e, f)));
  if (mine.length === 0) return null;

  const inHead = (f: string) => runGit(o.worktree, ["cat-file", "-e", `HEAD:${f}`]).code === 0;
  const old = mine.filter(inHead);
  const fresh = mine.filter((f) => !inHead(f));

  const chunks: Uint8Array[] = [];
  if (old.length > 0) {
    const d = runGit(o.worktree, ["diff", "HEAD", "--binary", "--", ...old]);
    if (d.code !== 0) throw new Error(`git diff failed: ${d.stderr.trim()}`);
    chunks.push(d.bytes);
  }
  for (const f of fresh) {
    // A new file has no old side. `--no-index` makes the diff against /dev/null and exits 1 when it differs.
    const d = runGit(o.worktree, ["diff", "--no-index", "--binary", "--", "/dev/null", f]);
    if (d.code > 1) throw new Error(`git diff failed: ${d.stderr.trim()}`);
    chunks.push(d.bytes);
  }

  const patch = join(resolve(o.worktree, o.featureFolder), "run", "patches", `${o.taskId}-${o.run}.patch`);
  mkdirSync(dirname(patch), { recursive: true });
  writeFileSync(patch, Buffer.concat(chunks));

  if (old.length > 0) git(o.worktree, ["restore", "--source=HEAD", "--staged", "--worktree", "--", ...old]);
  for (const f of fresh) {
    runGit(o.worktree, ["rm", "--cached", "-q", "--ignore-unmatch", "--", f]);
    rmSync(join(o.worktree, f), { force: true });
    pruneEmpty(dirname(join(o.worktree, f)), o.worktree);
  }
  return patch;
}

/** Applies a saved patch to the working files. It changes nothing when the patch does not apply. */
export function applyAside(o: { worktree: string; patch: string }): void {
  if (!existsSync(o.patch)) throw new Error(`The patch file ${o.patch} does not exist.`);
  if (readFileSync(o.patch).length === 0) return;
  const r = runGit(o.worktree, ["apply", "--whitespace=nowarn", o.patch]);
  if (r.code !== 0) {
    throw new Error(`The patch ${o.patch} does not apply: ${r.stderr.trim() || r.stdout.trim()}`);
  }
}

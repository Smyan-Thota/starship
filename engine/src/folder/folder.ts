/**
 * Reading a feature folder: the file list and one file, with nothing read from outside the folder.
 */
import { closeSync, existsSync, lstatSync, openSync, readFileSync, readSync, readdirSync, realpathSync, statSync } from "node:fs";
import { isAbsolute, join, relative, resolve, sep } from "node:path";

export const PLAN_FILES = ["SPEC.md", "PLAN.md", "TASKS.md", "ACCEPTANCE.md", "PROMPTS.md"] as const;
export const MAX_TEXT_BYTES = 1_000_000;
const MAX_DEPTH = 6;

export class FolderMissing extends Error {
  constructor(public root: string) {
    super(`Feature folder missing: ${root}`);
    this.name = "FolderMissing";
  }
}

export class PathRefused extends Error {
  constructor(
    public path: string,
    reason: string,
  ) {
    super(`${path}: ${reason}`);
    this.name = "PathRefused";
  }
}

export interface FileInfo {
  /** Path inside the folder, with forward slashes. */
  path: string;
  /** Run files live under `run/`. Everything else is a plan file. */
  kind: "plan" | "run";
  size: number;
  mtimeMs: number;
  binary: boolean;
  tooLarge: boolean;
  /** An .html file opens in the browser. The window never renders it. */
  html: boolean;
}

function mustExist(root: string): string {
  if (!existsSync(root) || !statSync(root).isDirectory()) throw new FolderMissing(root);
  return realpathSync(root);
}

function inside(realRoot: string, realTarget: string): boolean {
  return realTarget === realRoot || realTarget.startsWith(realRoot + sep);
}

/** The real path of `rel` inside `root`. A path that leaves the folder, also through a symlink, is refused. */
export function resolveInside(root: string, rel: string): string {
  const realRoot = mustExist(root);
  if (!rel || rel.includes("\0")) throw new PathRefused(rel, "not a path");
  if (isAbsolute(rel)) throw new PathRefused(rel, "must be a path inside the feature folder");
  const target = resolve(realRoot, rel);
  if (!inside(realRoot, target)) throw new PathRefused(rel, "leaves the feature folder");
  if (!existsSync(target)) throw new PathRefused(rel, "no such file");
  if (!inside(realRoot, realpathSync(target))) throw new PathRefused(rel, "is a link that leaves the feature folder");
  return target;
}

function looksBinary(file: string, size: number): boolean {
  if (!size) return false;
  const fd = openSync(file, "r");
  try {
    const buf = Buffer.alloc(Math.min(size, 8192));
    const n = readSync(fd, buf, 0, buf.length, 0);
    return buf.subarray(0, n).includes(0);
  } finally {
    closeSync(fd);
  }
}

function info(realRoot: string, file: string): FileInfo {
  const st = statSync(file);
  const path = relative(realRoot, file).split(sep).join("/");
  return {
    path,
    kind: path === "run" || path.startsWith("run/") ? "run" : "plan",
    size: st.size,
    mtimeMs: st.mtimeMs,
    binary: looksBinary(file, st.size),
    tooLarge: st.size > MAX_TEXT_BYTES,
    html: /\.html?$/i.test(path),
  };
}

/** Every file in the folder, plan files first, then by path. Links that leave the folder are left out. */
export function listFiles(root: string): FileInfo[] {
  const realRoot = mustExist(root);
  const out: FileInfo[] = [];
  const walk = (dir: string, depth: number) => {
    if (depth > MAX_DEPTH) return;
    for (const name of readdirSync(dir).sort()) {
      if (name === ".DS_Store") continue;
      const full = join(dir, name);
      const lst = lstatSync(full);
      if (lst.isSymbolicLink()) {
        if (!existsSync(full) || !inside(realRoot, realpathSync(full))) continue;
      }
      const st = statSync(full);
      if (st.isDirectory()) walk(full, depth + 1);
      else if (st.isFile()) out.push(info(realRoot, full));
    }
  };
  walk(realRoot, 0);
  const rank = (f: FileInfo) => {
    const i = (PLAN_FILES as readonly string[]).indexOf(f.path);
    return i >= 0 ? i : f.kind === "plan" ? 50 : 100;
  };
  return out.sort((a, b) => rank(a) - rank(b) || a.path.localeCompare(b.path));
}

/** One file. `text` is null for a binary file and for a file over 1 MB: the window shows its name, kind and size. */
export function readFileSafe(root: string, rel: string): { info: FileInfo; text: string | null } {
  const target = resolveInside(root, rel);
  if (!statSync(target).isFile()) throw new PathRefused(rel, "is not a file");
  const meta = info(realpathSync(root), target);
  if (meta.binary || meta.tooLarge) return { info: meta, text: null };
  return { info: meta, text: readFileSync(target, "utf8") };
}

/** True when the folder has the plan files a build needs. */
export function hasPlan(root: string): boolean {
  if (!existsSync(root)) return false;
  return ["PLAN.md", "TASKS.md", "ACCEPTANCE.md"].every((f) => existsSync(join(root, f)));
}

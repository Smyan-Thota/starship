/**
 * The repos Starship knows. One JSON file per repo under ~/.starship/repos/.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, realpathSync, renameSync, rmSync, statSync, writeFileSync } from "node:fs";
import { basename, join } from "node:path";
import { paths } from "./config.ts";
import type { MapFile, RepoInfo } from "./types.ts";

export interface Repo {
  name: string;
  path: string;
  baseBranch: string;
  /** Where feature folders live, inside the repo. */
  featureDir: string;
  commitPlanFiles: boolean;
  /** Named commands the engine may run as checks. */
  checks: Record<string, { cmd: string; heavy: boolean }>;
  /** A command that contains one of these words is heavy. */
  heavyPatterns: string[];
  /** Pairs of check names that never run together. */
  conflicts: string[][];
  /** What the card runner needs: an address, a login, a seed. */
  review: Record<string, string>;
}

export class RepoError extends Error {
  constructor(
    message: string,
    /** True when the error is "no such repo", so the API answers 404. */
    public notFound = false,
  ) {
    super(message);
    this.name = "RepoError";
  }
}

export const HEAVY = ["tsc", "typecheck", "turbo", "vitest", "jest", "pytest", "playwright", "yarn install", "npm install", "bun install", "pnpm install", "prisma generate", "cargo build", "tauri build", "docker"];

export function git(cwd: string, args: string[]): { ok: boolean; out: string; err: string } {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  return { ok: r.exitCode === 0, out: r.stdout.toString().trim(), err: r.stderr.toString().trim() };
}

export function addRepo(path: string, opts: { name?: string; base?: string } = {}): Repo {
  if (!existsSync(path) || !statSync(path).isDirectory()) throw new RepoError(`${path} is not a folder`);
  const top = git(path, ["rev-parse", "--show-toplevel"]);
  if (!top.ok) throw new RepoError(`${path} is not a git repo`);
  const root = realpathSync(top.out);
  const name = opts.name ?? basename(root);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name)) throw new RepoError(`"${name}" is not a usable repo name`);

  let baseBranch = opts.base ?? "";
  if (!baseBranch) {
    const head = git(root, ["rev-parse", "--abbrev-ref", "HEAD"]);
    if (!head.ok || head.out === "HEAD") throw new RepoError(`${root} is not on a branch. Name one with --base.`);
    baseBranch = head.out;
  } else if (!git(root, ["rev-parse", "--verify", "--quiet", baseBranch]).ok) {
    throw new RepoError(`${root} has no branch "${baseBranch}"`);
  }

  const file = paths.repo(name);
  if (existsSync(file)) {
    const old = readRepo(file);
    if (old.path !== root) throw new RepoError(`the name "${name}" is taken by ${old.path}`);
    const next = { ...old, baseBranch };
    writeFileSync(file, JSON.stringify(next, null, 2) + "\n");
    return next;
  }
  const repo: Repo = { name, path: root, baseBranch, featureDir: "docs/features", commitPlanFiles: true, checks: {}, heavyPatterns: HEAVY, conflicts: [], review: {} };
  mkdirSync(paths.repos(), { recursive: true });
  writeFileSync(file, JSON.stringify(repo, null, 2) + "\n");
  return repo;
}

function readRepo(file: string): Repo {
  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new RepoError(`${file}: not valid JSON (${(e as Error).message})`);
  }
  const r = raw as Partial<Repo>;
  if (typeof r.name !== "string" || typeof r.path !== "string" || typeof r.baseBranch !== "string") throw new RepoError(`${file}: needs "name", "path" and "baseBranch"`);
  return {
    name: r.name,
    path: r.path,
    baseBranch: r.baseBranch,
    featureDir: typeof r.featureDir === "string" ? r.featureDir : "docs/features",
    commitPlanFiles: r.commitPlanFiles !== false,
    checks: r.checks ?? {},
    heavyPatterns: Array.isArray(r.heavyPatterns) ? r.heavyPatterns : HEAVY,
    conflicts: Array.isArray(r.conflicts) ? r.conflicts : [],
    review: r.review ?? {},
  };
}

export function listRepos(): Repo[] {
  if (!existsSync(paths.repos())) return [];
  return readdirSync(paths.repos())
    .filter((f) => f.endsWith(".json") && !f.endsWith(".map.json"))
    .sort()
    .map((f) => readRepo(join(paths.repos(), f)));
}

export function getRepo(name: string): Repo {
  const file = paths.repo(name);
  if (!/^[A-Za-z0-9][A-Za-z0-9._-]*$/.test(name) || !existsSync(file)) throw new RepoError(`no repo "${name}"`, true);
  return readRepo(file);
}

export function mapFile(name: string): string {
  return join(paths.repos(), `${name}.map.json`);
}

/** Writes the repo's map to `<home>/repos/<name>.map.json`: a temp file, then a rename. */
export function saveMap(name: string, map: MapFile): string {
  const file = mapFile(name);
  mkdirSync(paths.repos(), { recursive: true });
  const tmp = `${file}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return file;
}

export function repoInfo(r: Repo): RepoInfo {
  return { name: r.name, path: r.path, baseBranch: r.baseBranch, hasMap: existsSync(mapFile(r.name)) };
}

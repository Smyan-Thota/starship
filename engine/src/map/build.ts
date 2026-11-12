/**
 * Getting a map for a repo: import a map file the owner has, or build a low detail one from the repo's
 * top-level folders and the first heading of its README. A repo with a `.codegraph` folder has a code index.
 */
import { existsSync, mkdirSync, readFileSync, readdirSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { type MapBox, type MapFile, readMapFile, validateMap } from "./schema.ts";

/** Thrown when a map file is refused. `errors` is the list, one plain line each. */
export class MapImportError extends Error {
  readonly errors: string[];
  constructor(errors: string[]) {
    super(`map refused:\n${errors.map((e) => `- ${e}`).join("\n")}`);
    this.name = "MapImportError";
    this.errors = errors;
  }
}

const SAFE_NAME = /^[A-Za-z0-9][A-Za-z0-9._-]*$/;

/** Checks the file and copies it to `<reposDir>/<name>.map.json`. A file with errors is refused with the list. */
export function importMap(o: { file: string; reposDir: string; name: string }): { path: string } {
  if (!SAFE_NAME.test(o.name)) throw new MapImportError([`the repo name "${o.name}" must be letters, digits, dot, dash or underscore`]);
  const { map, errors } = readMapFile(o.file);
  if (map === null) throw new MapImportError(errors);
  mkdirSync(o.reposDir, { recursive: true });
  const path = join(o.reposDir, `${o.name}.map.json`);
  const tmp = `${path}.${process.pid}.tmp`;
  try {
    writeFileSync(tmp, `${JSON.stringify(map, null, 2)}\n`);
    renameSync(tmp, path);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return { path };
}

const SKIP = new Set(["node_modules", "dist", "build", "target"]);

function topFolders(repoPath: string): string[] {
  return readdirSync(repoPath, { withFileTypes: true })
    .filter((d) => d.isDirectory() && !d.name.startsWith(".") && !SKIP.has(d.name))
    .map((d) => d.name)
    .sort((a, b) => a.localeCompare(b));
}

/** The text of the first Markdown heading of the repo's README, or null. */
function readmeHeading(repoPath: string): string | null {
  const file = readdirSync(repoPath).find((f) => /^readme(\.(md|markdown|txt))?$/i.test(f));
  if (file === undefined) return null;
  let text: string;
  try {
    text = readFileSync(join(repoPath, file), "utf8");
  } catch {
    return null;
  }
  for (const line of text.split("\n")) {
    const m = /^#{1,6}\s+(.+?)\s*#*\s*$/.exec(line);
    if (m?.[1]) return m[1];
  }
  return null;
}

const PER_ROW = 3;

/** I2: a map made only from the top-level folders and the first heading of the README. */
export function buildLowDetailMap(o: { repoPath: string; name: string }): MapFile {
  const heading = readmeHeading(o.repoPath);
  const folders = topFolders(o.repoPath);
  const boxes: MapBox[] = folders.map((dir, i) => {
    const row = Math.floor(i / PER_ROW);
    const inRow = Math.min(PER_ROW, folders.length - row * PER_ROW);
    const col = i % PER_ROW;
    const width = 0.92 / inRow;
    const left = 0.04 + col * width;
    return { id: dir, layer: 0, row, left: round(left), right: round(left + width - 0.02), name: dir, what: "", dir, chips: [] };
  });
  const map: MapFile = {
    name: o.name,
    layers: [["Folders", heading ?? "the top-level folders"]],
    boxes,
    pipes: [],
    flows: { over: heading === null ? { name: "Overview" } : { name: "Overview", story: heading } },
    order: ["over"],
    detail: "low",
  };
  // Folder names are unique in one folder, so the map is valid. The check guards a future change.
  if (validateMap(map).length > 0) throw new MapImportError(validateMap(map));
  return map;
}

const round = (n: number) => Math.round(n * 1000) / 1000;

/** True when the repo has a CodeGraph index. */
export function hasCodeIndex(repoPath: string): boolean {
  return existsSync(join(repoPath, ".codegraph"));
}

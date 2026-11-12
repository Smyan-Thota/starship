/**
 * Watching a feature folder, safe writes to run files, and hand edits to plan files.
 */
import { createHash } from "node:crypto";
import { type FSWatcher, existsSync, readFileSync, watch } from "node:fs";
import { join, sep } from "node:path";
import { listFiles } from "./folder/folder.ts";

export { writeRunFile } from "./folder/write.ts";

export const DEBOUNCE_MS = 80;

/** Reports changed paths, relative to the root with forward slashes, at most once per 80 ms burst. */
export class FolderWatcher {
  private watcher: FSWatcher | null;
  private timer: ReturnType<typeof setTimeout> | null = null;
  private pending = new Set<string>();
  private closed = false;

  constructor(
    public readonly root: string,
    private onChange: (paths: string[]) => void,
    private onError: (e: Error) => void = () => {},
  ) {
    this.watcher = watch(root, { recursive: true }, (_event, filename) => this.add(filename ? String(filename) : "."));
    this.watcher.on("error", (e) => {
      if (!this.closed) this.onError(e as Error);
    });
  }

  private add(name: string) {
    if (this.closed) return;
    this.pending.add(name.split(sep).join("/"));
    if (this.timer) clearTimeout(this.timer);
    this.timer = setTimeout(() => {
      this.timer = null;
      if (this.closed) return;
      const paths = [...this.pending].sort();
      this.pending.clear();
      this.onChange(paths);
    }, DEBOUNCE_MS);
  }

  close(): void {
    this.closed = true;
    if (this.timer) clearTimeout(this.timer);
    this.timer = null;
    this.pending.clear();
    this.watcher?.close();
    this.watcher = null;
  }
}

function hashOf(file: string): string | null {
  if (!existsSync(file)) return null;
  try {
    return createHash("sha256").update(readFileSync(file)).digest("hex");
  } catch {
    return null;
  }
}

function isRun(rel: string): boolean {
  return rel === "run" || rel.startsWith("run/");
}

/**
 * Hand edits to plan files (edge C1). The snapshot holds the hash of every plan file. A file the engine or an
 * agent turn legitimately wrote or read is marked seen. Any other difference is a hand edit. Run files never count.
 */
export class PlanWatch {
  private seen = new Map<string, string | null>();

  constructor(public readonly root: string) {
    for (const [rel, hash] of this.current()) this.seen.set(rel, hash);
  }

  private current(): Map<string, string | null> {
    const out = new Map<string, string | null>();
    if (!existsSync(this.root)) return out;
    let files: ReturnType<typeof listFiles>;
    try {
      files = listFiles(this.root);
    } catch {
      return out;
    }
    for (const f of files) if (f.kind === "plan") out.set(f.path, hashOf(join(this.root, f.path)));
    return out;
  }

  /** The engine or an agent turn wrote or read this file: its content now is the known content. */
  markSeen(rel: string): void {
    const path = rel.split(sep).join("/").replace(/^\.\//, "");
    if (isRun(path)) return;
    const hash = hashOf(join(this.root, path));
    if (hash === null) this.seen.delete(path);
    else this.seen.set(path, hash);
  }

  /** Plan files whose content differs from the known content: changed, added or removed. Sorted. */
  handEdits(): string[] {
    const now = this.current();
    const out = new Set<string>();
    for (const [rel, hash] of now) if (this.seen.get(rel) !== hash) out.add(rel);
    for (const rel of this.seen.keys()) if (!now.has(rel)) out.add(rel);
    return [...out].sort();
  }
}

const TASK_LINE = /^\s*- \[(?: |x|X)\] (T\d{3}[A-Za-z]?)\b(.*)$/;

function taskLines(text: string): Map<string, string> {
  const out = new Map<string, string>();
  for (const raw of text.split("\n")) {
    const m = raw.replace(/\r$/, "").match(TASK_LINE);
    if (!m) continue;
    const id = m[1] ?? "";
    const body = (m[2] ?? "").trimEnd();
    out.set(id, out.has(id) ? `${out.get(id)}\n${body}` : body);
  }
  return out;
}

/** Ids of tasks whose line text changed, were added, or were removed. A change of only the checkbox does not count (edge C3). */
export function changedTaskIds(oldText: string, newText: string): string[] {
  const a = taskLines(oldText);
  const b = taskLines(newText);
  const out: string[] = [];
  for (const [id, body] of b) if (a.get(id) !== body) out.push(id);
  for (const id of a.keys()) if (!b.has(id)) out.push(id);
  return out;
}

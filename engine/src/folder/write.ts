/**
 * The one way the engine writes a run file: read it from disk at that moment, change it, write a temp file
 * in the same folder, and rename it over the old one. It never writes from a cached copy, so a hand edit
 * made before the write stays (edge C16).
 */
import { existsSync, mkdirSync, readFileSync, renameSync, rmSync, writeFileSync } from "node:fs";
import { basename, dirname, join } from "node:path";

export function writeRunFile(file: string, change: (text: string) => string): string {
  const text = existsSync(file) ? readFileSync(file, "utf8") : "";
  const next = change(text);
  const dir = dirname(file);
  mkdirSync(dir, { recursive: true });
  const tmp = join(dir, `.${basename(file)}.${process.pid}.${Math.random().toString(36).slice(2)}.tmp`);
  try {
    writeFileSync(tmp, next);
    renameSync(tmp, file);
  } catch (e) {
    rmSync(tmp, { force: true });
    throw e;
  }
  return next;
}

/**
 * The fix list, run/review/fixes.md:
 *
 *   - X{n} {text} — from {F{n}|Note {n}}
 *
 * One fix for each finding that is `open` or `accepted`, then one for each note with the target `fixes`
 * that is not `undone`. A fix keeps its number when the list is built again, and a number is never
 * used for another fix. `sendFixes` adds one phase "Fixes" to TASKS.md for the fixes not sent yet.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import type { Finding } from "../folder/findings.ts";
import type { Note } from "../folder/notes.ts";
import { addPhase, parseTasks, serialize } from "../folder/tasks.ts";
import { writeRunFile } from "../folder/write.ts";

export interface Fix {
  n: number;
  text: string;
  /** `F<n>` or `Note <n>`. */
  from: string;
}

export interface FixProblem {
  line: number;
  text: string;
}

export class FixesError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FixesError";
  }
}

export function fixesPath(dir: string): string {
  return join(dir, "run", "review", "fixes.md");
}

function flat(s: string): string {
  return s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" ");
}

/** The list, in number order. `old` is the list built before: its numbers are reused, matched by `from`. */
export function fixList(findings: Finding[], notes: Note[], old: Fix[] = []): Fix[] {
  const wanted: { from: string; text: string }[] = [
    ...findings.filter((f) => f.status === "open" || f.status === "accepted").sort((a, b) => a.n - b.n).map((f) => ({ from: `F${f.n}`, text: `${flat(f.text)} (${f.where})` })),
    ...notes.filter((n) => n.to === "fixes" && n.status !== "undone").sort((a, b) => a.n - b.n).map((n) => ({ from: `Note ${n.n}`, text: flat(n.note) })),
  ];
  const before = new Map(old.map((f) => [f.from, f.n]));
  let next = Math.max(0, ...old.map((f) => f.n)) + 1;
  const out: Fix[] = [];
  const taken = new Set<number>();
  for (const w of wanted) {
    const kept = before.get(w.from);
    if (kept !== undefined && !taken.has(kept)) {
      taken.add(kept);
      out.push({ n: kept, ...w });
    }
  }
  for (const w of wanted) {
    if (out.some((f) => f.from === w.from)) continue;
    out.push({ n: next++, ...w });
  }
  return out.sort((a, b) => a.n - b.n);
}

function fixLine(f: Fix): string {
  const text = flat(f.text);
  if (!text) throw new FixesError(`fix X${f.n} needs text`);
  if (!Number.isInteger(f.n) || f.n < 1) throw new FixesError(`bad fix number: ${f.n}`);
  if (!/^(F\d+|Note \d+)$/.test(f.from)) throw new FixesError(`bad source: ${f.from}`);
  return `- X${f.n} ${text} — from ${f.from}`;
}

export function writeFixes(dir: string, fixes: Fix[]): void {
  const lines = fixes.map(fixLine);
  writeRunFile(fixesPath(dir), () => "# Fixes\n" + (lines.length ? "\n" + lines.join("\n") + "\n" : ""));
}

const SOURCE = " — from ";
const LINE = /^- X(\d+) (.+)$/;

export function readFixes(dir: string): { fixes: Fix[]; problems: FixProblem[] } {
  const file = fixesPath(dir);
  const lines = (existsSync(file) ? readFileSync(file, "utf8") : "").split("\n").map((l) => l.replace(/\r$/, ""));
  const fixes: Fix[] = [];
  const problems: FixProblem[] = [];
  lines.forEach((s, i) => {
    if (!s.startsWith("- ")) return;
    const bad = (reason: string) => problems.push({ line: i + 1, text: `${s} — ${reason}` });
    const m = s.match(LINE);
    const cut = m ? (m[2] ?? "").lastIndexOf(SOURCE) : -1;
    const from = m && cut >= 0 ? (m[2] ?? "").slice(cut + SOURCE.length).trim() : "";
    const text = m && cut >= 0 ? (m[2] ?? "").slice(0, cut).trim() : "";
    if (!m || !text || !/^(F\d+|Note \d+)$/.test(from)) {
      bad("a fix line must be '- X{n} {text} — from F{n}|Note {n}'");
      return;
    }
    const n = Number(m[1]);
    if (fixes.some((f) => f.n === n)) {
      bad(`fix number ${n} is used twice`);
      return;
    }
    fixes.push({ n, text, from });
  });
  return { fixes, problems };
}

/**
 * Adds one phase "Fixes" to `<dir>/TASKS.md` for the fixes whose number is above `lastSent` (edge H3: sent twice, added once).
 * It is refused while a finding is `disputed`. The phase holds no task: the orchestrator writes one task for
 * each fix with `starship task add`, and it picks the files and the verify command.
 */
export function sendFixes(o: { dir: string; findings: Finding[]; fixes: Fix[]; lastSent: number }): { phase: number | null; sent: Fix[]; lastSent: number } {
  const disputed = o.findings.filter((f) => f.status === "disputed").map((f) => `F${f.n}`);
  if (disputed.length) throw new FixesError(`the fix list is not sent while a finding is disputed: ${disputed.join(", ")}`);
  const sent = o.fixes.filter((f) => f.n > o.lastSent).sort((a, b) => a.n - b.n);
  if (!sent.length) return { phase: null, sent: [], lastSent: o.lastSent };

  let phase = 0;
  writeRunFile(join(o.dir, "TASKS.md"), (text) => {
    const doc = parseTasks(text);
    // addPhase wants one task. Give it one, then take that line out again: the phase header stays.
    const withTask = addPhase(doc, "Fixes", [{ text: "placeholder", files: ["x"], verify: null, verifyNote: "placeholder" }]);
    const added = withTask.phases[withTask.phases.length - 1];
    const task = added?.tasks[0];
    if (!added || !task) throw new FixesError("the new phase did not parse");
    const lines = withTask.lines.slice();
    lines.splice(task.line - 1, 1);
    const h = added.line - 1;
    let j = h + 1;
    while (j < lines.length && (lines[j] ?? "") === "") j++;
    const endsWithNewline = doc.lines[doc.lines.length - 1] === "";
    lines.splice(h + 1, j - h - 1, ...(j < lines.length ? [""] : endsWithNewline ? [""] : []));
    const out = lines.join("\n");
    phase = added.n;
    return serialize(parseTasks(out, doc.file));
  });
  return { phase, sent, lastSent: Math.max(o.lastSent, ...sent.map((f) => f.n)) };
}

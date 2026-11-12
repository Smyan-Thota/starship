/**
 * run/review/findings.md: the problems the reviewers report, with a file and a line.
 *
 *   ## F3 · high · codex · engine/src/a.ts:12
 *   {text}
 *   Status: {open|disputed|accepted|rejected}
 *   Dispute: {reviewer}: {why}
 *   Decision: {why}            (only when the owner gave a reason; PLAN's format has no field for it)
 *
 *   ## No findings · claude    (a reviewer that found nothing, edge H1)
 *
 * The engine is the only writer. Every write reads the file again, changes only the lines it needs,
 * and renames a temp file over the old one. An entry it cannot read is reported with its line,
 * skipped, and left as it is.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeRunFile } from "./write.ts";

export type FindingStatus = "open" | "disputed" | "accepted" | "rejected";
export type Severity = "high" | "medium" | "low";

export interface Finding {
  n: number;
  sev: Severity;
  reviewer: string;
  /** file:line */
  where: string;
  text: string;
  status: FindingStatus;
  dispute: { reviewer: string; why: string } | null;
}

export interface FindingProblem {
  /** 1-based line of the entry's heading. */
  line: number;
  text: string;
}

export interface FindingsDoc {
  findings: Finding[];
  /** Reviewers that reported no finding. */
  none: string[];
  problems: FindingProblem[];
}

export class FindingError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "FindingError";
  }
}

export function findingsPath(dir: string): string {
  return join(dir, "run", "review", "findings.md");
}

const TITLE = "# Findings";
const HEAD = /^## F(\d+) · (high|medium|low) · ([^·]+?) · (.+:\d+)$/;
const NONE = /^## No findings · (.+)$/;
const LOOSE = /^## (F\d+\b|No findings\b)/;
const STATUS = /^Status: (open|disputed|accepted|rejected)$/;
const SEVERITIES = ["high", "medium", "low"];

interface Block {
  start: number;
  end: number;
}

function blocks(lines: string[]): Block[] {
  const out: Block[] = [];
  let open: Block | undefined;
  for (let i = 0; i < lines.length; i++) {
    const s = lines[i] ?? "";
    if (s.startsWith("## ") || s.startsWith("# ")) {
      if (open) {
        open.end = i;
        out.push(open);
        open = undefined;
      }
      if (LOOSE.test(s)) open = { start: i, end: lines.length };
    }
  }
  if (open) out.push(open);
  return out;
}

function lineOf(lines: string[], b: Block, key: string): number {
  for (let i = b.start + 1; i < b.end; i++) {
    const s = lines[i] ?? "";
    if (s.startsWith(key + ": ") || s === key + ":") return i;
  }
  return -1;
}

export function parseFindings(text: string): FindingsDoc {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const findings: Finding[] = [];
  const none: string[] = [];
  const problems: FindingProblem[] = [];

  for (const b of blocks(lines)) {
    const heading = lines[b.start] ?? "";
    const bad = (reason: string) => problems.push({ line: b.start + 1, text: `${heading} — ${reason}` });

    const nm = heading.match(NONE);
    if (nm) {
      const who = (nm[1] ?? "").trim();
      if (!who) bad("the reviewer is missing");
      else if (!none.includes(who)) none.push(who);
      continue;
    }
    if (heading.startsWith("## No findings")) {
      bad("the heading is not '## No findings · reviewer'");
      continue;
    }
    const m = heading.match(HEAD);
    if (!m) {
      bad("the heading is not '## F{n} · high|medium|low · reviewer · file:line'");
      continue;
    }
    const n = Number(m[1]);
    if (findings.some((x) => x.n === n)) {
      bad(`finding number ${n} is used twice`);
      continue;
    }
    const st = lineOf(lines, b, "Status");
    const status = st < 0 ? null : (lines[st] ?? "").match(STATUS);
    if (!status) {
      bad("the 'Status:' line must be open, disputed, accepted or rejected");
      continue;
    }
    const body = lines
      .slice(b.start + 1, st)
      .join("\n")
      .trim();
    if (!body) {
      bad("the finding has no text");
      continue;
    }
    let dispute: Finding["dispute"] = null;
    const d = lineOf(lines, b, "Dispute");
    if (d >= 0) {
      const raw = (lines[d] ?? "").slice("Dispute:".length).trim();
      const cut = raw.indexOf(": ");
      const who = cut > 0 ? raw.slice(0, cut).trim() : "";
      const why = cut > 0 ? raw.slice(cut + 2).trim() : "";
      if (!who || !why) {
        bad("the 'Dispute:' line must be 'Dispute: reviewer: why'");
        continue;
      }
      dispute = { reviewer: who, why };
    }
    const word = status[1] as FindingStatus;
    if (word === "disputed" && !dispute) {
      bad("the finding is disputed but has no 'Dispute:' line");
      continue;
    }
    findings.push({ n, sev: m[2] as Severity, reviewer: (m[3] ?? "").trim(), where: m[4] ?? "", text: body, status: word, dispute });
  }
  return { findings, none, problems };
}

/** The canonical text of a parsed file. A `Decision:` line is not part of the type, so it is not written. */
export function serializeFindings(doc: { findings: Finding[]; none: string[] }): string {
  let out = TITLE + "\n";
  for (const f of doc.findings) {
    out += `\n## F${f.n} · ${f.sev} · ${f.reviewer} · ${f.where}\n${f.text}\nStatus: ${f.status}\n`;
    if (f.dispute) out += `Dispute: ${f.dispute.reviewer}: ${f.dispute.why}\n`;
  }
  for (const r of doc.none) out += `\n## No findings · ${r}\n`;
  return out;
}

export function readFindings(dir: string): FindingsDoc {
  const file = findingsPath(dir);
  return parseFindings(existsSync(file) ? readFileSync(file, "utf8") : "");
}

function flat(s: string): string {
  return s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" ");
}

function reviewerName(s: string): string {
  const name = flat(s);
  if (!name) throw new FindingError("a reviewer needs a name");
  if (name.includes("·") || name.includes(":")) throw new FindingError(`the reviewer name must not contain '·' or ':': ${name}`);
  return name;
}

/** The highest number in the file, counting entries that cannot be read, so a number is never used twice. */
function highest(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/^## F(\d+)\b/gm)) max = Math.max(max, Number(m[1]));
  return max;
}

function withFinding(text: string, n: number): { lines: string[]; finding: Finding; block: Block } {
  const doc = parseFindings(text);
  const finding = doc.findings.find((f) => f.n === n);
  if (!finding) throw new FindingError(`no finding ${n}`);
  const lines = text.split("\n");
  const clean = lines.map((l) => l.replace(/\r$/, ""));
  const block = blocks(clean).find((b) => (clean[b.start] ?? "").startsWith(`## F${n} · `) && parseFindings(clean.slice(b.start, b.end).join("\n")).findings.some((f) => f.n === n));
  if (!block) throw new FindingError(`no finding ${n}`);
  return { lines, finding, block };
}

/** Adds one finding at the end, with the status `open`. */
export function addFinding(dir: string, f: { sev: Severity; reviewer: string; where: string; text: string }): Finding {
  if (!SEVERITIES.includes(f.sev)) throw new FindingError(`the severity must be high, medium or low: ${String(f.sev)}`);
  const reviewer = reviewerName(f.reviewer);
  const where = f.where.trim();
  if (!/^[^\s·][^\n·]*:\d+$/.test(where)) throw new FindingError(`where must look like file:line: ${f.where}`);
  const text = flat(f.text);
  if (!text) throw new FindingError("a finding needs text");
  if (/^(#|Status:|Dispute:|Decision:)/.test(text)) throw new FindingError("the text must not start with '#', 'Status:', 'Dispute:' or 'Decision:'");

  let made: Finding | undefined;
  writeRunFile(findingsPath(dir), (old) => {
    let lines = old.split("\n");
    // A reviewer that adds a finding no longer "found nothing": its line comes out, with the blank line before it.
    for (const b of blocks(lines.map((l) => l.replace(/\r$/, ""))).reverse()) {
      const m = (lines[b.start] ?? "").replace(/\r$/, "").match(NONE);
      if (!m || (m[1] ?? "").trim() !== reviewer) continue;
      let from = b.start;
      if (from > 0 && (lines[from - 1] ?? "") === "") from--;
      lines = [...lines.slice(0, from), ...lines.slice(b.end)];
    }
    let base = lines.join("\n");
    const n = highest(base) + 1;
    if (!base.trim()) base = TITLE + "\n";
    if (!base.endsWith("\n")) base += "\n";
    const out = `${base}\n## F${n} · ${f.sev} · ${reviewer} · ${where}\n${text}\nStatus: open\n`;
    made = parseFindings(out).findings.find((x) => x.n === n);
    if (!made) throw new FindingError("the new finding did not parse");
    return out;
  });
  if (!made) throw new FindingError("the new finding did not parse");
  return made;
}

/** A reviewer other than the finding's own disagrees: an `open` finding becomes `disputed` (edge H4). */
export function disputeFinding(dir: string, n: number, reviewer: string, why: string): Finding {
  const who = reviewerName(reviewer);
  const reason = flat(why);
  if (!reason) throw new FindingError("a dispute needs a why");
  let made: Finding | undefined;
  writeRunFile(findingsPath(dir), (old) => {
    const { lines, finding, block } = withFinding(old, n);
    if (finding.reviewer.toLowerCase() === who.toLowerCase()) throw new FindingError(`reviewer ${who} cannot dispute its own finding ${n}`);
    if (finding.status !== "open") throw new FindingError(`finding ${n} is already ${finding.status}`);
    const clean = lines.map((l) => l.replace(/\r$/, ""));
    const st = lineOf(clean, block, "Status");
    lines.splice(st, 1, "Status: disputed", `Dispute: ${who}: ${reason}`);
    const out = lines.join("\n");
    made = parseFindings(out).findings.find((x) => x.n === n);
    return out;
  });
  if (!made) throw new FindingError(`finding ${n} did not parse after the dispute`);
  return made;
}

/** The owner's decision, for any finding. A reason is kept on a `Decision:` line. */
export function decideFinding(dir: string, n: number, decision: "accepted" | "rejected", why?: string): Finding {
  if (decision !== "accepted" && decision !== "rejected") throw new FindingError(`the decision must be accepted or rejected: ${String(decision)}`);
  const reason = why === undefined ? "" : flat(why);
  let made: Finding | undefined;
  writeRunFile(findingsPath(dir), (old) => {
    const { lines, block } = withFinding(old, n);
    const clean = lines.map((l) => l.replace(/\r$/, ""));
    const st = lineOf(clean, block, "Status");
    lines[st] = `Status: ${decision}`;
    // Drop an older decision line, then write the new one after the dispute line, or after the status line.
    const dec = lineOf(clean, block, "Decision");
    if (dec >= 0) lines.splice(dec, 1);
    if (reason) {
      const d = lineOf(clean, block, "Dispute");
      const at = d >= 0 ? d : st;
      lines.splice(at - (dec >= 0 && dec < at ? 1 : 0) + 1, 0, `Decision: ${reason}`);
    }
    const out = lines.join("\n");
    made = parseFindings(out).findings.find((x) => x.n === n);
    return out;
  });
  if (!made) throw new FindingError(`finding ${n} did not parse after the decision`);
  return made;
}

/** Edge H1: a reviewer that finds nothing is recorded in the file, so the file says so. */
export function markNoFindings(dir: string, reviewer: string): void {
  const who = reviewerName(reviewer);
  writeRunFile(findingsPath(dir), (old) => {
    const doc = parseFindings(old);
    if (doc.findings.some((f) => f.reviewer.toLowerCase() === who.toLowerCase())) throw new FindingError(`reviewer ${who} has a finding, so it did not find nothing`);
    if (doc.none.includes(who)) return old;
    let base = old.trim() ? old : TITLE + "\n";
    if (!base.endsWith("\n")) base += "\n";
    return `${base}\n## No findings · ${who}\n`;
  });
}

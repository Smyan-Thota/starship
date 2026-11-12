/**
 * The plan validator: the one gate for "Start build" (PLAN.md, "Chats, repos and stages").
 *
 * It reads the plan files of one feature folder and reports what is wrong, in plain lines.
 * It never throws for a bad plan. An empty list means the plan is valid.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { ParseError, allTasks, parseTasks } from "./tasks.ts";

export interface PlanProblem {
  /** Relative to the feature folder, such as `PLAN.md`. */
  file: string;
  /** 1-based line, or null when the problem is about the whole file. */
  line: number | null;
  code: string;
  /** One short plain line the owner can read. */
  text: string;
}

const REQUIRED_FILES = ["SPEC.md", "PLAN.md", "TASKS.md", "ACCEPTANCE.md"] as const;
const PLAN_MD_FILES = ["SPEC.md", "PLAN.md", "TASKS.md", "ACCEPTANCE.md", "PROMPTS.md"] as const;

/** Headings each file needs. Derived from docs/templates/ and the real SPEC. Matched at the start of the heading. */
const REQUIRED_HEADINGS: Record<string, { label: string; start: RegExp }[]> = {
  "SPEC.md": [
    { label: "problem", start: /^problem\b/ },
    { label: "scope", start: /^scope\b/ },
  ],
  "PLAN.md": [
    { label: "goal", start: /^goal\b/ },
    { label: "in scope", start: /^in scope\b/ },
    { label: "out of scope", start: /^out of scope\b/ },
  ],
};

/** The staff checklist: a word inside any heading of PLAN.md. */
const STAFF_CHECKLIST: { label: string; word: RegExp }[] = [
  { label: "data", word: /\bdata\b/ },
  { label: "API or interfaces", word: /\b(api|apis|interfaces?)\b/ },
  { label: "errors", word: /\berrors?\b/ },
  { label: "edge cases", word: /\bedge\b/ },
  { label: "tests", word: /\btests?\b/ },
  { label: "rollout", word: /\brollout\b/ },
];

interface Heading {
  level: number;
  text: string;
  line: number;
}

function readText(file: string): string | null {
  try {
    return readFileSync(file, "utf8");
  } catch {
    return null;
  }
}

/** Every Markdown heading outside a code fence. */
function headings(text: string): Heading[] {
  const out: Heading[] = [];
  let fence: string | null = null;
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) {
    const s = (lines[i] ?? "").replace(/\r$/, "");
    const f = s.match(/^\s*(```+|~~~+)/);
    if (f) {
      const mark = (f[1] ?? "").slice(0, 3);
      if (fence === null) fence = mark;
      else if (fence === mark) fence = null;
      continue;
    }
    if (fence !== null) continue;
    const h = s.match(/^(#{1,6})\s+(.+?)\s*#*\s*$/);
    if (h) out.push({ level: (h[1] ?? "").length, text: (h[2] ?? "").trim().toLowerCase(), line: i + 1 });
  }
  return out;
}

const ITEM = /^\s*(?:[-*+]|\d+[.)])\s+\S/;

function hasCheckItem(text: string): boolean {
  let fence = false;
  for (const raw of text.split("\n")) {
    if (/^\s*(```|~~~)/.test(raw)) {
      fence = !fence;
      continue;
    }
    if (!fence && ITEM.test(raw)) return true;
  }
  return false;
}

/** The numbered items under the "In scope" heading of PLAN.md: number and line. */
function inScopeItems(text: string): { n: number; line: number }[] {
  const hs = headings(text);
  const at = hs.findIndex((h) => /^in scope\b/.test(h.text));
  const start = hs[at];
  if (!start) return [];
  const end = hs.slice(at + 1).find((h) => h.level <= start.level);
  const lines = text.split("\n");
  const last = end ? end.line - 1 : lines.length;
  const items: { n: number; line: number }[] = [];
  let fence = false;
  for (let i = start.line; i < last; i++) {
    const s = lines[i] ?? "";
    if (/^\s*(```|~~~)/.test(s)) {
      fence = !fence;
      continue;
    }
    if (fence) continue;
    const m = s.match(/^(\d+)[.)]\s+\S/);
    if (m) items.push({ n: Number(m[1]), line: i + 1 });
  }
  return items;
}

/** The item numbers a trace names with "in scope #4, #8". */
function traceItems(trace: string): number[] {
  const out: number[] = [];
  for (const m of trace.matchAll(/in scope\s+((?:#\d+(?:\s*(?:,|;|and|&)\s*)?)+)/gi)) {
    for (const n of (m[1] ?? "").matchAll(/#(\d+)/g)) out.push(Number(n[1]));
  }
  return out;
}

function escape(s: string): string {
  return s.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
}

/** The decision records of a folder: slug and the status word of its `Status:` line. */
function decisionRecords(adrDir: string): { slug: string; status: string }[] {
  let names: string[];
  try {
    names = readdirSync(adrDir);
  } catch {
    return [];
  }
  const out: { slug: string; status: string }[] = [];
  for (const name of names.sort()) {
    if (!name.endsWith(".md") || name.toLowerCase() === "readme.md") continue;
    const base = name.slice(0, -3);
    const slug = base.replace(/^\d{4}-\d{2}-\d{2}-/, "");
    if (!slug) continue;
    const text = readText(join(adrDir, name));
    const m = text?.match(/^Status:\s*([A-Za-z]+)/m);
    out.push({ slug, status: m ? (m[1] ?? "") : "" });
  }
  return out;
}

/** The first line of a file that holds the slug as a whole name, with or without the date in front. */
function lineNaming(text: string, slug: string): number | null {
  const re = new RegExp(`(?<![A-Za-z0-9-])(?:\\d{4}-\\d{2}-\\d{2}-)?${escape(slug)}(?![A-Za-z0-9-])`);
  const lines = text.split("\n");
  for (let i = 0; i < lines.length; i++) if (re.test(lines[i] ?? "")) return i + 1;
  return null;
}

export function validatePlan(featureFolder: string, o: { adrDir?: string } = {}): PlanProblem[] {
  const problems: PlanProblem[] = [];
  const add = (file: string, line: number | null, code: string, text: string) => problems.push({ file, line, code, text });
  const texts = new Map<string, string>();

  // 1. The four files.
  for (const f of REQUIRED_FILES) {
    const t = existsSync(join(featureFolder, f)) ? readText(join(featureFolder, f)) : null;
    if (t === null) add(f, null, "missing-file", `${f} is missing`);
    else texts.set(f, t);
  }

  // 2. Their sections.
  for (const [f, wanted] of Object.entries(REQUIRED_HEADINGS)) {
    const t = texts.get(f);
    if (t === undefined) continue;
    const hs = headings(t);
    for (const w of wanted) {
      if (!hs.some((h) => w.start.test(h.text))) add(f, null, "missing-section", `${f} has no section for ${w.label}`);
    }
  }
  const acceptance = texts.get("ACCEPTANCE.md");
  if (acceptance !== undefined && !hasCheckItem(acceptance)) {
    add("ACCEPTANCE.md", null, "missing-section", "ACCEPTANCE.md has no check item");
  }

  // 3. TASKS.md parses and has a task.
  const tasksText = texts.get("TASKS.md");
  let traces: string[] | null = null;
  if (tasksText !== undefined) {
    try {
      const tasks = allTasks(parseTasks(tasksText, "TASKS.md"));
      if (!tasks.length) add("TASKS.md", null, "tasks-unreadable", "TASKS.md has no task");
      else traces = tasks.map((t) => t.trace);
    } catch (e) {
      if (e instanceof ParseError) add("TASKS.md", e.line, "tasks-unreadable", `TASKS.md line ${e.line}: ${e.reason}`);
      else add("TASKS.md", null, "tasks-unreadable", "TASKS.md cannot be read");
    }
  }

  // 4. Every "In scope" item has a task.
  const planText = texts.get("PLAN.md");
  if (planText !== undefined && traces !== null) {
    const named = new Set(traces.flatMap(traceItems));
    for (const item of inScopeItems(planText)) {
      if (!named.has(item.n)) add("PLAN.md", item.line, "scope-without-task", `In scope #${item.n} has no task`);
    }
  }

  // 5. No named decision record is Rejected or Superseded.
  const adrDir = o.adrDir ?? join(featureFolder, "..", "..", "adr");
  const bad = decisionRecords(adrDir).filter((r) => /^(rejected|superseded)$/i.test(r.status));
  if (bad.length) {
    for (const [f, t] of [...texts].filter(([f]) => f === "PLAN.md" || f === "TASKS.md")) {
      for (const r of bad) {
        const line = lineNaming(t, r.slug);
        if (line !== null) add(f, line, "decision-status", `Decision record ${r.slug} is ${r.status}`);
      }
    }
  }

  // 6. The staff checklist.
  if (planText !== undefined) {
    const hs = headings(planText);
    for (const c of STAFF_CHECKLIST) {
      if (!hs.some((h) => c.word.test(h.text))) add("PLAN.md", null, "staff-checklist", `PLAN.md has no section for ${c.label}`);
    }
  }

  return problems;
}

/** The plan files that exist, as paths relative to the feature folder. */
export function planFiles(featureFolder: string): string[] {
  const out: string[] = PLAN_MD_FILES.filter((f) => existsSync(join(featureFolder, f)));
  try {
    const shots = readdirSync(join(featureFolder, "wireframes"))
      .filter((n) => n.endsWith(".html"))
      .sort();
    for (const n of shots) out.push(`wireframes/${n}`);
  } catch {
    // no wireframes folder
  }
  return out;
}

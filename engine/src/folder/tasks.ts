/**
 * TASKS.md: the parser and the writer.
 *
 * Grammar (docs/templates/TASKS.md):
 *   ## Phase N — {title}
 *   - [ ] T0xx [P] {behavior} — `{files}` — verify: `{command}` {note} ({trace})
 *   Checkpoint: {text} — `{command}`
 *
 * A parse followed by `serialize` gives the same bytes. Every change is one line edit,
 * followed by a fresh parse, so a written file always parses.
 */

export class ParseError extends Error {
  constructor(
    public file: string,
    public line: number,
    public reason: string,
  ) {
    super(`${file}:${line}: ${reason}`);
    this.name = "ParseError";
  }
}

export interface Task {
  id: string;
  phase: number;
  parallel: boolean;
  text: string;
  files: string[];
  /** The command the engine runs. `null` means a person checks this task. */
  verify: string | null;
  /** Words after the command, or the whole verify text when there is no command. */
  verifyNote: string;
  trace: string;
  done: boolean;
  /** 1-based line number in the file. */
  line: number;
}

export interface Checkpoint {
  text: string;
  command: string | null;
  line: number;
}

export interface Phase {
  n: number;
  title: string;
  line: number;
  tasks: Task[];
  checkpoint?: Checkpoint;
}

export interface TasksDoc {
  file: string;
  lines: string[];
  phases: Phase[];
}

export interface NewTask {
  text: string;
  files: string[];
  verify: string | null;
  verifyNote?: string;
  trace?: string;
  parallel?: boolean;
  id?: string;
}

const PHASE = /^## Phase (\d+) [—–-] (.+)$/;
const TASK = /^- \[( |x|X)\] (T\d{3}[A-Za-z]?)( \[P\])? (.+)$/;
const CHECKBOX = /^\s*- \[.?\]/;
const SEP = " — ";
const VERIFY = " — verify: ";

function spans(s: string): string[] {
  return [...s.matchAll(/`([^`]+)`/g)].map((m) => m[1] ?? "");
}

function firstSpan(s: string): { code: string; rest: string } | null {
  if (!s.startsWith("`")) return null;
  const end = s.indexOf("`", 1);
  if (end < 0) return null;
  return { code: s.slice(1, end), rest: s.slice(end + 1).trim() };
}

function parseBody(body: string, file: string, line: number, prev: Task | undefined) {
  const v = body.lastIndexOf(VERIFY);
  if (v < 0) throw new ParseError(file, line, "the task has no ' — verify: ' part");
  let verifyText = body.slice(v + VERIFY.length).trim();
  const head = body.slice(0, v);
  const f = head.lastIndexOf(SEP);
  if (f < 0) throw new ParseError(file, line, "the task has no ' — ' before its files");
  const text = head.slice(0, f).trim();
  const filesPart = head.slice(f + SEP.length).trim();
  if (!text) throw new ParseError(file, line, "the task has no text");
  if (!filesPart) throw new ParseError(file, line, "the task names no files");

  let trace = "";
  const t = verifyText.match(/\s*\(([^()]*)\)\s*$/);
  if (t && t.index !== undefined) {
    trace = (t[1] ?? "").trim();
    verifyText = verifyText.slice(0, t.index).trim();
  }
  if (!verifyText) throw new ParseError(file, line, "the verify part is empty");

  let verify: string | null = null;
  let verifyNote = "";
  const span = firstSpan(verifyText);
  if (span) {
    verify = span.code;
    verifyNote = span.rest;
  } else if (verifyText === "same") {
    if (!prev || prev.verify === null) {
      throw new ParseError(file, line, "'verify: same' has no earlier command to copy");
    }
    verify = prev.verify;
    verifyNote = "same";
  } else {
    verifyNote = verifyText;
  }

  const quoted = spans(filesPart);
  const files = quoted.length
    ? quoted
    : filesPart
        .split(",")
        .map((x) => x.trim())
        .filter(Boolean);
  return { text, files, verify, verifyNote, trace };
}

function parseCheckpoint(s: string, line: number): Checkpoint {
  const rest = s.slice("Checkpoint:".length).trim();
  const cut = rest.lastIndexOf(" — `");
  if (cut >= 0) {
    const cmd = firstSpan(rest.slice(cut + SEP.length));
    return { text: rest.slice(0, cut).trim(), command: cmd ? cmd.code : null, line };
  }
  const cmd = firstSpan(rest);
  if (cmd) return { text: cmd.rest, command: cmd.code, line };
  return { text: rest, command: null, line };
}

export function parseTasks(text: string, file = "TASKS.md"): TasksDoc {
  const lines = text.split("\n");
  const phases: Phase[] = [];
  const seen = new Map<string, number>();
  let cur: Phase | undefined;
  let prev: Task | undefined;

  for (let i = 0; i < lines.length; i++) {
    const ln = i + 1;
    const s = (lines[i] ?? "").replace(/\r$/, "");

    const ph = s.match(PHASE);
    if (ph) {
      const n = Number(ph[1]);
      const other = phases.find((p) => p.n === n);
      if (other) throw new ParseError(file, ln, `phase ${n} is already on line ${other.line}`);
      cur = { n, title: (ph[2] ?? "").trim(), line: ln, tasks: [] };
      phases.push(cur);
      continue;
    }
    if (s.startsWith("## ")) {
      cur = undefined;
      continue;
    }
    if (!cur) continue;

    if (s.startsWith("Checkpoint:")) {
      cur.checkpoint = parseCheckpoint(s, ln);
      continue;
    }
    if (!CHECKBOX.test(s)) continue;

    const m = s.match(TASK);
    if (!m) {
      throw new ParseError(file, ln, "a checkbox line in a phase must look like '- [ ] T012 text — `files` — verify: `command`'");
    }
    const id = m[2] ?? "";
    const first = seen.get(id);
    if (first !== undefined) throw new ParseError(file, ln, `task ${id} is already on line ${first}`);
    seen.set(id, ln);

    const body = parseBody(m[4] ?? "", file, ln, prev);
    const task: Task = { id, phase: cur.n, parallel: Boolean(m[3]), done: m[1] !== " ", line: ln, ...body };
    cur.tasks.push(task);
    prev = task;
  }

  if (!phases.length) throw new ParseError(file, 1, "no '## Phase N — title' heading found");
  return { file, lines, phases };
}

export function serialize(doc: TasksDoc): string {
  return doc.lines.join("\n");
}

export function allTasks(doc: TasksDoc): Task[] {
  return doc.phases.flatMap((p) => p.tasks);
}

export function findTask(doc: TasksDoc, id: string): Task | undefined {
  return allTasks(doc).find((t) => t.id === id);
}

function need(doc: TasksDoc, id: string): Task {
  const t = findTask(doc, id);
  if (!t) throw new Error(`${doc.file}: no task ${id}`);
  return t;
}

function reparse(doc: TasksDoc, lines: string[]): TasksDoc {
  return parseTasks(lines.join("\n"), doc.file);
}

/** Checks or unchecks one task. Only that line changes. */
export function checkTask(doc: TasksDoc, id: string, done = true): TasksDoc {
  const t = need(doc, id);
  const lines = doc.lines.slice();
  const i = t.line - 1;
  lines[i] = (lines[i] ?? "").replace(/^- \[( |x|X)\]/, done ? "- [x]" : "- [ ]");
  return reparse(doc, lines);
}

function oneLine(what: string, s: string): string {
  if (/[\r\n]/.test(s)) throw new Error(`${what} must be one line`);
  return s.trim();
}

export function taskLine(id: string, t: NewTask): string {
  const text = oneLine("task text", t.text);
  if (!text) throw new Error("a task needs text");
  if (text.includes(VERIFY)) throw new Error("task text must not contain ' — verify: '");
  if (!t.files.length) throw new Error("a task must name its files");
  const files = t.files
    .map((f) => {
      const p = oneLine("a file path", f);
      if (!p || p.includes("`")) throw new Error(`bad file path: ${f}`);
      return "`" + p + "`";
    })
    .join(", ");
  const note = t.verifyNote ? oneLine("verify note", t.verifyNote) : "";
  let verify: string;
  if (t.verify !== null) {
    const cmd = oneLine("verify command", t.verify);
    if (!cmd || cmd.includes("`")) throw new Error("a verify command must be one line with no backtick");
    verify = "`" + cmd + "`" + (note && note !== "same" ? " " + note : "");
  } else {
    if (!note || note.startsWith("`") || note === "same") throw new Error("a task with no command needs a note that says who checks it");
    verify = note;
  }
  const trace = t.trace ? oneLine("trace", t.trace) : "";
  if (/[()]/.test(trace)) throw new Error("a trace must not contain brackets");
  return `- [ ] ${id}${t.parallel ? " [P]" : ""} ${text}${SEP}${files}${VERIFY}${verify}${trace ? ` (${trace})` : ""}`;
}

function idNumber(id: string): number {
  return Number(id.slice(1, 4));
}

function fmt(n: number): string {
  if (n > 999) throw new Error("task ids are used up");
  return "T" + String(n).padStart(3, "0");
}

/** The first id of a new phase: the next multiple of ten after the highest id. */
export function nextPhaseStartId(doc: TasksDoc): string {
  const max = Math.max(...allTasks(doc).map((t) => idNumber(t.id)), -1);
  return fmt(Math.ceil((max + 1) / 10) * 10);
}

/** The next id inside a phase. It never takes an id of a later phase; then it adds a letter. */
export function nextIdInPhase(doc: TasksDoc, phase: number): string {
  const p = doc.phases.find((x) => x.n === phase);
  if (!p) throw new Error(`${doc.file}: no phase ${phase}`);
  const used = new Set(allTasks(doc).map((t) => t.id));
  if (!p.tasks.length) {
    const later = doc.phases.filter((x) => x.n > phase).flatMap((x) => x.tasks.map((t) => idNumber(t.id)));
    const earlier = doc.phases.filter((x) => x.n < phase).flatMap((x) => x.tasks.map((t) => idNumber(t.id)));
    const start = Math.ceil((Math.max(...earlier, -1) + 1) / 10) * 10;
    if (!later.length || start < Math.min(...later)) return fmt(start);
    throw new Error(`${doc.file}: phase ${phase} has no free id`);
  }
  const top = Math.max(...p.tasks.map((t) => idNumber(t.id)));
  const laterMin = Math.min(...doc.phases.filter((x) => x.n > phase).flatMap((x) => x.tasks.map((t) => idNumber(t.id))), 1000);
  if (top + 1 < laterMin && !used.has(fmt(top + 1))) return fmt(top + 1);
  for (const letter of "abcdefghijklmnopqrstuvwxyz") {
    const id = fmt(top) + letter;
    if (!used.has(id)) return id;
  }
  throw new Error(`${doc.file}: phase ${phase} has no free id`);
}

/** Adds a task after the last task of its phase. */
export function addTask(doc: TasksDoc, phase: number, t: NewTask): TasksDoc {
  const p = doc.phases.find((x) => x.n === phase);
  if (!p) throw new Error(`${doc.file}: no phase ${phase}`);
  const id = t.id ?? nextIdInPhase(doc, phase);
  if (!/^T\d{3}[A-Za-z]?$/.test(id)) throw new Error(`bad task id: ${id}`);
  if (findTask(doc, id)) throw new Error(`${doc.file}: task ${id} exists`);
  const after = p.tasks.length ? (p.tasks[p.tasks.length - 1]?.line ?? p.line) : p.line;
  const lines = doc.lines.slice();
  const block = p.tasks.length ? [taskLine(id, t)] : ["", taskLine(id, t)];
  lines.splice(after, 0, ...block);
  return reparse(doc, lines);
}

/** Adds a phase before the first section that follows the last phase, such as "## Done when". */
export function addPhase(doc: TasksDoc, title: string, tasks: NewTask[]): TasksDoc {
  const name = oneLine("phase title", title);
  if (!name) throw new Error("a phase needs a title");
  if (!tasks.length) throw new Error("a phase needs one task or more");
  const n = Math.max(...doc.phases.map((p) => p.n)) + 1;
  let next = idNumber(nextPhaseStartId(doc));
  const block = [`## Phase ${n} — ${name}`, ""];
  for (const t of tasks) block.push(taskLine(t.id ?? fmt(next++), t));
  block.push("");

  const lines = doc.lines.slice();
  const lastPhase = doc.phases.reduce((a, b) => (b.line > a.line ? b : a));
  let at = lines.length;
  for (let i = lastPhase.line; i < lines.length; i++) {
    const s = lines[i] ?? "";
    if (s.startsWith("## ") && !PHASE.test(s)) {
      at = i;
      break;
    }
  }
  if (at === lines.length && lines[lines.length - 1] === "") at = lines.length - 1;
  if (at > 0 && lines[at - 1] !== "") block.unshift("");
  lines.splice(at, 0, ...block);
  return reparse(doc, lines);
}

/** Changes a task that is not done yet. A done task is history and is refused. */
export function editTask(doc: TasksDoc, id: string, patch: Partial<NewTask>): TasksDoc {
  const t = need(doc, id);
  if (t.done) throw new Error(`${doc.file}: task ${id} is done and cannot change`);
  const merged: NewTask = {
    text: patch.text ?? t.text,
    files: patch.files ?? t.files,
    verify: patch.verify !== undefined ? patch.verify : t.verify,
    verifyNote: patch.verifyNote ?? (t.verifyNote === "same" ? "" : t.verifyNote),
    trace: patch.trace ?? t.trace,
    parallel: patch.parallel ?? t.parallel,
  };
  const lines = doc.lines.slice();
  lines[t.line - 1] = taskLine(id, merged);
  return reparse(doc, lines);
}

export interface PhaseCount {
  n: number;
  title: string;
  verified: number;
  total: number;
}

export function counts(doc: TasksDoc): { phases: PhaseCount[]; verified: number; total: number } {
  const phases = doc.phases.map((p) => ({
    n: p.n,
    title: p.title,
    verified: p.tasks.filter((t) => t.done).length,
    total: p.tasks.length,
  }));
  return {
    phases,
    verified: phases.reduce((a, p) => a + p.verified, 0),
    total: phases.reduce((a, p) => a + p.total, 0),
  };
}

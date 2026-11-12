/**
 * handoffs.md: every note the admin agent passed on, with the owner's words next to it.
 *
 *   ## Note 3 · 2026-11-11 15:05 · build → orchestrator
 *   You: match recipe numbers without the dash too
 *   Note: Match recipe numbers with or without the dash. T022.
 *   Status: queued
 *
 * The engine is the only writer. An entry it cannot read is reported and left as it is.
 */

export type Stage = "map" | "plan" | "build" | "review";
export type NoteTarget = "orchestrator" | "plan" | "fixes" | "repo";
export type NoteStatus = "queued" | "read" | "undone" | "held";

export interface Note {
  n: number;
  /** YYYY-MM-DD HH:MM */
  at: string;
  stage: Stage;
  to: NoteTarget;
  said: string;
  note: string;
  status: NoteStatus;
  /** HH:MM, set when the status is `read`. */
  readAt?: string;
  /** 1-based line of the heading. */
  line: number;
}

export interface Unreadable {
  line: number;
  raw: string;
  reason: string;
}

export interface NotesDoc {
  notes: Note[];
  unreadable: Unreadable[];
}

export class NoteError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "NoteError";
  }
}

const HEAD = /^## Note (\d+) · (\d{4}-\d{2}-\d{2} \d{2}:\d{2}) · (map|plan|build|review) → (orchestrator|plan|fixes|repo)$/;
const STATUS = /^Status: (queued|undone|held|read (\d{2}:\d{2}))$/;
const LOOSE = /^## Note\b/;
const TITLE = "# Handoffs";

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

function field(lines: string[], b: Block, key: string): { value: string; index: number } | undefined {
  for (let i = b.start + 1; i < b.end; i++) {
    const s = lines[i] ?? "";
    if (s.startsWith(key + ": ")) return { value: s.slice(key.length + 2), index: i };
    if (s === key + ":") return { value: "", index: i };
  }
  return undefined;
}

export function parseNotes(text: string): NotesDoc {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const notes: Note[] = [];
  const unreadable: Unreadable[] = [];
  const bad = (b: Block, reason: string) => unreadable.push({ line: b.start + 1, raw: lines[b.start] ?? "", reason });

  for (const b of blocks(lines)) {
    const head = (lines[b.start] ?? "").match(HEAD);
    if (!head) {
      bad(b, "the heading is not '## Note N · YYYY-MM-DD HH:MM · stage → target'");
      continue;
    }
    const n = Number(head[1]);
    if (notes.some((x) => x.n === n)) {
      bad(b, `note number ${n} is used twice`);
      continue;
    }
    const said = field(lines, b, "You");
    const note = field(lines, b, "Note");
    const status = field(lines, b, "Status");
    if (!said) {
      bad(b, "the 'You:' line is missing");
      continue;
    }
    if (!note || !note.value.trim()) {
      bad(b, "the 'Note:' line is missing or empty");
      continue;
    }
    const st = status ? ("Status: " + status.value).match(STATUS) : null;
    if (!st) {
      bad(b, "the 'Status:' line must be queued, held, undone, or read HH:MM");
      continue;
    }
    const word = (st[1] ?? "").split(" ")[0] as NoteStatus;
    const entry: Note = {
      n,
      at: head[2] ?? "",
      stage: head[3] as Stage,
      to: head[4] as NoteTarget,
      said: said.value,
      note: note.value,
      status: word,
      line: b.start + 1,
    };
    if (word === "read" && st[2]) entry.readAt = st[2];
    notes.push(entry);
  }
  return { notes, unreadable };
}

function flat(s: string): string {
  return s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" / ");
}

/** The highest number in the file, counting entries that cannot be read, so a number is never used twice. */
function highest(text: string): number {
  let max = 0;
  for (const m of text.matchAll(/^## Note (\d+)\b/gm)) max = Math.max(max, Number(m[1]));
  return max;
}

export interface NewNote {
  at: string;
  stage: Stage;
  to: NoteTarget;
  said: string;
  note: string;
  status?: "queued" | "held";
}

/** Adds one note at the end. The owner's words and the note are each kept on one line. */
export function appendNote(text: string, input: NewNote): { text: string; note: Note } {
  if (!/^\d{4}-\d{2}-\d{2} \d{2}:\d{2}$/.test(input.at)) throw new NoteError(`bad time: ${input.at}`);
  const note = flat(input.note);
  if (!note) throw new NoteError("a note needs text");
  const said = flat(input.said);
  const n = highest(text) + 1;
  const status = input.status ?? "queued";
  let base = text;
  if (!base.trim()) base = TITLE + "\n";
  if (!base.endsWith("\n")) base += "\n";
  const block = `\n## Note ${n} · ${input.at} · ${input.stage} → ${input.to}\nYou: ${said}\nNote: ${note}\nStatus: ${status}\n`;
  const out = base + block;
  const made = parseNotes(out).notes.find((x) => x.n === n);
  if (!made) throw new NoteError("the new note did not parse");
  return { text: out, note: made };
}

function setStatus(text: string, n: number, next: string, allowed: NoteStatus[], refusal: (s: NoteStatus) => string): string {
  const lines = text.split("\n");
  const clean = lines.map((l) => l.replace(/\r$/, ""));
  const doc = parseNotes(text);
  const note = doc.notes.find((x) => x.n === n);
  if (!note) throw new NoteError(`no note ${n}`);
  if (!allowed.includes(note.status)) throw new NoteError(refusal(note.status));
  const b = blocks(clean).find((x) => x.start === note.line - 1);
  const status = b ? field(clean, b, "Status") : undefined;
  if (!status) throw new NoteError(`note ${n} has no status line`);
  lines[status.index] = "Status: " + next;
  return lines.join("\n");
}

const said = (s: NoteStatus) => (s === "read" ? "Already read" : s === "undone" ? "Already undone" : `Not possible while ${s}`);

/** queued → read. `hhmm` is the time the orchestrator confirmed, or the engine wrote it. */
export function markRead(text: string, n: number, hhmm: string): string {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new NoteError(`bad time: ${hhmm}`);
  return setStatus(text, n, `read ${hhmm}`, ["queued"], said);
}

/** queued or held → undone. A read note cannot be undone. */
export function undo(text: string, n: number): string {
  return setStatus(text, n, "undone", ["queued", "held"], said);
}

/** queued → held, when the chat is halted. */
export function hold(text: string, n: number): string {
  return setStatus(text, n, "held", ["queued"], said);
}

/** held → queued, when the chat resumes. */
export function release(text: string, n: number): string {
  return setStatus(text, n, "queued", ["held"], said);
}

export function queued(doc: NotesDoc, to?: NoteTarget): Note[] {
  return doc.notes.filter((x) => x.status === "queued" && (!to || x.to === to));
}

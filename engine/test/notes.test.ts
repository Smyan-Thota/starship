import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { NoteError, appendNote, hold, markRead, parseNotes, queued, release, undo } from "../src/folder/notes.ts";
import { fixture } from "./helpers.ts";

const BASE = [
  "# Handoffs",
  "",
  "## Note 1 · 2026-11-11 14:31 · plan → plan",
  "You: one request per 250ms, not every keystroke",
  "Note: Typing fast: one request per 250 ms.",
  "Status: read 14:31",
  "",
  "## Note 2 · 2026-11-11 15:05 · build → orchestrator",
  "You: match recipe numbers without the dash too",
  "Note: Match recipe numbers with or without the dash (R111 = R-111). T022.",
  "Status: queued",
  "",
].join("\n");

const changed = (a: string, b: string) => {
  const x = a.split("\n");
  return b.split("\n").filter((l, i) => l !== x[i]).length;
};

describe("notes", () => {
  test("the sample folder's handoffs file parses", () => {
    const doc = parseNotes(readFileSync(fixture("recipe-search", "run", "handoffs.md"), "utf8"));
    expect(doc.unreadable).toEqual([]);
    expect(doc.notes.map((n) => [n.n, n.to, n.status])).toEqual([
      [1, "plan", "read"],
      [2, "plan", "read"],
      [3, "orchestrator", "read"],
    ]);
    expect(doc.notes[2]).toMatchObject({ stage: "build", said: "match recipe numbers without the dash too", readAt: "15:06" });
  });

  test("reads every field", () => {
    const doc = parseNotes(BASE);
    expect(doc.notes).toEqual([
      { n: 1, at: "2026-11-11 14:31", stage: "plan", to: "plan", said: "one request per 250ms, not every keystroke", note: "Typing fast: one request per 250 ms.", status: "read", readAt: "14:31", line: 3 },
      { n: 2, at: "2026-11-11 15:05", stage: "build", to: "orchestrator", said: "match recipe numbers without the dash too", note: "Match recipe numbers with or without the dash (R111 = R-111). T022.", status: "queued", line: 8 },
    ]);
    expect(queued(doc).map((n) => n.n)).toEqual([2]);
    expect(queued(doc, "plan")).toEqual([]);
  });

  test("a new note gets the next number and starts queued", () => {
    const { text, note } = appendNote(BASE, { at: "2026-11-11 15:20", stage: "build", to: "orchestrator", said: "skip keyboard support\nfor now", note: "Skip T024 for now." });
    expect(note).toMatchObject({ n: 3, status: "queued", said: "skip keyboard support / for now", note: "Skip T024 for now." });
    expect(text.startsWith(BASE)).toBe(true);
    expect(parseNotes(text).notes.length).toBe(3);
  });

  test("the first note makes the file", () => {
    const { text, note } = appendNote("", { at: "2026-11-11 09:00", stage: "plan", to: "plan", said: "x", note: "Y." });
    expect(note.n).toBe(1);
    expect(text).toBe("# Handoffs\n\n## Note 1 · 2026-11-11 09:00 · plan → plan\nYou: x\nNote: Y.\nStatus: queued\n");
  });

  test("a note can start held, for a halted chat", () => {
    const { note } = appendNote(BASE, { at: "2026-11-11 15:20", stage: "build", to: "orchestrator", said: "x", note: "Y.", status: "held" });
    expect(note.status).toBe("held");
  });

  test.each([
    [{ at: "15:20", stage: "build", to: "orchestrator", said: "x", note: "Y." }, "bad time"],
    [{ at: "2026-11-11 15:20", stage: "build", to: "orchestrator", said: "x", note: "  \n " }, "needs text"],
  ] as const)("a bad new note is refused: %j", (input, word) => {
    expect(() => appendNote(BASE, input)).toThrow(word);
  });

  test("queued → read changes one line and records the time", () => {
    const next = markRead(BASE, 2, "15:06");
    expect(parseNotes(next).notes[1]).toMatchObject({ status: "read", readAt: "15:06" });
    expect(changed(BASE, next)).toBe(1);
  });

  test("B4: Undo works while the note is queued, and while it is held", () => {
    const a = undo(BASE, 2);
    expect(parseNotes(a).notes[1]!.status).toBe("undone");
    expect(changed(BASE, a)).toBe(1);
    const held = hold(BASE, 2);
    expect(parseNotes(held).notes[1]!.status).toBe("held");
    expect(parseNotes(undo(held, 2)).notes[1]!.status).toBe("undone");
  });

  test("B4: an undone note is never queued again", () => {
    const a = undo(BASE, 2);
    expect(queued(parseNotes(a))).toEqual([]);
    expect(() => markRead(a, 2, "15:06")).toThrow("Already undone");
    expect(() => release(a, 2)).toThrow(NoteError);
    expect(() => hold(a, 2)).toThrow(NoteError);
  });

  test("B5: Undo after the note is read is refused with 'Already read'", () => {
    expect(() => undo(BASE, 1)).toThrow("Already read");
    expect(() => undo(markRead(BASE, 2, "15:06"), 2)).toThrow("Already read");
  });

  test("held → queued on resume, and only from held", () => {
    const held = hold(BASE, 2);
    expect(parseNotes(release(held, 2)).notes[1]!.status).toBe("queued");
    expect(() => release(BASE, 2)).toThrow(NoteError);
    expect(() => hold(BASE, 1)).toThrow("Already read");
    expect(() => markRead(held, 2, "15:06")).toThrow(NoteError);
  });

  test("a note that does not exist is an error", () => {
    expect(() => undo(BASE, 9)).toThrow("no note 9");
  });

  test("B10: an entry the parser cannot read is reported with its line, and the other notes still work", () => {
    const broken = BASE + "\n## Note 3 · yesterday · build → orchestrator\nYou: x\nNote: y\nStatus: queued\n\n## Note 4 · 2026-11-11 15:30 · build → orchestrator\nYou: a\nNote: B.\nStatus: maybe\n\n## Note 5 · 2026-11-11 15:31 · build → fixes\nYou: c\nNote: D.\nStatus: queued\n";
    const doc = parseNotes(broken);
    expect(doc.notes.map((n) => n.n)).toEqual([1, 2, 5]);
    expect(doc.unreadable.map((u) => [u.line, u.raw.slice(0, 9)])).toEqual([
      [13, "## Note 3"],
      [18, "## Note 4"],
    ]);
    expect(doc.unreadable[0]!.reason).toContain("heading");
    expect(doc.unreadable[1]!.reason).toContain("Status");
    expect(queued(doc).map((n) => n.n)).toEqual([2, 5]);
    expect(parseNotes(undo(broken, 5)).notes[2]!.status).toBe("undone");
  });

  test("B10: a new note never takes the number of an unreadable entry", () => {
    const broken = BASE + "\n## Note 7 · broken\nNote: y\n";
    const { note, text } = appendNote(broken, { at: "2026-11-11 16:00", stage: "build", to: "orchestrator", said: "x", note: "Y." });
    expect(note.n).toBe(8);
    expect(parseNotes(text).unreadable.length).toBe(1);
  });

  test("B10: a number used twice is unreadable the second time", () => {
    const twice = BASE + "\n## Note 2 · 2026-11-11 15:40 · build → orchestrator\nYou: x\nNote: Y.\nStatus: queued\n";
    const doc = parseNotes(twice);
    expect(doc.notes.length).toBe(2);
    expect(doc.unreadable[0]!.reason).toContain("used twice");
  });

  test("a hand-written line between notes does not break them", () => {
    const text = BASE.replace("## Note 2", "A line someone typed by hand.\n\n## Note 2");
    expect(parseNotes(text).notes.map((n) => n.n)).toEqual([1, 2]);
    expect(parseNotes(markRead(text, 2, "15:07")).notes[1]!.status).toBe("read");
  });
});

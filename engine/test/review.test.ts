import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { cardsFromAcceptance, markEnvironmentDown, readCards, recordCardResult, writeCards } from "../src/review/cards.ts";
import type { Card } from "../src/review/cards.ts";
import { FixesError, fixList, readFixes, sendFixes, writeFixes } from "../src/review/fixes.ts";
import type { Fix } from "../src/review/fixes.ts";
import { addFinding, decideFinding, disputeFinding, markNoFindings, parseFindings, readFindings, serializeFindings } from "../src/folder/findings.ts";
import type { Finding } from "../src/folder/findings.ts";
import { parseNotes } from "../src/folder/notes.ts";
import type { Note } from "../src/folder/notes.ts";
import { parseTasks } from "../src/folder/tasks.ts";
import { drop, repoRoot, tempDir } from "./helpers.ts";

let dir = "";
beforeEach(() => {
  dir = tempDir("starship-review-");
});
afterEach(() => drop(dir));

const reviewFile = (name: string) => join(dir, "run", "review", name);
const read = (file: string) => readFileSync(file, "utf8");
const seed = (name: string, text: string) => {
  mkdirSync(join(dir, "run", "review"), { recursive: true });
  writeFileSync(reviewFile(name), text);
};
const throws = (f: () => unknown): string => {
  try {
    f();
  } catch (e) {
    return (e as Error).message;
  }
  throw new Error("expected an error");
};

const FINDINGS = [
  "# Findings",
  "",
  "## F1 · high · codex · engine/src/a.ts:12",
  "The loop never stops.",
  "Status: open",
  "",
  "## F2 · low · claude · engine/src/b.ts:3",
  "A name is wrong.",
  "Status: disputed",
  "Dispute: codex: the name matches the Words table",
  "",
].join("\n");

describe("findings", () => {
  test("reads every field and writes the same bytes back", () => {
    const doc = parseFindings(FINDINGS);
    expect(doc.problems).toEqual([]);
    expect(doc.none).toEqual([]);
    expect(doc.findings).toEqual([
      { n: 1, sev: "high", reviewer: "codex", where: "engine/src/a.ts:12", text: "The loop never stops.", status: "open", dispute: null },
      { n: 2, sev: "low", reviewer: "claude", where: "engine/src/b.ts:3", text: "A name is wrong.", status: "disputed", dispute: { reviewer: "codex", why: "the name matches the Words table" } },
    ]);
    expect(serializeFindings(doc)).toBe(FINDINGS);
  });

  test("an entry it cannot read is reported with its line and skipped, and the others still work", () => {
    const text = [
      "# Findings",
      "",
      "## F1 · urgent · codex · a.ts:1",
      "bad severity",
      "Status: open",
      "",
      "## F2 · high · codex · a.ts:2",
      "no status line",
      "",
      "## F3 · medium · codex · a.ts",
      "no line number",
      "Status: open",
      "",
      "## F4 · medium · codex · a.ts:4",
      "fine",
      "Status: open",
      "",
      "## F4 · medium · codex · a.ts:5",
      "same number again",
      "Status: open",
      "",
      "## F5 · medium · claude · a.ts:6",
      "disputed with no dispute line",
      "Status: disputed",
      "",
    ].join("\n");
    const doc = parseFindings(text);
    expect(doc.findings.map((f) => f.n)).toEqual([4]);
    expect(doc.problems.map((p) => p.line)).toEqual([3, 7, 10, 18, 22]);
    expect(doc.problems[0]?.text).toContain("F1");
  });

  test("a new finding gets the next number, even after an entry that cannot be read", () => {
    seed("findings.md", "# Findings\n\n## F7 · bogus · codex · a.ts:1\nx\nStatus: open\n");
    const f = addFinding(dir, { sev: "high", reviewer: "claude", where: "engine/src/x.ts:9", text: "A\nB" });
    expect(f).toEqual({ n: 8, sev: "high", reviewer: "claude", where: "engine/src/x.ts:9", text: "A B", status: "open", dispute: null });
    expect(read(reviewFile("findings.md"))).toContain("## F7 · bogus · codex · a.ts:1\nx\nStatus: open\n");
    expect(readFindings(dir).findings.map((x) => x.n)).toEqual([8]);
  });

  test("the first finding makes the file; a missing file reads as empty", () => {
    expect(readFindings(dir)).toEqual({ findings: [], none: [], problems: [] });
    const f = addFinding(dir, { sev: "low", reviewer: "codex", where: "a.ts:1", text: "x" });
    expect(f.n).toBe(1);
    expect(read(reviewFile("findings.md"))).toBe("# Findings\n\n## F1 · low · codex · a.ts:1\nx\nStatus: open\n");
  });

  test("a finding needs a file and a line, a known severity and a reviewer", () => {
    const ok = { sev: "low" as const, reviewer: "codex", where: "a.ts:1", text: "x" };
    expect(throws(() => addFinding(dir, { ...ok, where: "a.ts" }))).toContain("file:line");
    expect(throws(() => addFinding(dir, { ...ok, where: "a.ts:x" }))).toContain("file:line");
    expect(throws(() => addFinding(dir, { ...ok, text: "  " }))).toContain("text");
    expect(throws(() => addFinding(dir, { ...ok, reviewer: "" }))).toContain("reviewer");
    expect(throws(() => addFinding(dir, { ...ok, reviewer: "a · b" }))).toContain("reviewer");
    expect(throws(() => addFinding(dir, { ...ok, sev: "urgent" as never }))).toContain("severity");
    expect(throws(() => addFinding(dir, { ...ok, text: "Status: open" }))).toContain("text");
    expect(existsSync(reviewFile("findings.md"))).toBe(false);
  });

  test("H1: a reviewer that finds nothing is recorded, so the file says so", () => {
    markNoFindings(dir, "codex");
    expect(read(reviewFile("findings.md"))).toContain("## No findings · codex");
    const doc = readFindings(dir);
    expect(doc.none).toEqual(["codex"]);
    expect(doc.findings).toEqual([]);
    expect(doc.problems).toEqual([]);
    markNoFindings(dir, "codex");
    expect(readFindings(dir).none).toEqual(["codex"]);
    markNoFindings(dir, "claude");
    expect(readFindings(dir).none).toEqual(["codex", "claude"]);
  });

  test("H1: a reviewer with a finding cannot also say it found nothing, and a late finding takes the line back", () => {
    addFinding(dir, { sev: "low", reviewer: "codex", where: "a.ts:1", text: "x" });
    expect(throws(() => markNoFindings(dir, "codex"))).toContain("has a finding");
    markNoFindings(dir, "claude");
    addFinding(dir, { sev: "low", reviewer: "claude", where: "a.ts:2", text: "y" });
    const doc = readFindings(dir);
    expect(doc.none).toEqual([]);
    expect(doc.findings.map((f) => f.n)).toEqual([1, 2]);
  });

  test("H4: a dispute by the other reviewer makes an open finding disputed", () => {
    addFinding(dir, { sev: "high", reviewer: "claude", where: "a.ts:1", text: "x" });
    const f = disputeFinding(dir, 1, "codex", "the test covers it\nalready");
    expect(f).toMatchObject({ n: 1, status: "disputed", dispute: { reviewer: "codex", why: "the test covers it already" } });
    expect(readFindings(dir).findings[0]).toEqual(f);
    expect(read(reviewFile("findings.md"))).toContain("Status: disputed\nDispute: codex: the test covers it already\n");
  });

  test("H4: the finding's own reviewer cannot dispute it; a decided or disputed finding cannot be disputed again", () => {
    addFinding(dir, { sev: "high", reviewer: "claude", where: "a.ts:1", text: "x" });
    expect(throws(() => disputeFinding(dir, 1, "claude", "no"))).toContain("own");
    expect(throws(() => disputeFinding(dir, 1, "Claude", "no"))).toContain("own");
    expect(throws(() => disputeFinding(dir, 1, "codex", " "))).toContain("why");
    expect(throws(() => disputeFinding(dir, 9, "codex", "no"))).toContain("no finding 9");
    disputeFinding(dir, 1, "codex", "no");
    expect(throws(() => disputeFinding(dir, 1, "codex", "again"))).toContain("disputed");
    decideFinding(dir, 1, "rejected");
    expect(throws(() => disputeFinding(dir, 1, "codex", "again"))).toContain("rejected");
  });

  test("H4: the owner's decision settles a disputed finding and keeps the dispute", () => {
    addFinding(dir, { sev: "high", reviewer: "claude", where: "a.ts:1", text: "x" });
    disputeFinding(dir, 1, "codex", "wrong");
    const f = decideFinding(dir, 1, "accepted", "I agree with claude");
    expect(f).toMatchObject({ status: "accepted", dispute: { reviewer: "codex", why: "wrong" } });
    expect(read(reviewFile("findings.md"))).toContain("Status: accepted\nDispute: codex: wrong\nDecision: I agree with claude\n");
    const g = decideFinding(dir, 1, "rejected");
    expect(g.status).toBe("rejected");
    expect(read(reviewFile("findings.md"))).not.toContain("Decision:");
    expect(throws(() => decideFinding(dir, 4, "accepted"))).toContain("no finding 4");
  });

  test("the owner can decide an open finding too", () => {
    addFinding(dir, { sev: "low", reviewer: "claude", where: "a.ts:1", text: "x" });
    expect(decideFinding(dir, 1, "rejected", "not a bug").status).toBe("rejected");
  });

  test("a write reads the file again and keeps a hand edit and an entry it cannot read", () => {
    seed("findings.md", FINDINGS + "\n## F9 · nope\nbroken\n");
    writeFileSync(reviewFile("findings.md"), read(reviewFile("findings.md")).replace("The loop never stops.", "The loop never stops (edited)."));
    decideFinding(dir, 1, "accepted");
    const after = read(reviewFile("findings.md"));
    expect(after).toContain("The loop never stops (edited).\nStatus: accepted");
    expect(after).toContain("## F9 · nope\nbroken\n");
    expect(parseFindings(after).problems.map((p) => p.line)).toEqual([12]);
    expect(after.replace("Status: accepted", "Status: open").replace(" (edited).", ".")).toBe(FINDINGS + "\n## F9 · nope\nbroken\n");
  });

  test("an error leaves the file as it was", () => {
    seed("findings.md", FINDINGS);
    throws(() => disputeFinding(dir, 1, "codex", ""));
    throws(() => decideFinding(dir, 5, "accepted"));
    expect(read(reviewFile("findings.md"))).toBe(FINDINGS);
  });
});

const ACCEPT = [
  "# Acceptance — Demo",
  "",
  "## Behavior",
  "",
  "**Group**",
  "- Plain item that counts. It has a second sentence.",
  "- [ ] A checkbox item",
  "- [x] A ticked checkbox item",
  "",
  "## Errors",
  "",
  "- not a card: it is an error row",
  "",
  "## Tests",
  "",
  "- `bun test` passes",
  "- [ ] A checkbox in tests still counts",
  "",
  "## Manual checks",
  "",
  "**M1 — one real agent (end of Phase 2)**",
  "",
  "```bash",
  "bun run dev",
  "```",
  "",
  "1. New chat with no repo. Send \"say hello\".",
  "2. Click Terminal on Admin.",
  "",
  "**M2 — a real plan**",
  "",
  "1. Ask for a small feature.",
  "",
].join("\n");

describe("cards", () => {
  test("one card for each check: a checkbox item and a bold M block with numbered steps", () => {
    const cards = cardsFromAcceptance(ACCEPT);
    expect(cards.map((c) => c.id)).toEqual(["C1", "C2", "C3", "C4", "M1", "M2"]);
    expect(cards[0]).toEqual({ id: "C1", title: "Plain item that counts", description: "It has a second sentence.", criteria: ["Plain item that counts. It has a second sentence."], result: null, note: "" });
    expect(cards[1]).toEqual({ id: "C2", title: "A checkbox item", description: "", criteria: ["A checkbox item"], result: null, note: "" });
    expect(cards[2]?.title).toBe("A ticked checkbox item");
    expect(cards[3]?.title).toBe("A checkbox in tests still counts");
    expect(cards[4]).toEqual({
      id: "M1",
      title: "one real agent (end of Phase 2)",
      description: "",
      criteria: ['New chat with no repo. Send "say hello".', "Click Terminal on Admin."],
      result: null,
      note: "",
    });
    expect(cards[5]?.criteria).toEqual(["Ask for a small feature."]);
  });

  test("a file with no check gives no card", () => {
    expect(cardsFromAcceptance("# Acceptance\n\n## Tests\n\n- `uv run pytest` passes\n")).toEqual([]);
    expect(cardsFromAcceptance("")).toEqual([]);
  });

  test("the chat's own ACCEPTANCE.md gives its M cards", () => {
    const cards = cardsFromAcceptance(readFileSync(join(repoRoot, "docs", "features", "starship", "ACCEPTANCE.md"), "utf8"));
    const m = cards.filter((c) => c.id.startsWith("M"));
    expect(m.map((c) => c.id).sort()).toEqual(["M1", "M2", "M3", "M4", "M5", "M6", "M7"]);
    expect(m.find((c) => c.id === "M2")?.criteria).toHaveLength(3);
    expect(cards.length).toBeGreaterThan(m.length);
    expect(new Set(cards.map((c) => c.id)).size).toBe(cards.length);
  });

  const two = (): Card[] => cardsFromAcceptance(ACCEPT).slice(0, 2);

  test("writes the cards, and reads the same cards back", () => {
    writeCards(dir, two());
    expect(existsSync(reviewFile("story-cards.md"))).toBe(true);
    const got = readCards(dir);
    expect(got.problems).toEqual([]);
    expect(got.cards).toEqual(two());
    expect(read(reviewFile("story-cards.md"))).toContain("## C2 · A checkbox item\n");
  });

  test("a missing file reads as no cards", () => {
    expect(readCards(dir)).toEqual({ cards: [], problems: [] });
  });

  test("an entry it cannot read is reported with its line and skipped", () => {
    seed(
      "story-cards.md",
      [
        "# Story cards",
        "",
        "## C1 · fine",
        "Description: d",
        "- one",
        "Result: pass",
        "Note: ok",
        "",
        "## C2 · wrong result",
        "Description:",
        "- one",
        "Result: maybe",
        "Note:",
        "",
        "## broken heading",
        "- one",
        "",
        "## C1 · again",
        "Description:",
        "- one",
        "Result: none",
        "Note:",
        "",
      ].join("\n"),
    );
    const got = readCards(dir);
    expect(got.cards).toEqual([{ id: "C1", title: "fine", description: "d", criteria: ["one"], result: "pass", note: "ok" }]);
    expect(got.problems.map((p) => p.line)).toEqual([9, 15, 18]);
  });

  test("a result is recorded on one card and nothing else changes", () => {
    writeCards(dir, two());
    const before = read(reviewFile("story-cards.md"));
    const c = recordCardResult(dir, "C2", "fail", "the button is missing\non narrow screens");
    expect(c).toMatchObject({ id: "C2", result: "fail", note: "the button is missing on narrow screens" });
    const got = readCards(dir).cards;
    expect(got[0]?.result).toBeNull();
    expect(got[1]).toEqual(c);
    expect(read(reviewFile("story-cards.md")).split("\n").filter((l, i) => l !== before.split("\n")[i])).toEqual(["Result: fail", "Note: the button is missing on narrow screens"]);
    expect(recordCardResult(dir, "C2", "pass", "").result).toBe("pass");
    expect(throws(() => recordCardResult(dir, "C9", "pass", ""))).toContain("no card C9");
    expect(throws(() => recordCardResult(dir, "C1", "great" as never, ""))).toContain("result");
  });

  test("H2: the test environment is down, so every card with no result is unclear with the reason, and none is fail", () => {
    writeCards(dir, cardsFromAcceptance(ACCEPT));
    recordCardResult(dir, "C1", "pass", "worked");
    const count = markEnvironmentDown(dir, "the test server does not answer");
    expect(count).toBe(5);
    const cards = readCards(dir).cards;
    expect(cards).toHaveLength(6);
    expect(cards.map((c) => c.result)).toEqual(["pass", "unclear", "unclear", "unclear", "unclear", "unclear"]);
    expect(cards.slice(1).every((c) => c.note === "the test server does not answer")).toBe(true);
    expect(cards.some((c) => c.result === "fail")).toBe(false);
    expect(markEnvironmentDown(dir, "again")).toBe(0);
    expect(readCards(dir).cards.slice(1).every((c) => c.note === "the test server does not answer")).toBe(true);
  });

  test("H2: with no file there is nothing to mark", () => {
    expect(markEnvironmentDown(dir, "down")).toBe(0);
    expect(existsSync(reviewFile("story-cards.md"))).toBe(false);
  });

  test("a write reads the file again and keeps a hand edit and an entry it cannot read", () => {
    writeCards(dir, two());
    writeFileSync(reviewFile("story-cards.md"), read(reviewFile("story-cards.md")) + "\n## junk\n- x\n");
    writeFileSync(reviewFile("story-cards.md"), read(reviewFile("story-cards.md")).replace("Description: It has a second sentence.", "Description: edited by hand"));
    recordCardResult(dir, "C2", "pass", "ok");
    markEnvironmentDown(dir, "down");
    const after = read(reviewFile("story-cards.md"));
    expect(after).toContain("Description: edited by hand");
    expect(after).toContain("## junk\n- x\n");
    expect(readCards(dir).cards.map((c) => c.result)).toEqual(["unclear", "pass"]);
  });
});

const TASKS = ["# Tasks", "", "## Phase 1 — Build", "", "- [x] T001 first — `a.ts` — verify: `bun test`", "", "## Done when", "", "- all done", ""].join("\n");

const finding = (n: number, status: Finding["status"], extra: Partial<Finding> = {}): Finding => ({
  n,
  sev: "medium",
  reviewer: "codex",
  where: `src/f${n}.ts:${n}`,
  text: `problem ${n}`,
  status,
  dispute: status === "disputed" ? { reviewer: "claude", why: "no" } : null,
  ...extra,
});

const note = (n: number, to: Note["to"], status: Note["status"]): Note => ({ n, at: "2026-11-11 10:00", stage: "review", to, said: `said ${n}`, note: `do thing ${n}`, status, line: 1 });

describe("fixes", () => {
  test("one fix for each open or accepted finding, then one for each fixes note that is not undone", () => {
    const findings = [finding(1, "open"), finding(2, "disputed"), finding(3, "rejected"), finding(4, "accepted")];
    const notes = [note(1, "fixes", "queued"), note(2, "orchestrator", "queued"), note(3, "fixes", "undone"), note(4, "fixes", "read"), note(5, "fixes", "held")];
    expect(fixList(findings, notes)).toEqual([
      { n: 1, text: "problem 1 (src/f1.ts:1)", from: "F1" },
      { n: 2, text: "problem 4 (src/f4.ts:4)", from: "F4" },
      { n: 3, text: "do thing 1", from: "Note 1" },
      { n: 4, text: "do thing 4", from: "Note 4" },
      { n: 5, text: "do thing 5", from: "Note 5" },
    ]);
  });

  test("numbers are stable: a fix keeps its number when the list is built again", () => {
    const first = fixList([finding(1, "open"), finding(2, "open")], [note(1, "fixes", "queued")]);
    expect(first.map((f) => [f.n, f.from])).toEqual([[1, "F1"], [2, "F2"], [3, "Note 1"]]);
    // F1 is rejected, a new finding F3 comes, and a new note comes.
    const second = fixList([finding(1, "rejected"), finding(2, "accepted"), finding(3, "open")], [note(1, "fixes", "queued"), note(2, "fixes", "queued")], first);
    expect(second.map((f) => [f.n, f.from])).toEqual([
      [2, "F2"],
      [3, "Note 1"],
      [4, "F3"],
      [5, "Note 2"],
    ]);
  });

  test("a number is never used again, even when its fix leaves the list and comes back", () => {
    const first = fixList([finding(1, "open"), finding(2, "open")], []);
    const less = fixList([finding(1, "disputed"), finding(2, "open")], [], first);
    expect(less.map((f) => f.n)).toEqual([2]);
    const more = fixList([finding(1, "open"), finding(2, "open"), finding(3, "open")], [], less);
    expect(more.map((f) => [f.n, f.from])).toEqual([
      [2, "F2"],
      [3, "F1"],
      [4, "F3"],
    ]);
  });

  test("the text follows the finding when it is built again", () => {
    const first = fixList([finding(1, "open")], []);
    const again = fixList([finding(1, "open", { text: "new words" })], [], first);
    expect(again).toEqual([{ n: 1, text: "new words (src/f1.ts:1)", from: "F1" }]);
  });

  test("an empty input gives an empty list", () => {
    expect(fixList([], [])).toEqual([]);
  });

  const sample: Fix[] = [
    { n: 1, text: "problem 1 (src/f1.ts:1)", from: "F1" },
    { n: 3, text: "do thing 1 — from here on", from: "Note 1" },
  ];

  test("writes lines '- X<n> <text> — from <from>' and reads them back", () => {
    writeFixes(dir, sample);
    const text = read(reviewFile("fixes.md"));
    expect(text).toContain("- X1 problem 1 (src/f1.ts:1) — from F1\n");
    expect(text).toContain("- X3 do thing 1 — from here on — from Note 1\n");
    expect(readFixes(dir)).toEqual({ fixes: sample, problems: [] });
  });

  test("a missing file reads as no fixes, and writing an empty list leaves a file with no fix", () => {
    expect(readFixes(dir)).toEqual({ fixes: [], problems: [] });
    writeFixes(dir, []);
    expect(readFixes(dir)).toEqual({ fixes: [], problems: [] });
  });

  test("a line it cannot read is reported with its number and skipped", () => {
    seed("fixes.md", "# Fixes\n\n- X1 fine — from F1\n- X2 no source\n- X1 same number — from F2\n- Xq text — from F3\n\n- X4 ok — from Note 2\n");
    const got = readFixes(dir);
    expect(got.fixes.map((f) => f.n)).toEqual([1, 4]);
    expect(got.problems.map((p) => p.line)).toEqual([4, 5, 6]);
  });

  test("sendFixes is refused while a finding is disputed, and TASKS.md stays as it was", () => {
    writeFileSync(join(dir, "TASKS.md"), TASKS);
    const msg = throws(() => sendFixes({ dir, findings: [finding(1, "open"), finding(2, "disputed")], fixes: sample, lastSent: 0 }));
    expect(msg).toContain("disputed");
    expect(read(join(dir, "TASKS.md"))).toBe(TASKS);
    expect(() => sendFixes({ dir, findings: [finding(2, "disputed")], fixes: [], lastSent: 0 })).toThrow(FixesError);
  });

  test("sendFixes adds one phase titled Fixes before the closing section", () => {
    writeFileSync(join(dir, "TASKS.md"), TASKS);
    const r = sendFixes({ dir, findings: [finding(1, "open")], fixes: sample, lastSent: 0 });
    expect(r).toEqual({ phase: 2, sent: sample, lastSent: 3 });
    const text = read(join(dir, "TASKS.md"));
    const doc = parseTasks(text);
    expect(doc.phases.map((p) => [p.n, p.title])).toEqual([[1, "Build"], [2, "Fixes"]]);
    expect(text.indexOf("## Phase 2 — Fixes")).toBeLessThan(text.indexOf("## Done when"));
    expect(text.startsWith(TASKS.split("## Done when")[0] ?? "")).toBe(true);
    expect(text.endsWith("## Done when\n\n- all done\n")).toBe(true);
    expect(text).not.toMatch(/\n\n\n/);
  });

  test("H3: the fix list is sent twice and one phase is added, once", () => {
    writeFileSync(join(dir, "TASKS.md"), TASKS);
    const first = sendFixes({ dir, findings: [finding(1, "open")], fixes: sample, lastSent: 0 });
    const afterFirst = read(join(dir, "TASKS.md"));
    const second = sendFixes({ dir, findings: [finding(1, "open")], fixes: sample, lastSent: first.lastSent });
    expect(second).toEqual({ phase: null, sent: [], lastSent: 3 });
    expect(read(join(dir, "TASKS.md"))).toBe(afterFirst);
    expect(parseTasks(afterFirst).phases.filter((p) => p.title === "Fixes")).toHaveLength(1);
  });

  test("a fix that comes later goes out in a new phase, and the old ones do not go twice", () => {
    writeFileSync(join(dir, "TASKS.md"), TASKS);
    const first = sendFixes({ dir, findings: [], fixes: sample, lastSent: 0 });
    const more: Fix[] = [...sample, { n: 4, text: "late", from: "F5" }];
    const second = sendFixes({ dir, findings: [], fixes: more, lastSent: first.lastSent });
    expect(second).toEqual({ phase: 3, sent: [{ n: 4, text: "late", from: "F5" }], lastSent: 4 });
    expect(parseTasks(read(join(dir, "TASKS.md"))).phases.map((p) => p.title)).toEqual(["Build", "Fixes", "Fixes"]);
  });

  test("an empty fix list adds no phase", () => {
    writeFileSync(join(dir, "TASKS.md"), TASKS);
    expect(sendFixes({ dir, findings: [], fixes: [], lastSent: 0 })).toEqual({ phase: null, sent: [], lastSent: 0 });
    expect(read(join(dir, "TASKS.md"))).toBe(TASKS);
  });

  test("a phase is added after the last phase when the file has no closing section", () => {
    writeFileSync(join(dir, "TASKS.md"), "# Tasks\n\n## Phase 1 — Build\n\n- [ ] T001 first — `a.ts` — verify: `bun test`\n");
    expect(sendFixes({ dir, findings: [], fixes: sample, lastSent: 0 }).phase).toBe(2);
    expect(parseTasks(read(join(dir, "TASKS.md"))).phases.map((p) => p.title)).toEqual(["Build", "Fixes"]);
  });

  test("sendFixes reads TASKS.md again, so a hand edit stays", () => {
    writeFileSync(join(dir, "TASKS.md"), TASKS);
    writeFileSync(join(dir, "TASKS.md"), TASKS.replace("all done", "all done by hand"));
    sendFixes({ dir, findings: [], fixes: sample, lastSent: 0 });
    expect(read(join(dir, "TASKS.md"))).toContain("all done by hand");
  });

  test("the notes in the sample parse the way fixList reads them", () => {
    const text = "# Handoffs\n\n## Note 1 · 2026-11-11 15:05 · review → fixes\nYou: also rename it\nNote: Rename the flag.\nStatus: queued\n";
    expect(fixList([], parseNotes(text).notes)).toEqual([{ n: 1, text: "Rename the flag.", from: "Note 1" }]);
  });
});

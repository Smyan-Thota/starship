import { describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { renderProgress } from "../src/folder/progress.ts";
import { QuestionError, answerQuestion, appendQuestion, open, parseQuestions } from "../src/folder/questions.ts";
import { counts, parseTasks } from "../src/folder/tasks.ts";
import { fixture } from "./helpers.ts";

describe("questions", () => {
  test("the sample folder's questions file parses", () => {
    const doc = parseQuestions(readFileSync(fixture("recipe-search", "run", "questions.md"), "utf8"));
    expect(doc.unreadable).toEqual([]);
    expect(doc.questions).toEqual([{ n: 1, at: "15:09", agent: "worker-b", task: "T023", question: "Include archived recipes in results?", status: "open", line: 3 }]);
  });

  test("a question is added open, then answered once", () => {
    const a = appendQuestion("", { at: "15:09", agent: "worker-b", task: "T023", question: "Include archived recipes\nin results?" });
    expect(a.text).toBe("# Questions\n\n## Q1 · 15:09 · worker-b · T023\nInclude archived recipes / in results?\nStatus: open\n");
    const b = appendQuestion(a.text, { at: "15:11", agent: "worker-a", task: "T022", question: "Which dash characters count?" });
    expect(b.question.n).toBe(2);
    expect(open(parseQuestions(b.text)).map((q) => q.n)).toEqual([1, 2]);

    const done = answerQuestion(b.text, 1, "15:12", "Exclude them.");
    const doc = parseQuestions(done);
    expect(doc.questions[0]).toMatchObject({ status: "answered", answeredAt: "15:12", answer: "Exclude them." });
    expect(doc.questions[1]).toMatchObject({ n: 2, status: "open" });
    expect(open(doc).map((q) => q.n)).toEqual([2]);
    expect(() => answerQuestion(done, 1, "15:13", "Include them.")).toThrow("already answered");
  });

  test.each([
    [() => appendQuestion("", { at: "3pm", agent: "a", task: "T1", question: "q" }), "bad time"],
    [() => appendQuestion("", { at: "15:00", agent: "a", task: "T1", question: " " }), "needs text"],
    [() => appendQuestion("", { at: "15:00", agent: " ", task: "T1", question: "q" }), "agent"],
    [() => answerQuestion("# Questions\n", 4, "15:00", "x"), "no question Q4"],
  ])("a bad call is refused", (fn, word) => {
    expect(fn).toThrow(QuestionError);
    expect(fn).toThrow(word);
  });

  test("an entry that cannot be read is reported, and the others still work", () => {
    const text = "# Questions\n\n## Q1 · soon · worker-b · T023\nWhat?\nStatus: open\n\n## Q2 · 15:10 · worker-a · T022\nWhich dash?\nStatus: open\n";
    const doc = parseQuestions(text);
    expect(doc.questions.map((q) => q.n)).toEqual([2]);
    expect(doc.unreadable).toEqual([{ line: 3, raw: "## Q1 · soon · worker-b · T023", reason: "the heading is not '## Qn · HH:MM · agent · task'" }]);
    expect(appendQuestion(text, { at: "15:20", agent: "x", task: "T1", question: "q" }).question.n).toBe(3);
  });

  test("an agent name or task with odd characters still gives a heading that parses", () => {
    const { question } = appendQuestion("", { at: "15:09", agent: "worker · b", task: "T023 and T024", question: "q" });
    expect(question).toMatchObject({ agent: "worker - b", task: "T023-and-T024" });
  });
});

describe("progress", () => {
  test("renders counts, the running tasks and the lists that have entries", () => {
    const doc = parseTasks(readFileSync(fixture("recipe-search", "TASKS.md"), "utf8"));
    const out = renderProgress({
      title: "Recipe search",
      phases: counts(doc).phases,
      now: ["T022 Worker A: working", "T023 Worker B: waiting for typecheck"],
      outside: ["src/unrelated.ts"],
      fromTerminal: [],
      manual: [],
    });
    expect(out).toContain("# Progress — Recipe search");
    expect(out).toContain("| 0 · Foundation | 3 | 3 |");
    expect(out).toContain("| 2 · Screen | 2 | 5 |");
    expect(out).toContain("**9 / 20**");
    expect(out).toContain("## Now\n\n- T022 Worker A: working\n- T023 Worker B: waiting for typecheck");
    expect(out).toContain("## Outside the task\n\n- src/unrelated.ts");
    expect(out).not.toContain("## From terminal");
    expect(out).not.toContain("Halted");
    expect(out.endsWith("\n")).toBe(true);
  });

  test("shows the halt time, and keeps a table cell on one line", () => {
    const out = renderProgress({ title: "x", phases: [{ n: 0, title: "A | B\nC", verified: 0, total: 1 }], now: [], outside: [], fromTerminal: ["T022 Worker A, 15:20"], manual: ["M1 2026-11-12 pass"], halted: "15:14" });
    expect(out).toContain("| 0 · A \\| B C | 0 | 1 |");
    expect(out).toContain("Halted 15:14");
    expect(out).toContain("## From terminal\n\n- T022 Worker A, 15:20");
    expect(out).toContain("## Manual checks\n\n- M1 2026-11-12 pass");
  });
});

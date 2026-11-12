/**
 * questions.md: what agents asked, and the answers.
 *
 *   ## Q1 · 15:09 · worker-b · T023
 *   Include archived recipes in results?
 *   Status: open
 *
 *   ## Q1 · 15:09 · worker-b · T023
 *   Include archived recipes in results?
 *   Status: answered 15:12
 *   Answer: Exclude them.
 */

export interface Question {
  n: number;
  /** HH:MM */
  at: string;
  agent: string;
  task: string;
  question: string;
  status: "open" | "answered";
  answeredAt?: string;
  answer?: string;
  line: number;
}

export interface QuestionsDoc {
  questions: Question[];
  unreadable: { line: number; raw: string; reason: string }[];
}

export class QuestionError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "QuestionError";
  }
}

const HEAD = /^## Q(\d+) · (\d{2}:\d{2}) · ([^·]+?) · (\S+)$/;
const STATUS = /^Status: (open|answered (\d{2}:\d{2}))$/;
const TITLE = "# Questions";

function flat(s: string): string {
  return s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" / ");
}

export function parseQuestions(text: string): QuestionsDoc {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const questions: Question[] = [];
  const unreadable: QuestionsDoc["unreadable"] = [];

  for (let i = 0; i < lines.length; i++) {
    const s = lines[i] ?? "";
    if (!/^## Q/.test(s)) continue;
    let end = lines.length;
    for (let j = i + 1; j < lines.length; j++) {
      const t = lines[j] ?? "";
      if (t.startsWith("## ") || t.startsWith("# ")) {
        end = j;
        break;
      }
    }
    const bad = (reason: string) => unreadable.push({ line: i + 1, raw: s, reason });
    const head = s.match(HEAD);
    if (!head) {
      bad("the heading is not '## Qn · HH:MM · agent · task'");
      continue;
    }
    const n = Number(head[1]);
    if (questions.some((q) => q.n === n)) {
      bad(`question number ${n} is used twice`);
      continue;
    }
    const body: string[] = [];
    let status: RegExpMatchArray | null = null;
    let answer: string | undefined;
    for (let j = i + 1; j < end; j++) {
      const t = lines[j] ?? "";
      if (t.startsWith("Status: ")) status = t.match(STATUS);
      else if (t.startsWith("Answer: ")) answer = t.slice("Answer: ".length);
      else if (!status && t.trim()) body.push(t.trim());
    }
    if (!body.length) {
      bad("the question text is missing");
      continue;
    }
    if (!status) {
      bad("the 'Status:' line must be open, or answered HH:MM");
      continue;
    }
    const q: Question = {
      n,
      at: head[2] ?? "",
      agent: (head[3] ?? "").trim(),
      task: head[4] ?? "",
      question: body.join(" "),
      status: status[1] === "open" ? "open" : "answered",
      line: i + 1,
    };
    if (q.status === "answered") {
      if (status[2]) q.answeredAt = status[2];
      if (answer === undefined) {
        bad("an answered question needs an 'Answer:' line");
        continue;
      }
      q.answer = answer;
    }
    questions.push(q);
  }
  return { questions, unreadable };
}

export interface NewQuestion {
  at: string;
  agent: string;
  task: string;
  question: string;
}

export function appendQuestion(text: string, input: NewQuestion): { text: string; question: Question } {
  if (!/^\d{2}:\d{2}$/.test(input.at)) throw new QuestionError(`bad time: ${input.at}`);
  const question = flat(input.question);
  if (!question) throw new QuestionError("a question needs text");
  const agent = flat(input.agent).replaceAll("·", "-");
  const task = flat(input.task).replace(/\s+/g, "-") || "-";
  if (!agent) throw new QuestionError("a question needs the agent that asked it");
  let max = 0;
  for (const m of text.matchAll(/^## Q(\d+)\b/gm)) max = Math.max(max, Number(m[1]));
  const n = max + 1;
  let base = text;
  if (!base.trim()) base = TITLE + "\n";
  if (!base.endsWith("\n")) base += "\n";
  const out = base + `\n## Q${n} · ${input.at} · ${agent} · ${task}\n${question}\nStatus: open\n`;
  const made = parseQuestions(out).questions.find((q) => q.n === n);
  if (!made) throw new QuestionError("the new question did not parse");
  return { text: out, question: made };
}

/** open → answered. An answered question keeps its first answer. */
export function answerQuestion(text: string, n: number, hhmm: string, answer: string): string {
  if (!/^\d{2}:\d{2}$/.test(hhmm)) throw new QuestionError(`bad time: ${hhmm}`);
  const reply = flat(answer);
  if (!reply) throw new QuestionError("an answer needs text");
  const q = parseQuestions(text).questions.find((x) => x.n === n);
  if (!q) throw new QuestionError(`no question Q${n}`);
  if (q.status !== "open") throw new QuestionError(`Q${n} is already answered`);
  const lines = text.split("\n");
  for (let i = q.line; i < lines.length; i++) {
    const s = (lines[i] ?? "").replace(/\r$/, "");
    if (s.startsWith("## ") || s.startsWith("# ")) break;
    if (s === "Status: open") {
      lines.splice(i, 1, `Status: answered ${hhmm}`, `Answer: ${reply}`);
      return lines.join("\n");
    }
  }
  throw new QuestionError(`Q${n} has no status line`);
}

export function open(doc: QuestionsDoc): Question[] {
  return doc.questions.filter((q) => q.status === "open");
}

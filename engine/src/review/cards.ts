/**
 * Story cards: one short test for each check in a chat's ACCEPTANCE.md, in run/review/story-cards.md.
 *
 *   ## C2 · A checkbox item
 *   Description: {text, may be empty}
 *   - {criterion}
 *   - {criterion}
 *   Result: {pass|fail|unclear|none}
 *   Note: {text}
 *
 * `cardsFromAcceptance` reads two shapes: a checkbox item (`- [ ] text`, or a plain bullet under "## Behavior"),
 * and a bold block `**M1 — title**` whose numbered steps are the criteria.
 *
 * The engine is the only writer. A result is written by changing only its own lines, after reading the file again,
 * so a hand edit and an entry this parser cannot read both stay. An entry it cannot read is reported and skipped.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { writeRunFile } from "../folder/write.ts";

export type CardResult = "pass" | "fail" | "unclear";

export interface Card {
  id: string;
  title: string;
  description: string;
  criteria: string[];
  result: CardResult | null;
  note: string;
}

export interface CardProblem {
  /** 1-based line of the entry's heading. */
  line: number;
  text: string;
}

export class CardError extends Error {
  constructor(message: string) {
    super(message);
    this.name = "CardError";
  }
}

export function cardsPath(dir: string): string {
  return join(dir, "run", "review", "story-cards.md");
}

const TITLE = "# Story cards";
const RESULTS = ["pass", "fail", "unclear"];

function flat(s: string): string {
  return s
    .split(/\r?\n/)
    .map((x) => x.trim())
    .filter(Boolean)
    .join(" ");
}

// ---- ACCEPTANCE.md → cards

const BLOCK = /^\*\*(M\d+) [—–-] (.+)\*\*\s*$/;
const BOLD_LINE = /^\*\*.*\*\*\s*$/;
const CHECKBOX = /^- \[[ xX]\] (.+)$/;
const BULLET = /^- (.+)$/;
const STEP = /^\d+[.)] (.+)$/;
const FENCE = /^\s*(```|~~~)/;

function itemCard(id: string, text: string): Card {
  const sentence = text.match(/^(.+?[.!?])\s+(.+)$/);
  const title = (sentence ? (sentence[1] ?? "") : text).replace(/[.!?]$/, "").trim();
  return { id, title, description: sentence ? (sentence[2] ?? "").trim() : "", criteria: [text], result: null, note: "" };
}

export function cardsFromAcceptance(markdown: string): Card[] {
  const lines = markdown.split("\n").map((l) => l.replace(/\r$/, ""));
  const cards: Card[] = [];
  const used = new Set<string>();
  const unique = (id: string) => {
    let out = id;
    for (let k = 2; used.has(out); k++) out = `${id}-${k}`;
    used.add(out);
    return out;
  };
  let section = "";
  let items = 0;
  let block: Card | undefined;
  let fenced = false;

  for (const s of lines) {
    if (FENCE.test(s)) {
      fenced = !fenced;
      continue;
    }
    if (fenced) continue;
    if (s.startsWith("#")) {
      section = (s.match(/^#+\s*(.*)$/)?.[1] ?? "").trim().toLowerCase();
      block = undefined;
      continue;
    }
    const m = s.match(BLOCK);
    if (m) {
      block = { id: unique(m[1] ?? ""), title: (m[2] ?? "").trim(), description: "", criteria: [], result: null, note: "" };
      cards.push(block);
      continue;
    }
    if (BOLD_LINE.test(s)) {
      block = undefined;
      continue;
    }
    if (block) {
      const step = s.match(STEP);
      if (step) block.criteria.push((step[1] ?? "").trim());
      else if (s.trim() && !block.description && !block.criteria.length && !s.startsWith(" ") && !s.startsWith("-")) block.description = s.trim();
      continue;
    }
    const box = s.match(CHECKBOX);
    const plain = section === "behavior" ? s.match(BULLET) : null;
    const text = ((box ?? plain)?.[1] ?? "").trim();
    if (text) cards.push(itemCard(unique(`C${++items}`), text));
  }
  return cards;
}

// ---- story-cards.md

const HEAD = /^## (\S+) · (.+)$/;
const RESULT_LINE = /^Result: (none|pass|fail|unclear)$/;

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
      if (s.startsWith("## ")) open = { start: i, end: lines.length };
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

function parseCards(text: string): { cards: Card[]; problems: CardProblem[]; blocks: { block: Block; card: Card }[]; lines: string[] } {
  const lines = text.split("\n").map((l) => l.replace(/\r$/, ""));
  const cards: Card[] = [];
  const problems: CardProblem[] = [];
  const read: { block: Block; card: Card }[] = [];

  for (const b of blocks(lines)) {
    const heading = lines[b.start] ?? "";
    const bad = (reason: string) => problems.push({ line: b.start + 1, text: `${heading} — ${reason}` });
    const m = heading.match(HEAD);
    if (!m) {
      bad("the heading is not '## id · title'");
      continue;
    }
    const id = m[1] ?? "";
    if (cards.some((c) => c.id === id)) {
      bad(`card ${id} is used twice`);
      continue;
    }
    const r = lineOf(lines, b, "Result");
    const res = r < 0 ? null : (lines[r] ?? "").match(RESULT_LINE);
    if (r >= 0 && !res) {
      bad("the 'Result:' line must be none, pass, fail or unclear");
      continue;
    }
    const word = res?.[1] ?? "none";
    const d = lineOf(lines, b, "Description");
    const n = lineOf(lines, b, "Note");
    const criteria: string[] = [];
    for (let i = b.start + 1; i < b.end; i++) {
      const s = lines[i] ?? "";
      if (s.startsWith("- ") && s.slice(2).trim()) criteria.push(s.slice(2).trim());
    }
    const card: Card = {
      id,
      title: (m[2] ?? "").trim(),
      description: d < 0 ? "" : (lines[d] ?? "").slice("Description:".length).trim(),
      criteria,
      result: word === "none" ? null : (word as CardResult),
      note: n < 0 ? "" : (lines[n] ?? "").slice("Note:".length).trim(),
    };
    cards.push(card);
    read.push({ block: b, card });
  }
  return { cards, problems, blocks: read, lines };
}

function cardText(c: Card): string {
  const id = flat(c.id);
  if (!/^\S+$/.test(id)) throw new CardError(`a card id must be one word: ${c.id}`);
  const title = flat(c.title);
  if (!title) throw new CardError(`card ${id} needs a title`);
  if (c.result !== null && !RESULTS.includes(c.result)) throw new CardError(`bad result: ${String(c.result)}`);
  const field = (key: string, value: string) => (value ? `${key}: ${value}\n` : `${key}:\n`);
  let out = `\n## ${id} · ${title}\n` + field("Description", flat(c.description));
  for (const k of c.criteria) {
    const line = flat(k);
    if (line) out += `- ${line}\n`;
  }
  out += `Result: ${c.result ?? "none"}\n` + field("Note", flat(c.note));
  return out;
}

/** Writes all the cards, replacing the file. The engine does this when a review starts. */
export function writeCards(dir: string, cards: Card[]): void {
  const ids = new Set<string>();
  for (const c of cards) {
    if (ids.has(c.id)) throw new CardError(`card ${c.id} is used twice`);
    ids.add(c.id);
  }
  writeRunFile(cardsPath(dir), () => TITLE + "\n" + cards.map(cardText).join(""));
}

export function readCards(dir: string): { cards: Card[]; problems: CardProblem[] } {
  const file = cardsPath(dir);
  const { cards, problems } = parseCards(existsSync(file) ? readFileSync(file, "utf8") : "");
  return { cards, problems };
}

/** Sets the Result and Note lines of one block. The other lines are not touched. */
function setResult(lines: string[], b: Block, result: CardResult, note: string): void {
  const text = flat(note);
  const noteLine = text ? `Note: ${text}` : "Note:";
  const n = lineOf(lines, b, "Note");
  const r = lineOf(lines, b, "Result");
  if (n >= 0) lines[n] = noteLine;
  if (r >= 0) lines[r] = `Result: ${result}`;
  // A hand-written card may lack one of the two lines: add it after the last line of the entry.
  const add: string[] = [];
  if (r < 0) add.push(`Result: ${result}`);
  if (n < 0) add.push(noteLine);
  if (!add.length) return;
  let last = b.end - 1;
  while (last > b.start && (lines[last] ?? "") === "") last--;
  lines.splice(last + 1, 0, ...add);
}

/** The card runner's result for one card. */
export function recordCardResult(dir: string, id: string, result: CardResult, note: string): Card {
  if (!RESULTS.includes(result)) throw new CardError(`bad result: ${String(result)}; it must be pass, fail or unclear`);
  let made: Card | undefined;
  writeRunFile(cardsPath(dir), (old) => {
    const p = parseCards(old);
    const hit = p.blocks.find((x) => x.card.id === id);
    if (!hit) throw new CardError(`no card ${id}`);
    const lines = old.split("\n");
    setResult(lines, hit.block, result, note);
    const out = lines.join("\n");
    made = parseCards(out).cards.find((c) => c.id === id);
    return out;
  });
  if (!made) throw new CardError(`card ${id} did not parse after the result`);
  return made;
}

/**
 * Edge H2: the test environment is down. Every card with no result becomes `unclear`, with the reason.
 * It never sets `fail`: a card that did not run did not fail. A card with a result keeps it.
 * Returns how many cards it changed.
 */
export function markEnvironmentDown(dir: string, reason: string): number {
  if (!existsSync(cardsPath(dir))) return 0;
  let count = 0;
  writeRunFile(cardsPath(dir), (old) => {
    const p = parseCards(old);
    const lines = old.split("\n");
    // Bottom up, so a block that grows a line does not move the blocks above it.
    for (const { block, card } of [...p.blocks].reverse()) {
      if (card.result !== null) continue;
      setResult(lines, block, "unclear", reason);
      count++;
    }
    return count ? lines.join("\n") : old;
  });
  return count;
}

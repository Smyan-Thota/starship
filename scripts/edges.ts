/**
 * Edge checker.
 *
 * Reads the edge tables in docs/features/starship/PLAN.md. Each row names the test that proves it.
 *
 *   bun run edges          fails when a named test file is missing, or holds no test whose title starts with the row's number
 *   bun run edges --list   prints every row and where its test stands, and always exits 0
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";

const root = join(import.meta.dir, "..");
const plan = readFileSync(join(root, "docs", "features", "starship", "PLAN.md"), "utf8");

interface Row {
  id: string;
  condition: string;
  test: string;
}

const rows: Row[] = [];
for (const line of plan.split("\n")) {
  const cells = line.split("|").map((c) => c.trim());
  if (cells.length < 6) continue;
  const id = cells[1] ?? "";
  if (!/^[A-I]\d{1,2}$/.test(id)) continue;
  rows.push({ id, condition: cells[2] ?? "", test: cells[cells.length - 2] ?? "" });
}

function fileFor(test: string): string | null {
  for (const p of [
    join(root, "engine", "test", `${test}.ts`),
    join(root, "app", "test", `${test}.tsx`),
    join(root, "app", "test", `${test}.ts`),
  ]) {
    if (existsSync(p)) return p;
  }
  return null;
}

type State = "manual" | "proven" | "no file" | "no test";

function state(row: Row): State {
  if (/^M\d*$/.test(row.test)) return "manual";
  const file = fileFor(row.test);
  if (!file) return "no file";
  const text = readFileSync(file, "utf8");
  const title = new RegExp(`\\b(?:test|it)(?:\\.each\\([^]*?\\))?\\(\\s*["'\`][^"'\`]*\\b${row.id}\\b`);
  return title.test(text) ? "proven" : "no test";
}

const list = process.argv.includes("--list");
const result = rows.map((r) => ({ ...r, state: state(r) }));
const count = (s: State) => result.filter((r) => r.state === s).length;

if (list) {
  for (const r of result) console.log(`${r.id.padEnd(4)} ${r.state.padEnd(8)} ${r.test.padEnd(18)} ${r.condition}`);
}
console.log(`${rows.length} edge rows: ${count("proven")} proven, ${count("manual")} manual, ${count("no test")} with no test, ${count("no file")} with no test file`);

if (!rows.length) {
  console.error("No edge rows found in PLAN.md.");
  process.exit(1);
}
if (!list && count("no file") + count("no test") > 0) {
  for (const r of result) {
    if (r.state === "no file" || r.state === "no test") console.error(`${r.id}: ${r.state} (${r.test})`);
  }
  process.exit(1);
}

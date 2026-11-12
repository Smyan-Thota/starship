/**
 * Checks tasks off in Starship's own TASKS.md, through the same writer the engine uses.
 * Use it only after the task's verify command has passed.
 *
 *   bun scripts/check-off.ts T001 T002
 */
import { readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { checkTask, counts, parseTasks, serialize } from "../engine/src/folder/tasks.ts";

const file = join(import.meta.dir, "..", "docs", "features", "starship", "TASKS.md");
const ids = process.argv.slice(2);
if (!ids.length) {
  console.error("usage: bun scripts/check-off.ts T001 [T002 ...]");
  process.exit(1);
}
let doc = parseTasks(readFileSync(file, "utf8"), "docs/features/starship/TASKS.md");
for (const id of ids) doc = checkTask(doc, id);
writeFileSync(file, serialize(doc));
const c = counts(doc);
console.log(`checked ${ids.join(" ")} — ${c.verified} / ${c.total}`);

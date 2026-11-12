import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { appendNote, parseNotes } from "../src/folder/notes.ts";
import { FolderWatcher, PlanWatch, changedTaskIds, writeRunFile } from "../src/watch.ts";
import { drop, fixture, tempDir } from "./helpers.ts";

let root: string;
let watchers: FolderWatcher[];

beforeEach(() => {
  root = tempDir();
  watchers = [];
  mkdirSync(join(root, "run"), { recursive: true });
  mkdirSync(join(root, "wireframes"), { recursive: true });
  writeFileSync(join(root, "PLAN.md"), "# Plan\n");
  writeFileSync(join(root, "TASKS.md"), readFileSync(fixture("recipe-search", "TASKS.md"), "utf8"));
  writeFileSync(join(root, "wireframes", "search.html"), "<p>search</p>");
  writeFileSync(join(root, "run", "handoffs.md"), "# Handoffs\n");
});
afterEach(() => {
  for (const w of watchers) w.close();
  drop(root);
});

function watcher(onChange: (paths: string[]) => void): FolderWatcher {
  const w = new FolderWatcher(root, onChange);
  watchers.push(w);
  return w;
}

const nextChange = (calls: string[][], within = 1000) =>
  new Promise<string[]>((resolve, reject) => {
    const started = Date.now();
    const tick = () => {
      const c = calls.shift();
      if (c) return resolve(c);
      if (Date.now() - started > within) return reject(new Error("no change reported"));
      setTimeout(tick, 10);
    };
    tick();
  });

describe("FolderWatcher", () => {
  test("reports a change within 1 second, with the path relative to the root", async () => {
    const calls: string[][] = [];
    watcher((p) => calls.push(p));
    await Bun.sleep(50);
    const at = Date.now();
    writeFileSync(join(root, "run", "handoffs.md"), "# Handoffs\n\nchanged\n");
    const paths = await nextChange(calls);
    expect(Date.now() - at).toBeLessThan(1000);
    expect(paths).toContain("run/handoffs.md");
    expect(paths.every((p) => !p.startsWith("/"))).toBe(true);
  });

  test("a burst of writes is reported once, after the debounce", async () => {
    const calls: string[][] = [];
    watcher((p) => calls.push(p));
    await Bun.sleep(50);
    for (let i = 0; i < 5; i++) writeFileSync(join(root, "PLAN.md"), `# Plan ${i}\n`);
    writeFileSync(join(root, "SPEC.md"), "# Spec\n");
    const paths = await nextChange(calls);
    expect(paths).toContain("PLAN.md");
    expect(paths).toContain("SPEC.md");
    await Bun.sleep(200);
    expect(calls).toEqual([]);
  });

  test("close() stops it: no report after close, also for a change already pending", async () => {
    const calls: string[][] = [];
    const w = watcher((p) => calls.push(p));
    await Bun.sleep(50);
    writeFileSync(join(root, "PLAN.md"), "# Plan A\n");
    await Bun.sleep(20);
    w.close();
    writeFileSync(join(root, "PLAN.md"), "# Plan B\n");
    await Bun.sleep(300);
    expect(calls).toEqual([]);
    w.close();
  });
});

describe("writeRunFile", () => {
  test("C16: an engine write that follows a hand edit keeps the hand edit", () => {
    const file = join(root, "run", "handoffs.md");
    const engineCopy = readFileSync(file, "utf8");
    // The owner edits the file by hand after the engine last read it.
    writeFileSync(file, engineCopy + "\nHand-written line by the owner.\n");
    const add = (text: string) => appendNote(text, { at: "2026-11-11 15:30", stage: "build", to: "orchestrator", said: "dash", note: "Match with the dash." }).text;
    const out = writeRunFile(file, add);
    const disk = readFileSync(file, "utf8");
    expect(disk).toBe(out);
    expect(disk).toContain("Hand-written line by the owner.");
    expect(parseNotes(disk).notes.map((n) => n.note)).toEqual(["Match with the dash."]);
    expect(add(engineCopy)).not.toContain("Hand-written");
  });

  test("C16: a hand-added note keeps its number and the engine's note takes the next one", () => {
    const file = join(root, "run", "handoffs.md");
    writeFileSync(file, "# Handoffs\n\n## Note 4 · 2026-11-11 15:00 · plan → plan\nYou: x\nNote: By hand.\nStatus: queued\n");
    writeRunFile(file, (t) => appendNote(t, { at: "2026-11-11 15:31", stage: "plan", to: "plan", said: "y", note: "By engine." }).text);
    expect(parseNotes(readFileSync(file, "utf8")).notes.map((n) => [n.n, n.note])).toEqual([
      [4, "By hand."],
      [5, "By engine."],
    ]);
  });

  test("a missing file reads as empty text, and its folder is made", () => {
    const file = join(root, "run", "new", "questions.md");
    let seen: string | null = null;
    const out = writeRunFile(file, (t) => {
      seen = t;
      return "# Questions\n";
    });
    expect(seen as string | null).toBe("");
    expect(out).toBe("# Questions\n");
    expect(readFileSync(file, "utf8")).toBe("# Questions\n");
  });

  test("a change that throws leaves the file as it was and no temp file", () => {
    const file = join(root, "run", "handoffs.md");
    expect(() =>
      writeRunFile(file, () => {
        throw new Error("no");
      }),
    ).toThrow("no");
    expect(readFileSync(file, "utf8")).toBe("# Handoffs\n");
    expect(readdirSync(join(root, "run"))).toEqual(["handoffs.md"]);
  });

  test("leaves no temp file after a write", () => {
    writeRunFile(join(root, "run", "handoffs.md"), (t) => t + "x\n");
    expect(readdirSync(join(root, "run"))).toEqual(["handoffs.md"]);
  });
});

describe("PlanWatch", () => {
  test("C1: a hand change to PLAN.md shows up, and clears after markSeen", () => {
    const w = new PlanWatch(root);
    expect(w.handEdits()).toEqual([]);
    writeFileSync(join(root, "PLAN.md"), "# Plan\n\nA hand edit.\n");
    expect(w.handEdits()).toEqual(["PLAN.md"]);
    w.markSeen("PLAN.md");
    expect(w.handEdits()).toEqual([]);
  });

  test("C1: a run file never counts as a hand edit", () => {
    const w = new PlanWatch(root);
    writeFileSync(join(root, "run", "handoffs.md"), "# Handoffs\n\nchanged\n");
    writeFileSync(join(root, "run", "progress.md"), "# Progress\n");
    expect(w.handEdits()).toEqual([]);
    w.markSeen("run/handoffs.md");
    expect(w.handEdits()).toEqual([]);
  });

  test("C1: an added, a removed and a wireframe file count; writing the same bytes does not", () => {
    const w = new PlanWatch(root);
    writeFileSync(join(root, "PLAN.md"), "# Plan\n");
    expect(w.handEdits()).toEqual([]);
    writeFileSync(join(root, "SPEC.md"), "# Spec\n");
    rmSync(join(root, "TASKS.md"));
    writeFileSync(join(root, "wireframes", "search.html"), "<p>new</p>");
    expect(w.handEdits()).toEqual(["SPEC.md", "TASKS.md", "wireframes/search.html"]);
    w.markSeen("SPEC.md");
    w.markSeen("./TASKS.md");
    w.markSeen("wireframes/search.html");
    expect(w.handEdits()).toEqual([]);
  });

  test("C1: an edit after markSeen shows again", () => {
    const w = new PlanWatch(root);
    writeFileSync(join(root, "PLAN.md"), "# Plan 2\n");
    w.markSeen("PLAN.md");
    writeFileSync(join(root, "PLAN.md"), "# Plan 3\n");
    expect(w.handEdits()).toEqual(["PLAN.md"]);
  });

  test("a missing folder gives no hand edits and creates nothing", () => {
    const gone = join(root, "gone");
    const w = new PlanWatch(gone);
    expect(w.handEdits()).toEqual([]);
    expect(existsSync(gone)).toBe(false);
  });
});

describe("changedTaskIds", () => {
  const text = readFileSync(fixture("recipe-search", "TASKS.md"), "utf8");

  test("C3: a hand edit of a running task's line is flagged; a checkbox change is not", () => {
    const edited = text.replace("T022 [P] Numbers match with or without the dash", "T022 [P] Numbers match with or without the dash or a space");
    expect(changedTaskIds(text, edited)).toEqual(["T022"]);
    const checked = text.replace("- [ ] T022", "- [x] T022").replace("- [x] T001", "- [ ] T001");
    expect(changedTaskIds(text, checked)).toEqual([]);
    expect(changedTaskIds(text, checked.replace("- [x] T022", "- [X] T022"))).toEqual([]);
  });

  test("C3: added and removed tasks count", () => {
    const added = text.replace("- [ ] T024 Keyboard", "- [ ] T025 Focus ring — `a.tsx` — verify: `x`\n- [ ] T024 Keyboard");
    expect(changedTaskIds(text, added)).toEqual(["T025"]);
    const removed = text
      .split("\n")
      .filter((l) => !l.includes("T033"))
      .join("\n");
    expect(changedTaskIds(text, removed)).toEqual(["T033"]);
  });

  test("C3: same text gives nothing; CRLF and trailing spaces do not count; a text that does not parse still works", () => {
    expect(changedTaskIds(text, text)).toEqual([]);
    expect(changedTaskIds(text, text.replaceAll("\n", "\r\n"))).toEqual([]);
    expect(changedTaskIds("- [ ] T001 a  ", "- [ ] T001 a")).toEqual([]);
    expect(changedTaskIds("not a task file", "- [ ] T001 broken line with no verify")).toEqual(["T001"]);
    expect(changedTaskIds("", "")).toEqual([]);
  });
});

import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { FolderMissing, MAX_TEXT_BYTES, PathRefused, hasPlan, listFiles, readFileSafe, resolveInside } from "../src/folder/folder.ts";
import { drop, fixture, tempDir } from "./helpers.ts";

let base: string;
let root: string;

beforeEach(() => {
  base = tempDir();
  root = join(base, "docs", "features", "demo");
  mkdirSync(join(root, "run", "prompts"), { recursive: true });
  mkdirSync(join(root, "wireframes"), { recursive: true });
  writeFileSync(join(root, "PLAN.md"), "# Plan\n");
  writeFileSync(join(root, "TASKS.md"), "# Tasks\n");
  writeFileSync(join(root, "ACCEPTANCE.md"), "# Acceptance\n");
  writeFileSync(join(root, "notes for me.md"), "a file with spaces\n");
  writeFileSync(join(root, "run", "handoffs.md"), "# Handoffs\n");
  writeFileSync(join(root, "run", "prompts", "worker-a-T022-v1.md"), "Implement T022 only.\n");
  writeFileSync(join(root, "wireframes", "search.html"), "<h1>Search</h1>\n");
  writeFileSync(join(base, "secret.txt"), "outside the folder\n");
});
afterEach(() => drop(base));

describe("folder", () => {
  test("lists plan files first, in their order, then other plan files, then run files", () => {
    writeFileSync(join(root, "SPEC.md"), "# Spec\n");
    const files = listFiles(root);
    expect(files.map((f) => f.path)).toEqual([
      "SPEC.md",
      "PLAN.md",
      "TASKS.md",
      "ACCEPTANCE.md",
      "notes for me.md",
      "wireframes/search.html",
      "run/handoffs.md",
      "run/prompts/worker-a-T022-v1.md",
    ]);
    expect(files.filter((f) => f.kind === "run").map((f) => f.path)).toEqual(["run/handoffs.md", "run/prompts/worker-a-T022-v1.md"]);
    expect(files.find((f) => f.path === "wireframes/search.html")!.html).toBe(true);
    expect(files.every((f) => f.size > 0 && f.mtimeMs > 0 && !f.binary && !f.tooLarge)).toBe(true);
  });

  test("reads a file, also one with spaces in its name", () => {
    expect(readFileSafe(root, "PLAN.md").text).toBe("# Plan\n");
    expect(readFileSafe(root, "notes for me.md").text).toBe("a file with spaces\n");
    expect(readFileSafe(root, "run/prompts/worker-a-T022-v1.md").info.kind).toBe("run");
  });

  test("the sample folder lists and reads", () => {
    const files = listFiles(fixture("recipe-search"));
    expect(files.slice(0, 4).map((f) => f.path)).toEqual(["SPEC.md", "PLAN.md", "TASKS.md", "ACCEPTANCE.md"]);
    expect(files.some((f) => f.path === "run/handoffs.md")).toBe(true);
    expect(readFileSafe(fixture("recipe-search"), "SPEC.md").text).toContain("# SPEC");
    expect(hasPlan(fixture("recipe-search"))).toBe(true);
  });

  test("C4: a missing feature folder is reported, and nothing is created", () => {
    const gone = join(base, "docs", "features", "gone");
    expect(() => listFiles(gone)).toThrow(FolderMissing);
    expect(() => readFileSafe(gone, "PLAN.md")).toThrow("Feature folder missing");
    expect(hasPlan(gone)).toBe(false);
    expect(() => listFiles(gone)).toThrow(FolderMissing);
  });

  test("C4: a file where the folder should be is also 'missing'", () => {
    expect(() => listFiles(join(root, "PLAN.md"))).toThrow(FolderMissing);
  });

  test("C8: a binary file gives its name, kind and size, and no text", () => {
    writeFileSync(join(root, "run", "shot.png"), Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x00, 0x01, 0x02]));
    const r = readFileSafe(root, "run/shot.png");
    expect(r.text).toBeNull();
    expect(r.info).toMatchObject({ path: "run/shot.png", kind: "run", binary: true, size: 7 });
    expect(listFiles(root).find((f) => f.path === "run/shot.png")!.binary).toBe(true);
  });

  test("C8: a file over 1 MB gives its size, and no text", () => {
    writeFileSync(join(root, "run", "big.log"), "x".repeat(MAX_TEXT_BYTES + 1));
    const r = readFileSafe(root, "run/big.log");
    expect(r.text).toBeNull();
    expect(r.info).toMatchObject({ tooLarge: true, binary: false, size: MAX_TEXT_BYTES + 1 });
  });

  test("C8: an empty file is text", () => {
    writeFileSync(join(root, "empty.md"), "");
    expect(readFileSafe(root, "empty.md")).toMatchObject({ text: "", info: { binary: false, size: 0 } });
  });

  test.each([
    ["../../../secret.txt", "leaves the feature folder"],
    ["run/../../../../secret.txt", "leaves the feature folder"],
    ["/etc/hosts", "inside the feature folder"],
    ["", "not a path"],
    ["PLAN.md\0.png", "not a path"],
    ["nope.md", "no such file"],
    ["run", "is not a file"],
  ])("C10: the path %j is refused", (rel, word) => {
    expect(() => readFileSafe(root, rel)).toThrow(PathRefused);
    expect(() => readFileSafe(root, rel)).toThrow(word);
  });

  test("C10: a link that leaves the folder is refused, and is not listed", () => {
    symlinkSync(join(base, "secret.txt"), join(root, "run", "leak.md"));
    symlinkSync(base, join(root, "run", "up"));
    expect(() => readFileSafe(root, "run/leak.md")).toThrow("is a link that leaves the feature folder");
    expect(() => readFileSafe(root, "run/up/secret.txt")).toThrow(PathRefused);
    const paths = listFiles(root).map((f) => f.path);
    expect(paths).not.toContain("run/leak.md");
    expect(paths.some((p) => p.startsWith("run/up"))).toBe(false);
  });

  test("C10: a link that stays inside the folder is fine", () => {
    symlinkSync(join(root, "PLAN.md"), join(root, "run", "plan-link.md"));
    expect(readFileSafe(root, "run/plan-link.md").text).toBe("# Plan\n");
    expect(listFiles(root).map((f) => f.path)).toContain("run/plan-link.md");
  });

  test("C10: a broken link is skipped", () => {
    symlinkSync(join(root, "not-there.md"), join(root, "run", "broken.md"));
    expect(listFiles(root).map((f) => f.path)).not.toContain("run/broken.md");
    expect(() => resolveInside(root, "run/broken.md")).toThrow("no such file");
  });

  test("hasPlan needs PLAN, TASKS and ACCEPTANCE", () => {
    expect(hasPlan(root)).toBe(true);
    const bare = join(base, "bare");
    mkdirSync(bare);
    writeFileSync(join(bare, "PLAN.md"), "x");
    expect(hasPlan(bare)).toBe(false);
  });
});

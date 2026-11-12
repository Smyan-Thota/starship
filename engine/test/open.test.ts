import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, symlinkSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { PathRefused } from "../src/folder/folder.ts";
import { OpenRefused, type Runner, fileBody, openFolderFile, openTarget } from "../src/open.ts";
import { drop, fixture, tempDir } from "./helpers.ts";

let base: string;
let root: string;
let calls: string[][];
const run: Runner = (cmd) => {
  calls.push(cmd);
};

beforeEach(() => {
  calls = [];
  base = tempDir();
  root = join(base, "feature");
  mkdirSync(join(root, "wireframes"), { recursive: true });
  writeFileSync(join(root, "wireframes", "search.html"), "<script>alert(1)</script>");
  writeFileSync(join(root, "page.HTM"), "<p>old</p>");
  writeFileSync(join(root, "PLAN.md"), "# Plan\n");
  writeFileSync(join(base, "outside.html"), "<p>outside</p>");
  symlinkSync(join(base, "outside.html"), join(root, "link.html"));
});
afterEach(() => drop(base));

describe("open", () => {
  test("C12: an .html file is never returned as text; it opens in the browser", () => {
    const body = fileBody(root, "wireframes/search.html");
    expect(body.text).toBeNull();
    expect(body.open).toBe(true);
    expect(body.info.html).toBe(true);
    expect(fileBody(root, "page.HTM")).toMatchObject({ text: null, open: true });
    expect(calls).toEqual([]);
    openFolderFile(root, "wireframes/search.html", run);
    expect(calls).toEqual([["open", join(root, "wireframes", "search.html")]]);
  });

  test("C12: the sample wireframe is not text and opens", () => {
    expect(fileBody(fixture("recipe-search"), "wireframes/search.html")).toMatchObject({ text: null, open: true });
    openFolderFile(fixture("recipe-search"), "wireframes/search.html", run);
    expect(calls[0]?.[1]).toEndWith("wireframes/search.html");
  });

  test("a Markdown file comes back as text and does not open", () => {
    expect(fileBody(root, "PLAN.md")).toMatchObject({ text: "# Plan\n", open: false });
  });

  test("opens an http: or https: address", () => {
    openTarget("https://claude.ai/artifact/abc", run);
    openTarget("http://127.0.0.1:8787/x?y=1", run);
    expect(calls).toEqual([
      ["open", "https://claude.ai/artifact/abc"],
      ["open", "http://127.0.0.1:8787/x?y=1"],
    ]);
  });

  test("opens an absolute path to a file that exists", () => {
    openTarget(join(root, "PLAN.md"), run);
    expect(calls).toEqual([["open", join(root, "PLAN.md")]]);
  });

  test("refuses every scheme except http and https", () => {
    for (const t of ["file:///etc/passwd", "javascript:alert(1)", "data:text/html,<b>x</b>", "ftp://x.example/a", "smb://host/share", "vscode://file/x", "JAVASCRIPT:alert(1)", "about:blank", "mailto:a@b.c"]) {
      expect(() => openTarget(t, run)).toThrow(OpenRefused);
    }
    expect(calls).toEqual([]);
  });

  test("refuses a relative path, an option, an empty target, a missing file and a folder", () => {
    for (const t of ["PLAN.md", "./PLAN.md", "../x", "-a Calculator", "", "/no/such/file.html", root, "/tmp/x\nhttps://evil"]) {
      expect(() => openTarget(t, run)).toThrow(OpenRefused);
    }
    expect(calls).toEqual([]);
  });

  test("openFolderFile refuses a path that leaves the folder, also through a symlink", () => {
    expect(() => openFolderFile(root, "../outside.html", run)).toThrow(PathRefused);
    expect(() => openFolderFile(root, join(base, "outside.html"), run)).toThrow(PathRefused);
    expect(() => openFolderFile(root, "link.html", run)).toThrow(PathRefused);
    expect(() => openFolderFile(root, "missing.html", run)).toThrow(PathRefused);
    expect(() => fileBody(root, "../outside.html")).toThrow(PathRefused);
    expect(calls).toEqual([]);
  });
});

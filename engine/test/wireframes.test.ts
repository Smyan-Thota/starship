import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { listWireframes, setWireframeLink, wireframeProblems } from "../src/wireframes.ts";
import { drop, tempDir } from "./helpers.ts";

let feat: string;
let dir: string;
const links = () => join(dir, "links.json");
const html = (name: string) => writeFileSync(join(dir, `${name}.html`), `<h1>${name} SECRET-BODY</h1>`);

beforeEach(() => {
  feat = tempDir();
  dir = join(feat, "wireframes");
  mkdirSync(dir);
});
afterEach(() => drop(feat));

describe("listWireframes", () => {
  test("no wireframes folder gives an empty list", () => {
    expect(listWireframes(join(feat, "nowhere"))).toEqual([]);
  });

  test("one entry per html file, sorted, with its relative path and no link", () => {
    html("home");
    html("detail");
    writeFileSync(join(dir, "notes.txt"), "x");
    expect(listWireframes(feat)).toEqual([
      { name: "detail", file: "wireframes/detail.html", link: null },
      { name: "home", file: "wireframes/home.html", link: null },
    ]);
  });

  test("the link comes from links.json", () => {
    html("home");
    html("detail");
    writeFileSync(links(), JSON.stringify({ home: "https://claude.ai/artifact/abc" }));
    expect(listWireframes(feat)).toEqual([
      { name: "detail", file: "wireframes/detail.html", link: null },
      { name: "home", file: "wireframes/home.html", link: "https://claude.ai/artifact/abc" },
    ]);
  });

  test("it returns names and paths, never the HTML text", () => {
    html("home");
    expect(JSON.stringify(listWireframes(feat))).not.toContain("SECRET-BODY");
  });

  test("a link for a wireframe that does not exist is not listed", () => {
    html("home");
    writeFileSync(links(), JSON.stringify({ ghost: "https://example.com/x" }));
    expect(listWireframes(feat).map((w) => w.name)).toEqual(["home"]);
  });

  test.each([
    ["not JSON", "{oops"],
    ["an array", "[]"],
    ["a nested object", '{"home":{"url":"https://x.test"}}'],
    ["a number value", '{"home":3}'],
    ["null", "null"],
  ])("links.json that is %s means no links, plus one problem line, and no throw", (_what, body) => {
    html("home");
    writeFileSync(links(), body);
    expect(listWireframes(feat)).toEqual([{ name: "home", file: "wireframes/home.html", link: null }]);
    const ps = wireframeProblems(feat);
    expect(ps).toHaveLength(1);
    expect(ps[0]).toMatch(/links\.json/);
  });

  test("a good or absent links.json has no problem line", () => {
    html("home");
    expect(wireframeProblems(feat)).toEqual([]);
    writeFileSync(links(), "{}");
    expect(wireframeProblems(feat)).toEqual([]);
  });
});

describe("setWireframeLink", () => {
  test("writes the link, and listWireframes shows it", () => {
    html("home");
    setWireframeLink(feat, "home", "https://claude.ai/artifact/abc");
    expect(JSON.parse(readFileSync(links(), "utf8"))).toEqual({ home: "https://claude.ai/artifact/abc" });
    expect(listWireframes(feat)[0]?.link).toBe("https://claude.ai/artifact/abc");
  });

  test("http is allowed too, and a new link replaces the old one", () => {
    html("home");
    setWireframeLink(feat, "home", "http://localhost:3000/x");
    setWireframeLink(feat, "home", "https://example.com/y");
    expect(JSON.parse(readFileSync(links(), "utf8"))).toEqual({ home: "https://example.com/y" });
  });

  test("other links stay", () => {
    html("home");
    html("detail");
    setWireframeLink(feat, "home", "https://a.test/1");
    setWireframeLink(feat, "detail", "https://a.test/2");
    expect(JSON.parse(readFileSync(links(), "utf8"))).toEqual({ home: "https://a.test/1", detail: "https://a.test/2" });
  });

  test("a wireframe that does not exist is refused, and nothing is written", () => {
    html("home");
    expect(() => setWireframeLink(feat, "ghost", "https://a.test/1")).toThrow();
    expect(existsSync(links())).toBe(false);
  });

  test.each(["javascript:alert(1)", "file:///etc/passwd", "ftp://a.test/x", "claude.ai/artifact/abc", "", "https://", "https://a b.test"])(
    "the URL %p is refused",
    (url) => {
      html("home");
      expect(() => setWireframeLink(feat, "home", url)).toThrow();
      expect(existsSync(links())).toBe(false);
    },
  );

  test.each(["../home", "a/b", "", ".."])("the name %p is refused", (name) => {
    html("home");
    expect(() => setWireframeLink(feat, name, "https://a.test/1")).toThrow();
  });

  test("it reads links.json again before the write, so a hand edit stays", () => {
    html("home");
    html("detail");
    setWireframeLink(feat, "home", "https://a.test/1");
    writeFileSync(links(), JSON.stringify({ home: "https://a.test/1", detail: "https://hand.test/edit" }));
    setWireframeLink(feat, "home", "https://a.test/2");
    expect(JSON.parse(readFileSync(links(), "utf8"))).toEqual({ home: "https://a.test/2", detail: "https://hand.test/edit" });
  });

  test("it leaves no temp file behind", () => {
    html("home");
    setWireframeLink(feat, "home", "https://a.test/1");
    expect(readdirSync(dir).sort()).toEqual(["home.html", "links.json"]);
  });

  test("a links.json that is broken is refused, not overwritten", () => {
    html("home");
    writeFileSync(links(), "{oops");
    expect(() => setWireframeLink(feat, "home", "https://a.test/1")).toThrow(/links\.json/);
    expect(readFileSync(links(), "utf8")).toBe("{oops");
  });
});

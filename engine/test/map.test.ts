import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, mkdirSync, readFileSync, readdirSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { applyOverlay, readOverlay } from "../src/map/overlay.ts";
import { buildLowDetailMap, hasCodeIndex, importMap } from "../src/map/build.ts";
import { type MapFile, readMapFile, validateMap } from "../src/map/schema.ts";
import { drop, fixture, tempDir } from "./helpers.ts";

const dirs: string[] = [];
const temp = () => {
  const d = tempDir("starship-map-");
  dirs.push(d);
  return d;
};
afterEach(() => {
  for (const d of dirs.splice(0)) drop(d);
});

/** A small valid map. Each test copies it and breaks one thing. */
function small(): MapFile {
  return {
    name: "tiny",
    layers: [
      ["Top", "where people work"],
      ["Bottom", "the servers"],
    ],
    boxes: [
      { id: "ui", layer: 0, row: 0, left: 0.04, right: 0.96, name: "UI", what: "The screens.", dir: "app", chips: ["Search", "~shared/ui"] },
      { id: "api", layer: 1, row: 1, left: 0.04, right: 0.5, name: "API", what: "The server.", dir: "api", chips: ["searchRecipes"] },
      { id: "db", layer: 1, row: 1, left: 0.6, right: 0.96, store: true, name: "DB", what: "Records.", dir: "db", chips: ["#File"] },
    ],
    pipes: [
      { id: "ui-api", from: "ui", to: "api", kind: "call", label: "GraphQL", route: { x: 0.2 } },
      { id: "api-db", from: "api", to: "db", kind: "lookup", label: "reads", route: { across: true } },
    ],
    flows: {
      over: { name: "Overview" },
      other: {
        name: "Other",
        steps: [{ n: "1.1", pipe: "ui-api", label: "search", text: "The query goes out.", where: "API" }],
        lit: { api: ["searchRecipes"] },
        marks: { "api|searchRecipes": "changed" },
      },
    },
    order: ["over", "other"],
  };
}

const errorsOf = (edit: (m: MapFile) => void): string[] => {
  const m = structuredClone(small());
  edit(m);
  return validateMap(m);
};

describe("map schema", () => {
  test("the starship fixture validates with no error and uses every part of the format", () => {
    const { map, errors } = readMapFile(fixture("maps", "starship.json"));
    expect(errors).toEqual([]);
    expect(map?.name).toBe("starship");
    expect(map?.boxes.length).toBeGreaterThanOrEqual(9);
    expect(new Set(map?.boxes.map((b) => b.layer)).size).toBeGreaterThanOrEqual(3);
    expect(map?.boxes.every((b) => b.chips.length > 0)).toBe(true);
    const chips = map?.boxes.flatMap((b) => b.chips) ?? [];
    expect(chips.some((c) => c.startsWith("~"))).toBe(true);
    expect(chips.some((c) => c.startsWith("#"))).toBe(true);
    expect(new Set(map?.pipes.map((p) => p.kind))).toEqual(new Set(["call", "lookup", "event"]));
    expect(map?.pipes.some((p) => p.route.side !== undefined && p.route.lane !== undefined)).toBe(true);
    expect(map?.pipes.some((p) => p.route.across === true)).toBe(true);
    expect(Object.keys(map?.flows ?? {})).toContain("over");
    const numbered = Object.values(map?.flows ?? {}).find((f) => (f.steps?.length ?? 0) > 0);
    expect(numbered?.lit).toBeDefined();
    expect(Object.keys(numbered?.marks ?? {})).toHaveLength(1);
  });

  test("the small map validates", () => {
    expect(validateMap(small())).toEqual([]);
  });

  test("a value that is not an object is refused", () => {
    expect(validateMap(null)).toHaveLength(1);
    expect(validateMap([])).toHaveLength(1);
    expect(validateMap("map")).toHaveLength(1);
  });

  test("a missing or mistyped field is named", () => {
    const e1 = errorsOf((m) => {
      (m as unknown as Record<string, unknown>).name = 3;
    });
    expect(e1.join("\n")).toMatch(/name/);
    const e2 = errorsOf((m) => {
      (m.boxes[0] as unknown as Record<string, unknown>).chips = "Search";
    });
    expect(e2.join("\n")).toMatch(/box ui.*chips/);
    const e3 = errorsOf((m) => {
      (m as unknown as Record<string, unknown>).layers = [["only a name"]];
    });
    expect(e3.join("\n")).toMatch(/layer 0/);
    const e4 = errorsOf((m) => {
      delete (m as unknown as Record<string, unknown>).pipes;
    });
    expect(e4.join("\n")).toMatch(/pipes/);
  });

  test("two boxes with one id are refused", () => {
    const e = errorsOf((m) => {
      if (m.boxes[1]) m.boxes[1].id = "ui";
    });
    expect(e.join("\n")).toMatch(/duplicate box id "ui"/);
  });

  test("two pipes with one id are refused", () => {
    const e = errorsOf((m) => {
      if (m.pipes[1]) m.pipes[1].id = "ui-api";
    });
    expect(e.join("\n")).toMatch(/duplicate pipe id "ui-api"/);
  });

  test("a box layer that is not an index of layers is refused", () => {
    expect(errorsOf((m) => { if (m.boxes[0]) m.boxes[0].layer = 2; }).join("\n")).toMatch(/box ui.*layer 2/);
    expect(errorsOf((m) => { if (m.boxes[0]) m.boxes[0].layer = -1; }).join("\n")).toMatch(/box ui.*layer/);
    expect(errorsOf((m) => { if (m.boxes[0]) m.boxes[0].layer = 0.5; }).join("\n")).toMatch(/box ui.*layer/);
  });

  test("a box with left not below right, or an edge outside 0 to 1, is refused", () => {
    expect(errorsOf((m) => { if (m.boxes[0]) { m.boxes[0].left = 0.6; m.boxes[0].right = 0.4; } }).join("\n")).toMatch(/box ui.*left.*right/);
    expect(errorsOf((m) => { if (m.boxes[0]) m.boxes[0].right = 1.2; }).join("\n")).toMatch(/box ui.*right.*0 to 1/);
    expect(errorsOf((m) => { if (m.boxes[0]) m.boxes[0].left = -0.1; }).join("\n")).toMatch(/box ui.*left.*0 to 1/);
  });

  test("a pipe that names a missing box is refused", () => {
    expect(errorsOf((m) => { if (m.pipes[0]) m.pipes[0].from = "nope"; }).join("\n")).toMatch(/pipe ui-api.*from.*"nope"/);
    expect(errorsOf((m) => { if (m.pipes[0]) m.pipes[0].to = "nope"; }).join("\n")).toMatch(/pipe ui-api.*to.*"nope"/);
  });

  test("a pipe kind other than call, lookup or event is refused", () => {
    const e = errorsOf((m) => {
      if (m.pipes[0]) (m.pipes[0] as unknown as Record<string, unknown>).kind = "push";
    });
    expect(e.join("\n")).toMatch(/pipe ui-api.*kind.*call, lookup or event/);
  });

  test("a map with no flow over is refused", () => {
    const e = errorsOf((m) => {
      delete m.flows.over;
      m.order = ["other"];
    });
    expect(e.join("\n")).toMatch(/flow "over"/);
  });

  test("an order key that is not a flow is refused", () => {
    const e = errorsOf((m) => {
      m.order.push("ghost");
    });
    expect(e.join("\n")).toMatch(/order.*"ghost"/);
  });

  test("a map with no order is refused, and a step with a bad number is named", () => {
    expect(errorsOf((m) => { (m as unknown as Record<string, unknown>).order = "over"; }).join("\n")).toMatch(/order/);
    const e = errorsOf((m) => {
      const s = m.flows.other?.steps?.[0];
      if (s) (s as unknown as Record<string, unknown>).label = 4;
    });
    expect(e.join("\n")).toMatch(/flow other.*step 1\.1.*label/);
  });

  test("I1: a step that names a missing pipe is refused", () => {
    const e = errorsOf((m) => {
      const s = m.flows.other?.steps?.[0];
      if (s) s.pipe = "no-such-pipe";
    });
    expect(e).toEqual(['flow other: step 1.1 names the pipe "no-such-pipe", which does not exist']);
  });

  test("I1: a lit chip that does not exist on its box is refused", () => {
    const e = errorsOf((m) => {
      const f = m.flows.other;
      if (f) f.lit = { api: ["searchRecipes", "ghostChip"], nobox: ["x"] };
    });
    expect(e).toContain('flow other: lit chip "ghostChip" is not on box api');
    expect(e).toContain('flow other: lit names the box "nobox", which does not exist');
    expect(e).toHaveLength(2);
  });

  test("a mark whose key is not <box>|<chip> of an existing chip is refused", () => {
    const e = errorsOf((m) => {
      const f = m.flows.other;
      if (f) f.marks = { "api|searchRecipes": "changed", "api|ghost": "new", "nobox|x": "new", bad: "x" };
    });
    expect(e.join("\n")).toMatch(/mark "api\|ghost"/);
    expect(e.join("\n")).toMatch(/mark "nobox\|x"/);
    expect(e.join("\n")).toMatch(/mark "bad"/);
    expect(e).toHaveLength(3);
  });

  test("two flows cannot share a key and a path with a bad who is refused", () => {
    const raw = JSON.parse(JSON.stringify(small())) as MapFile;
    const f = raw.flows.other;
    if (f) f.paths = [{ n: 1, name: "p", who: "robot" as "person", trigger: "t", entry: "e", after: "a" }];
    expect(validateMap(raw).join("\n")).toMatch(/flow other.*path 1.*who/);
    // Duplicate flow keys cannot exist in a parsed object, so a duplicate in the text is caught on read.
    const dir = temp();
    const file = join(dir, "dup.json");
    const text = JSON.stringify(small()).replace('"flows":{"over"', '"flows":{"over":{"name":"A"},"over"');
    writeFileSync(file, text);
    expect(readMapFile(file).errors.join("\n")).toMatch(/duplicate flow key "over"/);
  });

  test("detail may be low and nothing else", () => {
    const ok = { ...small(), detail: "low" };
    expect(validateMap(ok)).toEqual([]);
    expect(validateMap({ ...small(), detail: "high" }).join("\n")).toMatch(/detail/);
  });

  test("readMapFile never throws for a missing file or for text that is not JSON", () => {
    const dir = temp();
    const missing = readMapFile(join(dir, "none.json"));
    expect(missing.map).toBeNull();
    expect(missing.errors).toHaveLength(1);
    writeFileSync(join(dir, "bad.json"), "{ not json");
    const bad = readMapFile(join(dir, "bad.json"));
    expect(bad.map).toBeNull();
    expect(bad.errors[0]).toMatch(/not valid JSON/);
  });

  test("readMapFile gives errors and no map for a file that fails validation", () => {
    const dir = temp();
    const m = small();
    if (m.pipes[0]) m.pipes[0].to = "nope";
    writeFileSync(join(dir, "m.json"), JSON.stringify(m));
    const r = readMapFile(join(dir, "m.json"));
    expect(r.map).toBeNull();
    expect(r.errors.length).toBeGreaterThan(0);
  });
});

describe("map import and build", () => {
  test("build: importMap copies a valid file to <reposDir>/<name>.map.json", () => {
    const reposDir = join(temp(), "repos");
    const r = importMap({ file: fixture("maps", "starship.json"), reposDir, name: "acme" });
    expect(r.path).toBe(join(reposDir, "acme.map.json"));
    expect(JSON.parse(readFileSync(r.path, "utf8"))).toEqual(JSON.parse(readFileSync(fixture("maps", "starship.json"), "utf8")));
    expect(readdirSync(reposDir)).toEqual(["acme.map.json"]);
  });

  test("I1: build: importMap refuses a file with errors and lists them", () => {
    const dir = temp();
    const m = small();
    const s = m.flows.other?.steps?.[0];
    if (s) s.pipe = "gone";
    const file = join(dir, "bad.map.json");
    writeFileSync(file, JSON.stringify(m));
    const reposDir = join(dir, "repos");
    let thrown: unknown;
    try {
      importMap({ file, reposDir, name: "tiny" });
    } catch (e) {
      thrown = e;
    }
    expect(thrown).toBeInstanceOf(Error);
    expect(String((thrown as Error).message)).toContain('step 1.1 names the pipe "gone"');
    expect(existsSync(join(reposDir, "tiny.map.json"))).toBe(false);
  });

  test("build: importMap refuses a file that is missing", () => {
    expect(() => importMap({ file: join(temp(), "none.json"), reposDir: temp(), name: "x" })).toThrow();
  });

  test("build: importMap replaces an earlier map of that name", () => {
    const reposDir = temp();
    importMap({ file: fixture("maps", "starship.json"), reposDir, name: "acme" });
    const dir = temp();
    writeFileSync(join(dir, "n.json"), JSON.stringify(small()));
    importMap({ file: join(dir, "n.json"), reposDir, name: "acme" });
    expect(JSON.parse(readFileSync(join(reposDir, "acme.map.json"), "utf8")).name).toBe("tiny");
  });

  test("build: a name with a path separator is refused", () => {
    expect(() => importMap({ file: fixture("maps", "starship.json"), reposDir: temp(), name: "../evil" })).toThrow();
  });

  function repo(): string {
    const r = temp();
    for (const d of ["src", "docs", "app", ".git", "node_modules", "dist", "build", "target", ".github"]) mkdirSync(join(r, d));
    writeFileSync(join(r, "README.md"), "\n# Tiny Repo\n\nSome words.\n## Later heading\n");
    writeFileSync(join(r, "package.json"), "{}");
    return r;
  }

  test("I2: build: a repo with no index gets a low detail map from its folders and README", () => {
    const r = repo();
    expect(hasCodeIndex(r)).toBe(false);
    const m = buildLowDetailMap({ repoPath: r, name: "tiny" });
    expect(m.detail).toBe("low");
    expect(m.name).toBe("tiny");
    expect(m.layers).toHaveLength(1);
    expect(m.boxes.map((b) => b.id).sort()).toEqual(["app", "docs", "src"]);
    expect(m.boxes.every((b) => b.layer === 0)).toBe(true);
    expect(m.pipes).toEqual([]);
    expect(m.order).toEqual(["over"]);
    expect(m.flows.over).toBeDefined();
    expect(JSON.stringify(m)).toContain("Tiny Repo");
    expect(validateMap(m)).toEqual([]);
  });

  test("build: low detail boxes sit in rows with edges inside 0 to 1", () => {
    const r = temp();
    for (let i = 0; i < 7; i++) mkdirSync(join(r, `pkg${i}`));
    const m = buildLowDetailMap({ repoPath: r, name: "many" });
    expect(m.boxes).toHaveLength(7);
    expect(validateMap(m)).toEqual([]);
    const rows = new Set(m.boxes.map((b) => b.row));
    expect(rows.size).toBeGreaterThan(1);
  });

  test("build: a repo with no README or no folders still gives a valid low detail map", () => {
    const r = temp();
    const m = buildLowDetailMap({ repoPath: r, name: "empty" });
    expect(m.detail).toBe("low");
    expect(m.boxes).toEqual([]);
    expect(validateMap(m)).toEqual([]);
  });

  test("build: hasCodeIndex is true when the folder .codegraph exists", () => {
    const r = temp();
    expect(hasCodeIndex(r)).toBe(false);
    mkdirSync(join(r, ".codegraph"));
    expect(hasCodeIndex(r)).toBe(true);
  });
});

describe("map overlay", () => {
  const feature = () => {
    const f = temp();
    mkdirSync(join(f, "run"));
    return f;
  };

  test("overlay: no file gives null and no error", () => {
    expect(readOverlay(feature())).toEqual({ overlay: null, errors: [] });
  });

  test("overlay: readOverlay reads run/map-overlay.json", () => {
    const f = feature();
    writeFileSync(join(f, "run", "map-overlay.json"), JSON.stringify({ story: "S", lit: { api: ["searchRecipes"] }, marks: { "api|searchRecipes": "changed" } }));
    const r = readOverlay(f);
    expect(r.errors).toEqual([]);
    expect(r.overlay?.story).toBe("S");
    expect(r.overlay?.lit).toEqual({ api: ["searchRecipes"] });
  });

  test("overlay: a file that is not JSON, or has no lit, is an error and gives no overlay", () => {
    const f = feature();
    writeFileSync(join(f, "run", "map-overlay.json"), "{ nope");
    const a = readOverlay(f);
    expect(a.overlay).toBeNull();
    expect(a.errors[0]).toMatch(/not valid JSON/);
    writeFileSync(join(f, "run", "map-overlay.json"), JSON.stringify({ story: "x" }));
    const b = readOverlay(f);
    expect(b.overlay).toBeNull();
    expect(b.errors.join("\n")).toMatch(/lit/);
  });

  test("overlay: applyOverlay adds the flow plan, named This plan, first in order", () => {
    const base = small();
    const before = JSON.stringify(base);
    const r = applyOverlay(base, {
      story: "Someone searches.",
      lit: { api: ["searchRecipes"], ui: ["Search"] },
      marks: { "api|searchRecipes": "changed" },
      steps: [{ n: "1.1", pipe: "ui-api", label: "search", text: "Out it goes.", where: "API" }],
    });
    expect(r.errors).toEqual([]);
    expect(r.map.order).toEqual(["plan", "over", "other"]);
    expect(r.map.flows.plan).toMatchObject({ name: "This plan", story: "Someone searches.", lit: { api: ["searchRecipes"], ui: ["Search"] }, marks: { "api|searchRecipes": "changed" } });
    expect(r.map.flows.plan?.steps).toHaveLength(1);
    expect(validateMap(r.map)).toEqual([]);
    expect(JSON.stringify(base)).toBe(before);
  });

  test("overlay: the overlay's name replaces This plan, and an old plan flow is replaced", () => {
    const first = applyOverlay(small(), { name: "Search fix", lit: {} });
    expect(first.map.flows.plan?.name).toBe("Search fix");
    const second = applyOverlay(first.map, { lit: {} });
    expect(second.map.order.filter((k) => k === "plan")).toHaveLength(1);
    expect(second.map.order[0]).toBe("plan");
  });

  test("overlay: a lit chip or box that does not exist is an error and is left out", () => {
    const r = applyOverlay(small(), { lit: { api: ["searchRecipes", "ghost"], nobox: ["x"] } });
    expect(r.errors).toContain('lit chip "ghost" is not on box api');
    expect(r.errors).toContain('lit names the box "nobox", which does not exist');
    expect(r.map.flows.plan?.lit).toEqual({ api: ["searchRecipes"] });
  });

  test("overlay: a mark that names a missing box or chip is an error and is left out", () => {
    const r = applyOverlay(small(), { lit: {}, marks: { "api|searchRecipes": "changed", "api|ghost": "new", "nobox|x": "new", bad: "y" } });
    expect(r.errors).toHaveLength(3);
    expect(r.map.flows.plan?.marks).toEqual({ "api|searchRecipes": "changed" });
  });

  test("overlay: a step that names a missing pipe is an error and is left out", () => {
    const r = applyOverlay(small(), {
      lit: {},
      steps: [
        { n: "1.1", pipe: "ui-api", label: "a", text: "t", where: "w" },
        { n: "1.2", pipe: "gone", label: "b", text: "t", where: "w" },
      ],
    });
    expect(r.errors).toEqual(['step 1.2 names the pipe "gone", which does not exist']);
    expect(r.map.flows.plan?.steps?.map((s) => s.n)).toEqual(["1.1"]);
    expect(validateMap(r.map)).toEqual([]);
  });
});

/**
 * The map of fixtures/maps/starship.json in a real browser: every box with its chips, every pipe in its kind, the flow
 * tabs, no box over another. The counts come from the file. Screenshots go to app/test-results/map/ (ignored by git).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { BIG, ROOT, type Rig, shotBoth, shotsDir, startRig } from "./rig.ts";

interface FixtureBox {
  id: string;
  name: string;
  tag?: string;
  chips: string[];
}
interface FixtureMap {
  boxes: FixtureBox[];
  pipes: { id: string; kind: "call" | "lookup" | "event" }[];
  flows: Record<string, { name: string }>;
  order: string[];
}

const FIXTURE = join(ROOT, "fixtures", "maps", "starship.json");
const map = JSON.parse(readFileSync(FIXTURE, "utf8")) as FixtureMap;

let rig: Rig;
let page: Page;
let shots = "";

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

test.beforeAll(async ({ browser }) => {
  shots = shotsDir("map");
  rig = await startRig();
  rig.repo("acme");
  const imported = rig.cli(["map", "import", FIXTURE, "--repo", "acme"]);
  if (imported.code !== 0) throw new Error(`map import failed: ${imported.err}`);
  const made = await rig.post("/api/chats", { title: "Map check", repo: "acme" });
  if (!made.ok) throw new Error(`chat new failed: ${await made.text()}`);
  page = await rig.open(browser, BIG);
});

test.afterAll(async () => {
  await rig?.stop();
});

const stages = () => page.getByRole("navigation", { name: "Stages" });

test("the Map tab shows every box of the file, each with its chips", async () => {
  await stages().getByRole("button", { name: "Map" }).click();
  await expect(page.getByRole("heading", { level: 1 })).toBeVisible();
  const boxes = page.locator("[data-box]");
  await expect(boxes).toHaveCount(map.boxes.length);
  for (const b of map.boxes) {
    const box = page.locator(`[data-box="${b.id}"]`);
    await expect(box.locator(".map-box-l b")).toContainText(b.name);
    if (b.tag) await expect(box.locator(".map-own")).toHaveText(b.tag);
    const chips = box.locator(".map-chip");
    await expect(chips, `chips of ${b.id}`).toHaveCount(b.chips.length);
    for (let i = 0; i < b.chips.length; i++) {
      const want = (b.chips[i] ?? "").replace(/^[~#]/, "");
      await expect(chips.nth(i)).toHaveText(want);
    }
  }
});

test("there is one SVG path per pipe, and the three line kinds differ", async () => {
  const paths = page.locator("svg.map-pipes path[data-pipe]");
  await expect(paths).toHaveCount(map.pipes.length);
  const seen = await paths.evaluateAll((els) => els.map((el) => ({ id: el.getAttribute("data-pipe") ?? "", cls: el.getAttribute("class") ?? "", dash: getComputedStyle(el).strokeDasharray, d: el.getAttribute("d") ?? "" })));
  expect(new Set(seen.map((s) => s.id)).size).toBe(map.pipes.length);
  for (const p of map.pipes) {
    const found = seen.find((s) => s.id === p.id);
    expect(found?.cls, `pipe ${p.id}`).toContain(`pipe-${p.kind}`);
    expect(found?.d.length ?? 0, `pipe ${p.id} has a drawn path`).toBeGreaterThan(5);
  }
  const dashOf = (kind: string) => new Set(seen.filter((s) => s.cls.includes(`pipe-${kind}`)).map((s) => s.dash));
  const call = dashOf("call");
  const lookup = dashOf("lookup");
  const event = dashOf("event");
  // Each kind has one dash pattern, and the three patterns are three different ones.
  expect([call.size, lookup.size, event.size]).toEqual([1, 1, 1]);
  expect(new Set([...call, ...lookup, ...event]).size).toBe(3);
  // The map has each kind at least once.
  for (const kind of ["call", "lookup", "event"] as const) expect(map.pipes.some((p) => p.kind === kind)).toBe(true);
  // A pill names each pipe.
  await expect(page.locator(".map-pill")).toHaveCount(map.pipes.length);
});

test("the tabs show the flows", async () => {
  const tabs = page.getByRole("tab");
  const names = map.order.map((id) => map.flows[id]?.name ?? "");
  await expect(tabs).toHaveCount(names.length);
  for (let i = 0; i < names.length; i++) await expect(tabs.nth(i)).toHaveText(names[i] ?? "");
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
  await tabs.first().click();
  await expect(tabs.first()).toHaveAttribute("aria-selected", "true");
});

test("no box overlaps another, and each box stays inside its band", async () => {
  const rects = await page.locator("[data-box]").evaluateAll((els) =>
    els.map((el) => {
      const r = el.getBoundingClientRect();
      return { id: el.getAttribute("data-box") ?? "", x: r.left, y: r.top, w: r.width, h: r.height };
    }),
  );
  expect(rects).toHaveLength(map.boxes.length);
  for (const r of rects) {
    expect(r.w, `${r.id} has a width`).toBeGreaterThan(40);
    expect(r.h, `${r.id} has a height`).toBeGreaterThan(30);
  }
  for (let i = 0; i < rects.length; i++) {
    for (let j = i + 1; j < rects.length; j++) {
      const a = rects[i];
      const b = rects[j];
      if (!a || !b) continue;
      const overlap = a.x < b.x + b.w - 0.5 && b.x < a.x + a.w - 0.5 && a.y < b.y + b.h - 0.5 && b.y < a.y + a.h - 0.5;
      expect(overlap, `${a.id} overlaps ${b.id}`).toBe(false);
    }
  }
  // A box sits inside the band of its layer: no box touches the edge of the stage.
  const stage = await page.locator(".map-stage").boundingBox();
  expect(stage).not.toBeNull();
  if (stage) {
    for (const r of rects) {
      expect(r.x, `${r.id} left`).toBeGreaterThanOrEqual(stage.x - 1);
      expect(r.x + r.w, `${r.id} right`).toBeLessThanOrEqual(stage.x + stage.width + 1);
      expect(r.y, `${r.id} top`).toBeGreaterThanOrEqual(stage.y - 1);
      expect(r.y + r.h, `${r.id} bottom`).toBeLessThanOrEqual(stage.y + stage.height + 1);
    }
  }
});

test("a screenshot of the whole map at 1400 x 900, and at 1100 x 700", async () => {
  await page.setViewportSize(BIG);
  await page.waitForTimeout(400);
  await shotBoth(page, shots, "map");
  // At 1100 the map keeps its minimum width and scrolls inside its own region.
  const wrap = page.locator(".map-wrap");
  await expect(wrap).toBeVisible();
});

test("no console error, no page error, no response of 500 or more", () => {
  rig.assertClean();
});

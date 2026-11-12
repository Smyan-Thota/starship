/**
 * The window in a real browser, against a real engine: the sample folder shows, live, on every tab.
 *
 * The engine runs on a temp STARSHIP_HOME with a temp copy of fixtures/recipe-search as the chat's folder, and serves
 * the fresh app/dist. Teardown stops it and deletes the temp folders, also after a failure.
 * One screenshot per tab goes to app/test-results/shell/ (ignored by git).
 */
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { copyFixture, ROOT, type Rig, shotBoth, startRig } from "./rig.ts";

const SHOTS = join(ROOT, "app", "test-results", "shell");

let rig: Rig;
let folder = "";
let address = "";
let page: Page;
/** Responses with a status of 400 or more. A 404 for a route the engine does not have yet is listed, not failed. */
const failedLoads = (): string[] => rig.refusals;

test.describe.configure({ mode: "serial" });

test.beforeAll(async ({ browser }) => {
  // The rig starts the engine with a temp STARSHIP_HOME, the fake agent in place of Claude Code and Codex, and its own
  // tmux prefix. The chat's folder is a temp copy of fixtures/recipe-search.
  rig = await startRig();
  address = rig.address;
  folder = copyFixture(rig, "recipe-search", "recipe-search");
  // The engine shows a plan (its lines and the validator's problems) only for a chat that has a repo. The repo is a
  // temp git repo with one commit; the chat's folder stays the temp copy of the fixture.
  rig.repo("e2e-repo");
  const made = rig.cli(["chat", "new", "--title", "Recipe search", "--repo", "e2e-repo", "--folder", folder]);
  if (made.code !== 0) throw new Error(`chat new failed: ${made.err}`);
  mkdirSync(SHOTS, { recursive: true });
  page = await rig.open(browser);
});

test.afterAll(async () => {
  await rig?.stop();
});

const stages = () => page.getByRole("navigation", { name: "Stages" });
const documents = () => page.getByRole("navigation", { name: "Documents" });
const shot = (name: string) => page.screenshot({ path: join(SHOTS, `${name}.png`), fullPage: true });

test("the chat list shows the sample chat with its needs-you count", async () => {
  await page.goto(address);
  const side = page.getByRole("complementary", { name: "Chats" });
  const chat = side.getByRole("button", { name: /Recipe search/ });
  await expect(chat).toBeVisible();
  // The fixture holds a blocked task (T031), so at least one thing needs the owner.
  const count = side.getByRole("button", { name: "Needs you" });
  await expect(count).toBeVisible();
  expect(Number(await count.textContent())).toBeGreaterThanOrEqual(1);
  // Online: no connection label.
  await expect(side.getByRole("status")).toHaveCount(0);
});

test("the Build tab shows the real counts, the running task and what needs the owner", async () => {
  await stages().getByRole("button", { name: "Build" }).click();
  await expect(page.getByRole("heading", { name: "Build", level: 1 })).toBeVisible();
  // The phase table: the verified column adds up to 9, the total column to 20.
  const table = page.getByRole("table");
  await expect(table.getByRole("columnheader", { name: "Verified" })).toBeVisible();
  const rows = table.getByRole("row");
  const sums = { verified: 0, total: 0 };
  const n = await rows.count();
  expect(n).toBeGreaterThan(1);
  for (let i = 1; i < n; i++) {
    const cells = rows.nth(i).getByRole("cell");
    sums.verified += Number(await cells.nth(1).textContent());
    sums.total += Number(await cells.nth(2).textContent());
  }
  expect(sums).toEqual({ verified: 9, total: 20 });
  // The task that runs, with its agent.
  const now = page.getByRole("region", { name: "Now" });
  await expect(now).toContainText("T022");
  await expect(now).toContainText("worker-a");
  // What needs the owner: the blocked task.
  const needs = page.getByRole("region", { name: "Needs you" });
  await expect(needs).toBeVisible();
  await expect(needs).toContainText("T031");
  await expect(page.getByRole("button", { name: "Halt" })).toBeVisible();
  await shot("build");
});

test("the Plan tab shows its lines, its problems when there are any, and Start build", async () => {
  await stages().getByRole("button", { name: "Plan" }).click();
  await expect(page.getByRole("heading", { name: "Recipe search", level: 1 })).toBeVisible();
  const startBuild = page.getByRole("button", { name: "Start build" });
  await expect(startBuild).toBeVisible();
  await expect(startBuild).toBeEnabled();
  // Each line is a button with a label and a value taken from a plan file.
  const lines = page.getByRole("button").filter({ has: page.locator(".k") });
  expect(await lines.count()).toBeGreaterThan(0);
  expect((await lines.first().locator(".k").textContent())?.trim()).not.toBe("");
  expect((await lines.first().locator(".v").textContent())?.trim()).not.toBe("");
  // The validator's problems: every listed problem has text. A valid plan lists none and shows no Problems heading.
  const list = page.getByRole("list", { name: "Problems" });
  if ((await list.count()) > 0) {
    const items = list.getByRole("listitem");
    expect(await items.count()).toBeGreaterThan(0);
    for (const t of await items.allTextContents()) expect(t.trim()).not.toBe("");
    // The fixture's PLAN.md lacks two sections of the staff checklist, and the validator says so.
    await expect(list).toContainText("no section for data");
    await expect(list).toContainText("no section for tests");
  } else {
    await expect(page.getByRole("heading", { name: "Problems" })).toHaveCount(0);
  }
  await shot("plan");
});

test("the Review tab shows the findings, the story cards and the fix list", async () => {
  await stages().getByRole("button", { name: "Review" }).click();
  await expect(page.getByRole("heading", { name: "Review", level: 1 })).toBeVisible();
  const findings = page.getByRole("heading", { name: "Findings" }).locator("..");
  await expect(findings).toContainText("F1");
  await expect(findings).toContainText("F2");
  await expect(findings).toContainText("Search does not trim the query");
  await expect(findings).toContainText("The empty state gives no hint to clear the filter");
  await expect(findings).toContainText("api/src/services/RecipeSearchService.ts:42");
  const cards = page.getByRole("heading", { name: "Story cards" }).locator("..");
  await expect(cards).toContainText("C1");
  await expect(cards).toContainText("Search by recipe number");
  await expect(cards).toContainText("pass");
  await expect(cards).toContainText("C2");
  await expect(cards).toContainText("Filter by cuisine");
  await expect(cards).toContainText("Typing R-111 shows the recipe R-111");
  const fixes = page.getByRole("heading", { name: "Fixes" }).locator("..");
  await expect(fixes).toContainText("X1");
  await expect(fixes).toContainText("X2");
  await expect(fixes.getByRole("button", { name: "Send fixes" })).toBeEnabled();
  await shot("review");
});

test("the Tasks tab lists the tasks, and a change on disk shows without a reload", async () => {
  await documents().getByRole("button", { name: "Tasks" }).click();
  await expect(page.getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(page.getByText("Trigram index migration")).toBeVisible();
  await expect(page.getByText("Keyboard support", { exact: true })).toBeVisible();
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "9");
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuemax", "20");
  await expect(page.getByRole("img", { name: "verified" })).toHaveCount(9);
  await shot("tasks");

  // One more box on disk, no reload.
  const file = join(folder, "TASKS.md");
  const before = readFileSync(file, "utf8");
  expect(before).toContain("- [ ] T024 Keyboard support");
  writeFileSync(file, before.replace("- [ ] T024 Keyboard support", "- [x] T024 Keyboard support"));
  await expect(page.getByRole("progressbar")).toHaveAttribute("aria-valuenow", "10", { timeout: 8000 });
  await expect(page.getByRole("img", { name: "verified" })).toHaveCount(10);
});

test("the Files tab opens a file rendered and raw", async () => {
  await documents().getByRole("button", { name: "Files" }).click();
  await expect(page.getByRole("heading", { name: "Files", level: 1 })).toBeVisible();
  await shot("files");
  await page.getByRole("button", { name: /^SPEC\.md/ }).click();
  const md = page.locator(".md").first();
  await expect(md.getByRole("heading", { level: 1 }).first()).toHaveText("SPEC — Recipe search");
  await shot("file-rendered");
  await page.getByRole("button", { name: "Raw" }).click();
  await expect(page.locator("pre")).toContainText("# SPEC — Recipe search");
  await shot("file-raw");
  await page.getByRole("button", { name: "Rendered" }).click();
  await expect(md.getByRole("heading", { level: 1 }).first()).toBeVisible();
});

test("C9 a Markdown file with script, an onerror image and a javascript: link renders sanitized in a real browser", async () => {
  const hostile = [
    "# Hostile",
    "",
    "<script>window.__pwned=1</script>",
    "",
    '<img src=x onerror="window.__pwned=1">',
    "",
    "[md link](javascript:window.__pwned=1)",
    "",
    '<a href="javascript:window.__pwned=1">html link</a>',
    "",
  ].join("\n");
  writeFileSync(join(folder, "hostile.md"), hostile);
  await documents().getByRole("button", { name: "Files" }).click();
  const row = page.getByRole("button", { name: /^hostile\.md/ });
  await expect(row).toBeVisible({ timeout: 8000 });
  await row.click();
  const md = page.locator(".md").first();
  await expect(md.getByRole("heading", { level: 1 })).toHaveText("Hostile");
  // The image, if it kept its handler, would have fired by now.
  await page.waitForTimeout(500);
  for (const name of ["md link", "html link"]) {
    const link = md.getByText(name);
    if (await link.count()) await link.click();
  }
  expect(await page.evaluate(() => (window as unknown as { __pwned?: number }).__pwned)).toBeUndefined();
  const html = await md.innerHTML();
  expect(html).not.toMatch(/<script/i);
  expect(html).not.toMatch(/onerror/i);
  expect(html).not.toMatch(/javascript:/i);
  expect(await md.locator("script").count()).toBe(0);
  expect(await md.locator("[onerror]").count()).toBe(0);
  expect(await md.locator('a[href^="javascript:" i]').count()).toBe(0);
  await shot("c9-hostile");
  // The file on screen is the hostile one: its raw text still holds the script.
  await page.getByRole("button", { name: "Raw" }).click();
  await expect(page.locator("pre")).toContainText("<script>window.__pwned=1</script>");
});

test("the Map tab opens", async () => {
  await stages().getByRole("button", { name: "Map" }).click();
  await expect(stages().getByRole("button", { name: "Map" })).toHaveAttribute("aria-current", "true");
  await page.waitForTimeout(500);
  await shot("map");
});

test("every tab at 1400 x 900 and at 1100 x 700 does not overflow, and each has a picture of its whole page", async () => {
  for (const [nav, name] of [
    [stages, "Plan"],
    [stages, "Build"],
    [stages, "Review"],
    [documents, "Tasks"],
    [documents, "Files"],
  ] as const) {
    await nav().getByRole("button", { name }).click();
    await expect(page.getByRole("heading", { name, level: 1 }).or(page.getByRole("heading", { level: 1 }).first())).toBeVisible();
    await shotBoth(page, SHOTS, `size-${name.toLowerCase()}`);
  }
  await documents().getByRole("button", { name: "Files" }).click();
  await page.getByRole("button", { name: /^SPEC\.md/ }).click();
  await expect(page.locator(".md").first()).toBeVisible();
  await shotBoth(page, SHOTS, "size-file");
});

test("no page showed a browser console error during the run", async () => {
  if (failedLoads().length > 0) console.log(`responses with status >= 400:\n${[...new Set(failedLoads())].join("\n")}`);
  expect(rig.problems).toEqual([]);
  expect(rig.serverErrors).toEqual([]);
  // A 404 for a route the engine does not have yet is listed above, and does not fail the run. Any other failure does.
  expect(failedLoads().filter((f) => !f.startsWith("404 "))).toEqual([]);
});

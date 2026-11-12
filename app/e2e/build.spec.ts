/**
 * Task T051: a fake build runs to the end with a halt, a note and a question, in a real browser. The engine runs a temp git
 * repo with a small valid plan of 3 tasks in 2 phases, and the fake agent plays the orchestrator and the workers.
 * Start build, Halt, Resume, a note for the orchestrator, a question and its answer, then Done. No reload in between.
 * Screenshots go to app/test-results/build/ (ignored by git).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { planChat, type Rig, shotBoth, shotsDir, startRig, waitState } from "./rig.ts";

/** Three tasks in two phases. Every verify command is `true`; the first two wait 3 seconds first, so the owner can act while a check runs. */
const TASKS = [
  "# TASKS",
  "",
  "## Phase 1 — Setup",
  "",
  "- [ ] T001 First thing — `src/a.txt` — verify: `sleep 3 && true` (in scope #1)",
  "- [ ] T002 Second thing — `src/b.txt` — verify: `sleep 3 && true` (in scope #1)",
  "",
  "## Phase 2 — Finish",
  "",
  "- [ ] T003 Third thing — `src/c.txt` — verify: `true` (in scope #1)",
  "",
].join("\n");

let rig: Rig;
let page: Page;
let shots = "";
let chatId = "";
let featureDir = "";

test.describe.configure({ mode: "serial" });
test.setTimeout(240_000);

test.beforeAll(async ({ browser }) => {
  shots = shotsDir("build");
  rig = await startRig();
  rig.repo("demo");
  const chat = await planChat(rig, "Fake build", "demo", TASKS);
  chatId = chat.id;
  featureDir = chat.dir;
  page = await rig.open(browser);
});

test.afterAll(async () => {
  await rig?.stop();
});

const stages = () => page.getByRole("navigation", { name: "Stages" });
const documents = () => page.getByRole("navigation", { name: "Documents" });
const doc = () => page.locator("main.doc");
const agentRows = () => doc().getByRole("region", { name: "Agents" }).locator("[data-agent]");

test("the Plan tab shows the plan files and no problem, and Start build starts the build", async () => {
  await page.evaluate(() => {
    (window as unknown as { __kept?: number }).__kept = 1;
  });
  await stages().getByRole("button", { name: "Plan" }).click();
  await expect(doc().getByRole("heading", { name: "Fake build", level: 1 })).toBeVisible();
  // A valid plan lists no problem.
  await expect(doc().getByRole("heading", { name: "Problems" })).toHaveCount(0);
  // The Files list holds plan files only.
  const files = doc().getByRole("heading", { name: "Files", level: 3 }).locator("xpath=following-sibling::ul[1]").locator(".name");
  await expect(files).toHaveText(["SPEC.md", "PLAN.md", "TASKS.md", "ACCEPTANCE.md"]);
  await shotBoth(page, shots, "plan");
  const start = doc().getByRole("button", { name: "Start build" });
  await expect(start).toBeEnabled();
  await start.click();
  await expect(doc().getByRole("heading", { name: "Build", level: 1 })).toBeVisible();
  await expect(doc().locator("dl.props")).toContainText("Running");
});

test("the Build tab shows tasks moving and the agents listed", async () => {
  // The phase table: 2 phases with 2 and 1 tasks.
  const table = doc().getByRole("table");
  await expect(table.getByRole("row")).toHaveCount(3);
  await expect(table.getByRole("row").nth(1)).toContainText("Setup");
  await expect(table.getByRole("row").nth(2)).toContainText("Finish");
  // T001 moves to the work list, with an agent.
  const now = doc().getByRole("region", { name: "Now" });
  await expect(now.locator('[data-task="T001"]')).toBeVisible({ timeout: 40_000 });
  await expect(agentRows().first()).toBeVisible({ timeout: 40_000 });
  expect(await agentRows().count()).toBeGreaterThanOrEqual(1);
  // The build's agents are named; the admin agent is not among them.
  for (const text of await agentRows().allTextContents()) expect(text).not.toContain("admin");
  // The task goes on to its check: the worker has ended its turn.
  await expect(now.locator('[data-task="T001"]')).toContainText("checking", { timeout: 40_000 });
});

test("Halt shows Halted and halts the agents; Resume undoes it", async () => {
  const halt = doc().getByRole("button", { name: "Halt", exact: true });
  await expect(halt).toBeVisible();
  await halt.click();
  await expect(doc().getByText(/^Halted \d\d:\d\d$/)).toBeVisible();
  await expect(doc().getByRole("button", { name: "Halt", exact: true })).toHaveCount(0);
  await expect(doc().getByRole("button", { name: "Resume", exact: true })).toBeVisible();
  // The sidebar marks the chat as halted, and every agent of the build is halted.
  await expect.poll(async () => (await agentRows().allTextContents()).length).toBeGreaterThan(0);
  await expect
    .poll(async () => (await agentRows().allTextContents()).every((t) => t.includes("halted")), { timeout: 20_000, message: "every agent of the build shows halted" })
    .toBe(true);
  const halted = await rig.state(chatId);
  expect(halted.chat.halted).toMatch(/^\d\d:\d\d$/);
  await shotBoth(page, shots, "build-halted");
  await doc().getByRole("button", { name: "Resume", exact: true }).click();
  await expect(doc().getByText(/^Halted/)).toHaveCount(0);
  await expect(doc().getByRole("button", { name: "Halt", exact: true })).toBeVisible();
  await expect(doc().getByRole("button", { name: "Resume", exact: true })).toHaveCount(0);
  await expect.poll(async () => (await agentRows().allTextContents()).some((t) => t.includes("halted")), { timeout: 20_000 }).toBe(false);
});

test("a note for the orchestrator shows in the chat pane with its status", async () => {
  const noted = rig.cli(["note", "--to", "orchestrator", "--said", "add a doc", "Also write a short doc.", "--chat", chatId]);
  expect(noted.err).toBe("");
  expect(noted.code).toBe(0);
  const n = Number(noted.out.match(/^note (\d+) /)?.[1]);
  expect(n).toBeGreaterThan(0);
  const note = page.locator(`section.chat [data-note="${n}"]`);
  await expect(note).toBeVisible();
  await expect(note).toContainText("Also write a short doc.");
  await expect(note).toContainText("add a doc");
  await expect(note).toContainText(/orchestrator/i);
  // Its status is one of the three the engine gives a note that is not read yet.
  await expect(note.locator(".ns")).toContainText(/Queued|Held|Read/);
  // The orchestrator confirms it with the real CLI, and the pane shows Read.
  const read = rig.cli(["note", "ack", String(n), "--chat", chatId], { STARSHIP_AGENT: "orchestrator" });
  expect(read.err).toBe("");
  expect(read.code).toBe(0);
  await expect(note.locator(".ns")).toContainText("Read", { timeout: 20_000 });
});

test("a question shows under Needs you, and its answer takes it away", async () => {
  const state = await rig.state(chatId);
  expect(state.build.status).toBe("running");
  const asked = rig.cli(["ask", "--task", "T003", "Which name for the file?", "--chat", chatId], { STARSHIP_AGENT: "worker-a" });
  expect(asked.err).toBe("");
  expect(asked.out).toBe("Q1 asked\n");
  const needs = doc().getByRole("region", { name: "Needs you" });
  await expect(needs).toContainText("Which name for the file?", { timeout: 15_000 });
  await expect(needs).toContainText("question");
  await expect(needs).toContainText("T003");
  await expect(page.locator('section.chat [data-question="1"]')).toContainText("Which name for the file?");
  await expect(page.getByRole("complementary", { name: "Chats" }).getByLabel("Needs you")).toBeVisible();
  await shotBoth(page, shots, "build-needs-you");
  const answered = rig.cli(["answer", "Q1", "Use the short name.", "--chat", chatId]);
  expect(answered.err).toBe("");
  expect(answered.out).toBe("Q1 answered\n");
  await expect(doc().getByRole("region", { name: "Needs you" })).toHaveCount(0, { timeout: 15_000 });
  await expect(page.locator('section.chat [data-question="1"]')).toHaveCount(0);
});

test("the build ends: every task verified, the status Done, every box checked on the Tasks tab, with no reload", async () => {
  const done = await waitState(rig, chatId, "the build is done", (s) => s.build.status === "done", 120_000);
  expect(done.tasks?.verified).toBe(3);
  expect(done.tasks?.phases.flatMap((p) => p.tasks).map((t) => [t.id, t.state])).toEqual([
    ["T001", "verified"],
    ["T002", "verified"],
    ["T003", "verified"],
  ]);
  await expect(doc().locator("dl.props")).toContainText("Done");
  const rows = doc().getByRole("table").getByRole("row");
  await expect(rows.nth(1).getByRole("cell").nth(1)).toHaveText("2");
  await expect(rows.nth(2).getByRole("cell").nth(1)).toHaveText("1");
  await expect(doc().getByRole("region", { name: "Now" })).toContainText("Nothing");
  await shotBoth(page, shots, "build-done");
  await documents().getByRole("button", { name: "Tasks" }).click();
  await expect(doc().getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(doc().getByRole("progressbar")).toHaveAttribute("aria-valuenow", "3");
  await expect(doc().getByRole("progressbar")).toHaveAttribute("aria-valuemax", "3");
  await expect(doc().getByRole("img", { name: "verified" })).toHaveCount(3);
  await expect(doc().getByRole("img", { name: "open" })).toHaveCount(0);
  await shotBoth(page, shots, "tasks-done");
  // The window never reloaded.
  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1);
});

test("the worker's page shows its status, tool, model and the exact prompt text", async () => {
  await page.locator('header.top [data-agent="worker-a"]').click();
  const state = await rig.state(chatId);
  const worker = state.agents.find((a) => a.id === "worker-a");
  expect(worker).toBeTruthy();
  const props = doc().locator("dl.props");
  const value = (label: string) => props.locator(`dt:text-is("${label}") + dd`);
  await expect(doc().getByRole("heading", { name: "worker-a", level: 1 })).toBeVisible();
  await expect(value("Status")).toHaveText("idle");
  await expect(value("Role")).toHaveText("Worker");
  await expect(value("Tool")).toHaveText("Codex");
  await expect(value("Session")).toHaveText(worker?.tmux ?? "");
  expect(worker?.tmux.startsWith(rig.prefix)).toBe(true);
  // The prompt on the page is the file the engine wrote for the worker, byte for byte.
  const latest = worker?.prompts.at(-1);
  expect(latest?.file).toMatch(/^run\/prompts\/worker-a-/);
  const file = readFileSync(join(featureDir, latest?.file ?? "missing"), "utf8");
  expect(file.length).toBeGreaterThan(50);
  expect(latest?.text).toBe(file);
  const shown = (await doc().locator(".ap-prompt").textContent()) ?? "";
  expect(shown).toBe(file);
  await shotBoth(page, shots, "agent-worker");
});

test("the Files tab and a plan file at both sizes", async () => {
  await documents().getByRole("button", { name: "Files" }).click();
  await expect(doc().getByRole("heading", { name: "Files", level: 1 })).toBeVisible();
  await shotBoth(page, shots, "files");
  await doc().getByRole("button", { name: /^PLAN\.md/ }).click();
  await expect(doc().getByRole("heading", { name: "PLAN", level: 1 })).toBeVisible();
  await shotBoth(page, shots, "file-plan");
});

test("no console error, no page error, no response of 500 or more", () => {
  rig.assertClean();
});

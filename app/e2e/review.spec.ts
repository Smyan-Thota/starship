/**
 * Review in a real browser, on a chat whose fake build is done: Start review, the reviewers, a finding and a dispute through
 * the CLI, the refusal "A finding is disputed", the accepted finding, Send fixes, and the Fixes phase on the Tasks tab.
 * Screenshots go to app/test-results/review/ (ignored by git).
 */
import { expect, type Page, test } from "@playwright/test";
import { planChat, type Rig, shotBoth, shotsDir, startRig, waitState } from "./rig.ts";

/** One task. Its check makes src/a.txt, so the finding's place is a real file of the worktree that is not a plan file. */
const TASKS = ["# TASKS", "", "## Phase 1 — Setup", "", "- [ ] T001 Make the file — `src/a.txt` — verify: `mkdir -p src && echo hello > src/a.txt && test -f src/a.txt` (in scope #1)", ""].join("\n");

let rig: Rig;
let page: Page;
let shots = "";
let chatId = "";

test.describe.configure({ mode: "serial" });
test.setTimeout(180_000);

test.beforeAll(async ({ browser }) => {
  shots = shotsDir("review");
  rig = await startRig();
  rig.repo("demo");
  chatId = (await planChat(rig, "Review me", "demo", TASKS)).id;
  // The build runs from the window's Plan tab. The review starts after it is done.
  page = await rig.open(browser);
  await page.getByRole("navigation", { name: "Stages" }).getByRole("button", { name: "Plan" }).click();
  await page.getByRole("button", { name: "Start build" }).click();
  await waitState(rig, chatId, "the build is done", (s) => s.build.status === "done", 120_000);
});

test.afterAll(async () => {
  await rig?.stop();
});

const stages = () => page.getByRole("navigation", { name: "Stages" });
const documents = () => page.getByRole("navigation", { name: "Documents" });
const doc = () => page.locator("main.doc");
const finding = (n: number) => doc().locator(`[data-finding="${n}"]`);
const group = (name: string) => doc().locator(`[data-group="${name}"]`);
const asReviewer = (id: string) => ({ STARSHIP_AGENT: id });

test("Start review lists the reviewers on the Review tab", async () => {
  await stages().getByRole("button", { name: "Review" }).click();
  await expect(doc().getByRole("heading", { name: "Review", level: 1 })).toBeVisible();
  await expect(doc().getByRole("heading", { name: "Agents" })).toHaveCount(0);
  await shotBoth(page, shots, "review-before");
  await doc().getByRole("button", { name: "Start review" }).click();
  // Two reviewers start. No app address is set in the repo, so there is no card runner.
  const agents = doc().locator(".rv-agent");
  await expect(agents).toHaveCount(2, { timeout: 60_000 });
  await expect(doc().locator('.rv-agent[data-agent="reviewer-1"]')).toBeVisible();
  await expect(doc().locator('.rv-agent[data-agent="reviewer-2"]')).toBeVisible();
  await expect(doc().getByRole("heading", { name: "Agents" })).toBeVisible();
  await expect(doc().getByRole("button", { name: "Start review" })).toHaveCount(0);
  const s = await rig.state(chatId);
  expect(s.chat.stage).toBe("review");
  await shotBoth(page, shots, "review-started");
});

test("a finding added through the CLI shows, and its place opens the file as read-only text", async () => {
  const added = rig.cli(["finding", "add", "--sev", "high", "--where", "src/a.txt:1", "Wrong word.", "--chat", chatId], asReviewer("reviewer-1"));
  expect(added.err).toBe("");
  expect(added.out).toBe("F1 open\n");
  await expect(group("open")).toBeVisible();
  await expect(finding(1)).toContainText("Wrong word.");
  await expect(finding(1)).toContainText("high");
  await expect(finding(1)).toContainText("reviewer-1");
  // src/a.txt is no plan file: it opens through the code route, in the file view.
  await finding(1).getByRole("button", { name: "src/a.txt:1" }).click();
  await expect(doc().getByText("src/a.txt", { exact: true })).toBeVisible();
  await expect(doc().locator("pre.pre")).toHaveText("hello\n");
  await expect(page.getByText("Not a plan file")).toHaveCount(0);
  await expect(doc().locator("textarea, [contenteditable]")).toHaveCount(0);
  await shotBoth(page, shots, "code-file");
  expect(rig.refusals.filter((r) => r.includes("/code"))).toEqual([]);
  await stages().getByRole("button", { name: "Review" }).click();
  await expect(finding(1)).toBeVisible();
});

test("a dispute shows the finding as disputed and under needs you; Send fixes shows the refusal", async () => {
  const disputed = rig.cli(["finding", "dispute", "1", "The word is on purpose.", "--chat", chatId], asReviewer("reviewer-2"));
  expect(disputed.err).toBe("");
  expect(disputed.out).toBe("F1 disputed\n");
  await expect(group("disputed")).toContainText("Disputed · 1");
  await expect(group("disputed").locator('[data-finding="1"]')).toContainText("reviewer-2: The word is on purpose.");
  await expect(group("open")).toHaveCount(0);
  // It waits for the owner: the chat's count in the list, and the Needs you list of the Build tab.
  await expect(page.getByRole("complementary", { name: "Chats" }).getByLabel("Needs you")).toHaveText("1");
  await stages().getByRole("button", { name: "Build" }).click();
  await expect(doc().getByRole("region", { name: "Needs you" })).toContainText("F1 is disputed");
  await stages().getByRole("button", { name: "Review" }).click();
  // With a finding disputed, the owner may press Send fixes and reads why it does not go.
  await doc().getByRole("button", { name: "Send fixes" }).click();
  await expect(doc().getByRole("alert")).toHaveText("A finding is disputed");
  expect((await rig.state(chatId)).chat.stage).toBe("review");
  await shotBoth(page, shots, "review-disputed");
});

test("accepting the finding lets Send fixes work, and a Fixes phase shows on the Tasks tab", async () => {
  const accepted = rig.cli(["finding", "accept", "1", "--chat", chatId]);
  expect(accepted.err).toBe("");
  expect(accepted.out).toBe("F1 accepted\n");
  await expect(group("accepted")).toContainText("Accepted · 1");
  await expect(group("disputed")).toHaveCount(0);
  const fix = doc().locator('[data-fix="1"]');
  await expect(fix).toContainText("Wrong word.");
  await expect(fix).toContainText("F1");
  await expect(page.getByRole("complementary", { name: "Chats" }).getByLabel("Needs you")).toHaveCount(0);
  await shotBoth(page, shots, "review-accepted");
  await doc().getByRole("button", { name: "Send fixes" }).click();
  // Sent: no refusal, and the chat is back in Build with the new phase.
  await waitState(rig, chatId, "the fixes went to Build", (s) => s.chat.stage === "build" && s.build.lastFixSent === 1);
  await expect(doc().getByRole("alert")).toHaveCount(0);
  await documents().getByRole("button", { name: "Tasks" }).click();
  await expect(doc().getByRole("heading", { name: "Tasks", level: 1 })).toBeVisible();
  await expect(doc().locator(".ph", { hasText: "Fixes" })).toBeVisible();
  await expect(doc().locator(".ph")).toHaveCount(2);
  await shotBoth(page, shots, "tasks-fixes");
});

test("no console error, no page error, no response of 500 or more", () => {
  rig.assertClean();
});

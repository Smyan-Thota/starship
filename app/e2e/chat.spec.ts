/**
 * The conversation with the admin agent in a real browser, against a real engine and the fake agent (edge rows A1 to A11).
 * A new chat with no repo; "say hello" is answered; two more messages, the second waits as queued; the Admin agent page;
 * Pause and Resume on a slow turn. Screenshots go to app/test-results/chat/ (ignored by git).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import type { AgentView } from "../../engine/src/types.ts";
import { type Rig, shotBoth, shotsDir, startRig, waitState } from "./rig.ts";

let rig: Rig;
let page: Page;
let shots = "";
let chatId = "";

test.describe.configure({ mode: "serial" });
test.setTimeout(120_000);

test.beforeAll(async ({ browser }) => {
  shots = shotsDir("chat");
  rig = await startRig();
  page = await rig.open(browser);
});

test.afterAll(async () => {
  await rig?.stop();
});

const message = () => page.getByRole("textbox", { name: "Message" });
const pane = () => page.getByRole("region", { name: "Admin chat" });
/** The rows of the conversation, one per message. */
const rows = () => pane().locator("[data-message]");

async function send(text: string): Promise<void> {
  await message().fill(text);
  await message().press("Enter");
  // The input empties when the engine has the text.
  await expect(message()).toHaveValue("");
}

test("New chat with no repo through the form opens a conversation and nothing else", async () => {
  await page.getByRole("button", { name: "New chat" }).click();
  await expect(page.getByRole("heading", { name: "New chat", level: 1 })).toBeVisible();
  await expect(page.getByRole("combobox", { name: "Repo" })).toHaveValue("");
  await shotBoth(page, shots, "new-chat");
  await page.getByLabel("Title").fill("Release notes");
  await page.getByRole("button", { name: "Create" }).click();
  // The chat is open: its title in the top bar, no stage tabs, the input of the conversation.
  await expect(page.locator("header.top .ttl")).toHaveText("Release notes");
  await expect(page.getByRole("navigation", { name: "Stages" })).toHaveCount(0);
  await expect(message()).toBeVisible();
  const chats = await rig.get<{ id: string; title: string; stage: string | null }[]>("/api/chats");
  expect(chats).toHaveLength(1);
  expect(chats[0]).toMatchObject({ title: "Release notes", stage: null });
  chatId = chats[0]?.id ?? "";
  expect(chatId).not.toBe("");
});

test("say hello: the message shows answered and the reply hello shows, with no reload", async () => {
  await page.evaluate(() => {
    (window as unknown as { __kept?: number }).__kept = 1;
  });
  await send("say hello");
  await expect(rows().filter({ hasText: "say hello" })).toHaveAttribute("data-state", /^(queued|sent|answered)$/);
  await expect(rows().filter({ hasText: "say hello" })).toHaveAttribute("data-state", "answered", { timeout: 40_000 });
  const reply = rows().filter({ has: page.getByText("Admin", { exact: true }) }).filter({ hasText: "hello" });
  await expect(reply.last()).toContainText("hello");
  // The same page is still there: nothing reloaded.
  expect(await page.evaluate(() => (window as unknown as { __kept?: number }).__kept)).toBe(1);
  // Once the admin agent runs, the header of the conversation names its status.
  await expect(page.locator(".ch")).toContainText("Admin");
  await expect(page.locator(".ch")).toContainText("idle");
  await shotBoth(page, shots, "chat-answered");
});

test("slow 3000 later, then a third message at once: the third shows queued, then both get replies in order", async () => {
  await send("slow 3000 later");
  await send("say third");
  const third = rows().filter({ hasText: "say third" });
  await expect(third).toHaveAttribute("data-state", "queued", { timeout: 2500 });
  await expect(third.getByText("Queued", { exact: true })).toBeVisible();
  await shotBoth(page, shots, "chat-queued");
  await expect(third).toHaveAttribute("data-state", "answered", { timeout: 60_000 });
  await expect(rows().filter({ hasText: "say hello" })).toHaveAttribute("data-state", "answered");
  await expect(rows().filter({ hasText: "slow 3000 later" })).toHaveAttribute("data-state", "answered");
  // The conversation in time: the third message was typed while the second turn ran, so it stands before that reply.
  // The replies come in the order of the messages: "later", then "third".
  const texts = await rows().evaluateAll((els) => els.map((el) => (el.textContent ?? "").replace(/^(You|Admin)\d\d:\d\d/, "")));
  expect(texts).toEqual(["say hello", "hello", "slow 3000 later", "say third", "later", "third"]);
  const admin = await rig.state(chatId);
  const states = Object.fromEntries(admin.messages.filter((m) => m.who === "you").map((m) => [m.text, m.state]));
  expect(states).toEqual({ "say hello": "answered", "slow 3000 later": "answered", "say third": "answered" });
  const replies = admin.messages.filter((m) => m.who === "admin").map((m) => m.text);
  expect(replies).toEqual(["hello", "later", "third"]);
});

test("the Admin agent page shows status, tool, model and session", async () => {
  await page.locator('header.top [data-agent="admin"]').click();
  const state = await rig.state(chatId);
  const admin: AgentView | undefined = state.agents.find((a) => a.id === "admin");
  expect(admin).toBeTruthy();
  await expect(page.getByRole("heading", { name: "Admin", level: 1 })).toBeVisible();
  const props = page.locator("main.doc dl.props");
  const value = (label: string) => props.locator(`dt:text-is("${label}") + dd`);
  await expect(value("Status")).toHaveText("idle");
  await expect(value("Tool")).toHaveText("Claude Code");
  await expect(value("Model")).toHaveText(admin?.model ?? "");
  await expect(value("Role")).toHaveText("Admin");
  await expect(value("Session")).toHaveText(admin?.tmux ?? "");
  expect(admin?.tmux.startsWith(rig.prefix)).toBe(true);
  await shotBoth(page, shots, "admin-agent");
});

test("the Admin agent page shows the exact prompt text", async () => {
  const state = await rig.state(chatId);
  const latest = state.agents.find((a) => a.id === "admin")?.prompts.at(-1);
  const file = readFileSync(join(rig.home, "chats", chatId, "agents", "admin.prompt.md"), "utf8");
  expect(file.length).toBeGreaterThan(20);
  expect(latest?.text).toBe(file);
  const shown = page.locator("main.doc .ap-prompt");
  await expect(shown).toBeVisible({ timeout: 2000 });
  expect(((await shown.textContent()) ?? "").trimEnd()).toBe(file.trimEnd());
});

test("Pause and Resume on a slow turn", async () => {
  await send("slow 8000 x");
  const status = page.locator("main.doc dl.props").locator('dt:text-is("Status") + dd');
  await expect(status).toHaveText("working", { timeout: 20_000 });
  const pause = page.getByRole("button", { name: "Pause" });
  await expect(pause).toBeVisible();
  await pause.click();
  await expect(status).toHaveText("paused", { timeout: 15_000 });
  await expect(page.getByRole("button", { name: "Resume" })).toBeVisible();
  await expect(page.getByRole("button", { name: "Pause" })).toHaveCount(0);
  await expect(page.locator(".ch")).toContainText("paused");
  await shotBoth(page, shots, "admin-paused");
  await page.getByRole("button", { name: "Resume" }).click();
  await expect(status).not.toHaveText("paused", { timeout: 15_000 });
  // The turn ends: the agent is idle and the message is answered.
  await expect(status).toHaveText("idle", { timeout: 60_000 });
  const done = await waitState(rig, chatId, "the slow message answered", (s) => s.messages.some((m) => m.who === "you" && m.text === "slow 8000 x" && m.state === "answered"), 60_000);
  expect(done.agents.find((a) => a.id === "admin")?.status).toBe("idle");
  // Close the agent page: the conversation alone again.
  await page.locator('header.top [data-agent="admin"]').click();
  await expect(page.locator("main.doc")).toHaveCount(0);
  await shotBoth(page, shots, "chat-end");
});

test("no console error, no page error, no response of 500 or more", () => {
  rig.assertClean();
});

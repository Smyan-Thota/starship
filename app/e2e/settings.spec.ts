/**
 * Settings in a real browser: change the worker model and the usage threshold, Save, reload the page, and the values are kept.
 * They come from the engine's config.json, which still holds the `bins` of the fake agent afterwards.
 * Screenshots go to app/test-results/settings/ (ignored by git).
 */
import { readFileSync } from "node:fs";
import { join } from "node:path";
import { expect, type Page, test } from "@playwright/test";
import { type Rig, shotBoth, shotsDir, startRig } from "./rig.ts";

interface Config {
  roles: { worker: { tool: string; model: string } };
  switch: { enabled: boolean; at: number };
  bins: { claude: string[]; codex: string[] };
}

let rig: Rig;
let page: Page;
let shots = "";

test.describe.configure({ mode: "serial" });
test.setTimeout(60_000);

test.beforeAll(async ({ browser }) => {
  shots = shotsDir("settings");
  rig = await startRig();
  page = await rig.open(browser);
});

test.afterAll(async () => {
  await rig?.stop();
});

const doc = () => page.locator("main.doc");
const workerModel = () => doc().getByRole("textbox", { name: "Worker model" });
const threshold = () => doc().getByRole("spinbutton", { name: "Usage threshold %", exact: true });
const save = () => doc().getByRole("button", { name: "Save" });

async function openSettings(): Promise<void> {
  await page.getByRole("button", { name: "Settings" }).click();
  await expect(doc().getByRole("heading", { name: "Settings", level: 1 })).toBeVisible();
}

test("Settings shows the engine's values, and Save is off until something changes", async () => {
  await openSettings();
  const config = await rig.get<Config>("/api/config");
  await expect(workerModel()).toHaveValue(config.roles.worker.model);
  await expect(threshold()).toHaveValue(String(config.switch.at));
  await expect(save()).toBeDisabled();
  await shotBoth(page, shots, "settings");
});

test("changing the worker model and the usage threshold, then Save, reaches the engine", async () => {
  await workerModel().fill("gpt-test");
  await threshold().fill("80");
  await expect(save()).toBeEnabled();
  await shotBoth(page, shots, "settings-changed");
  await save().click();
  await expect(save()).toBeDisabled();
  await expect(doc().getByRole("alert")).toHaveCount(0);
  // The engine has them, and still has the fake agent's bins.
  await expect.poll(async () => (await rig.get<Config>("/api/config")).roles.worker.model).toBe("gpt-test");
  const config = await rig.get<Config>("/api/config");
  expect(config.switch.at).toBe(80);
  expect(config.bins.claude.at(-1)).toBe("claude");
  expect(config.bins.claude.some((x) => x.endsWith("fake-agent.ts"))).toBe(true);
  const onDisk = JSON.parse(readFileSync(join(rig.home, "config.json"), "utf8")) as Config;
  expect(onDisk.roles.worker.model).toBe("gpt-test");
  expect(onDisk.switch.at).toBe(80);
  expect(onDisk.bins.codex.some((x) => x.endsWith("fake-agent.ts"))).toBe(true);
});

test("after a reload the values are kept", async () => {
  await page.reload();
  await openSettings();
  await expect(workerModel()).toHaveValue("gpt-test");
  await expect(threshold()).toHaveValue("80");
  await expect(save()).toBeDisabled();
  // The bar in the left column shows the same threshold.
  await expect(page.getByRole("complementary", { name: "Chats" }).getByRole("spinbutton", { name: "Threshold %" })).toHaveValue("80");
  await shotBoth(page, shots, "settings-reloaded");
});

test("a value out of range is refused in the page: Save stays off", async () => {
  await threshold().fill("500");
  await expect(save()).toBeDisabled();
  await expect(doc().getByText("1–100")).toBeVisible();
  await threshold().fill("80");
  await expect(save()).toBeDisabled();
});

test("no console error, no page error, no response of 500 or more", () => {
  rig.assertClean();
});

import { defineConfig } from "@playwright/test";

/**
 * Browser tests. `bun run --cwd app e2e shell` builds app/dist, then runs app/e2e/shell.spec.ts in the installed
 * Google Chrome. Each spec starts its own engine on a temp STARSHIP_HOME.
 */
export default defineConfig({
  testDir: "./e2e",
  // Playwright empties its output folder at each run. The specs' screenshots live in test-results/<name>/, beside it.
  outputDir: "./test-results/.playwright",
  testMatch: "*.spec.ts",
  fullyParallel: false,
  workers: 1,
  retries: 0,
  timeout: 30_000,
  reporter: "list",
  use: { channel: "chrome", headless: true },
});

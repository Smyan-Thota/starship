import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { dirname } from "node:path";
import { ConfigError, DEFAULTS, home, loadConfig, paths, saveConfig, workerCount } from "../src/config.ts";
import { tempHome } from "./helpers.ts";

let h: ReturnType<typeof tempHome>;
beforeEach(() => {
  h = tempHome();
});
afterEach(() => h.restore());

function write(obj: unknown | string) {
  mkdirSync(dirname(paths.config()), { recursive: true });
  writeFileSync(paths.config(), typeof obj === "string" ? obj : JSON.stringify(obj));
}

describe("config", () => {
  test("STARSHIP_HOME moves every path", () => {
    expect(home()).toBe(h.dir);
    expect(paths.config().startsWith(h.dir)).toBe(true);
    expect(paths.chat("abc").startsWith(h.dir)).toBe(true);
  });

  test("no file gives the defaults from the spec", () => {
    const c = loadConfig();
    expect(c).toEqual(DEFAULTS);
    expect(c.terminalApp).toBe("iTerm");
    expect(c.workers).toBe(2);
    expect(c.maxWorkers).toBe(3);
    expect(c.checkAttempts).toBe(3);
    expect(c.checkTimeoutMin).toBe(15);
    expect(c.maxHeavy).toBe(1);
    expect(c.stallMin).toBe(10);
    expect(c.switch).toEqual({ enabled: true, at: 90, from: "claude", to: "codex" });
    expect(c.roles.admin).toEqual({ tool: "claude", model: "opus" });
    expect(c.roles.worker.tool).toBe("codex");
    expect(c.roles.cardRunner).toEqual({ tool: "codex", model: "luna" });
  });

  test("codexArgs: the Codex sandbox flags are a setting, a list of text, and an empty list is allowed", () => {
    expect(loadConfig().codexArgs).toEqual(["-s", "workspace-write", "-a", "never"]);
    write({ codexArgs: [] });
    expect(loadConfig().codexArgs).toEqual([]);
    write({ codexArgs: ["-s", "read-only"] });
    expect(loadConfig().codexArgs).toEqual(["-s", "read-only"]);
    expect(DEFAULTS.codexArgs).toEqual(["-s", "workspace-write", "-a", "never"]);
    for (const bad of ["-s", ["-s", 3], [null], { a: 1 }]) {
      write({ codexArgs: bad });
      expect(() => loadConfig()).toThrow("codexArgs");
    }
  });

  test("claudeArgs: flags for every Claude Code agent, a list of text, default empty, an empty list allowed", () => {
    expect(loadConfig().claudeArgs).toEqual([]);
    expect(DEFAULTS.claudeArgs).toEqual([]);
    write({ claudeArgs: ["--setting-sources", "project,local"] });
    expect(loadConfig().claudeArgs).toEqual(["--setting-sources", "project,local"]);
    write({ claudeArgs: [] });
    expect(loadConfig().claudeArgs).toEqual([]);
    for (const bad of ["--x", ["--x", 3], [null], { a: 1 }]) {
      write({ claudeArgs: bad });
      expect(() => loadConfig()).toThrow("claudeArgs");
    }
  });

  test("maxHeavy stays 1: 1 is accepted, any other value is refused with 'maxHeavy must be 1'", () => {
    write({ maxHeavy: 1 });
    expect(loadConfig().maxHeavy).toBe(1);
    for (const bad of [2, 0, 4, "1", null]) {
      write({ maxHeavy: bad });
      expect(() => loadConfig()).toThrow("maxHeavy must be 1");
    }
  });

  test("maxWorkers alone is valid and caps the default workers; both named and workers over maxWorkers is refused", () => {
    write({ maxWorkers: 1 });
    const c = loadConfig();
    expect(c.maxWorkers).toBe(1);
    expect(workerCount(c)).toBe(1);
    expect(workerCount({ ...DEFAULTS, workers: 3, maxWorkers: 2 })).toBe(2);
    expect(workerCount(DEFAULTS)).toBe(2);
    write({ workers: 3, maxWorkers: 2 });
    expect(() => loadConfig()).toThrow("workers");
  });

  test("a file changes only what it names", () => {
    write({ workers: 3, roles: { worker: { tool: "claude", model: "sonnet" } }, switch: { at: 80 } });
    const c = loadConfig();
    expect(c.workers).toBe(3);
    expect(c.roles.worker).toEqual({ tool: "claude", model: "sonnet" });
    expect(c.roles.admin).toEqual(DEFAULTS.roles.admin);
    expect(c.switch).toEqual({ enabled: true, at: 80, from: "claude", to: "codex" });
  });

  test("bins: the tool programs are settings, default claude and codex, and a file changes one tool at a time", () => {
    expect(loadConfig().bins).toEqual({ claude: ["claude"], codex: ["codex"] });
    write({ bins: { claude: ["bun", "/x/fake-agent.ts", "--as", "claude"] } });
    expect(loadConfig().bins).toEqual({ claude: ["bun", "/x/fake-agent.ts", "--as", "claude"], codex: ["codex"] });
    expect(DEFAULTS.bins).toEqual({ claude: ["claude"], codex: ["codex"] });
  });

  test("loading does not change the defaults object", () => {
    write({ roles: { admin: { model: "haiku" } } });
    loadConfig();
    expect(DEFAULTS.roles.admin.model).toBe("opus");
  });

  test("bad JSON is an error that names the file", () => {
    write("{ not json");
    expect(() => loadConfig()).toThrow(ConfigError);
    expect(() => loadConfig()).toThrow(paths.config());
  });

  test.each([
    [{ workers: 9 }, "workers"],
    [{ workers: 3, maxWorkers: 2 }, "workers"],
    [{ terminalApp: "Warp" }, "terminalApp"],
    [{ roles: { pilot: { tool: "claude" } } }, "roles.pilot"],
    [{ roles: { worker: { tool: "gemini" } } }, "roles.worker.tool"],
    [{ switch: { from: "codex", to: "codex" } }, "switch.from"],
    [{ switch: { at: 0 } }, "switch.at"],
    [[1, 2], "one JSON object"],
    [{ bins: [] }, "bins"],
    [{ bins: { claude: [] } }, "bins.claude"],
    [{ bins: { codex: ["codex", 3] } }, "bins.codex"],
    [{ bins: { codex: "codex" } }, "bins.codex"],
    [{ bins: { codex: [""] } }, "bins.codex"],
    [{ bins: { gemini: ["gemini"] } }, "bins.gemini"],
  ])("a wrong value is refused: %j", (obj, word) => {
    write(obj);
    expect(() => loadConfig()).toThrow(word);
  });

  test("saveConfig writes a file that loads back the same", () => {
    const c = loadConfig();
    c.workers = 1;
    c.roles.worker.model = "terra";
    saveConfig(c);
    expect(JSON.parse(readFileSync(paths.config(), "utf8")).workers).toBe(1);
    expect(loadConfig()).toEqual(c);
  });
});

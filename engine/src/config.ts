import { existsSync, mkdirSync, readFileSync, writeFileSync } from "node:fs";
import { homedir } from "node:os";
import { dirname, join } from "node:path";

export type Tool = "claude" | "codex";
export type RoleKey = "admin" | "orchestrator" | "worker" | "reviewer1" | "reviewer2" | "cardRunner";

export interface RoleSetting {
  tool: Tool;
  model: string;
}

export interface Config {
  terminalApp: "iTerm" | "Terminal";
  portFrom: number;
  workers: number;
  maxWorkers: number;
  checkAttempts: number;
  checkTimeoutMin: number;
  maxHeavy: number;
  stallMin: number;
  contextRestartAt: number;
  switch: { enabled: boolean; at: number; from: Tool; to: Tool };
  roles: Record<RoleKey, RoleSetting>;
  /** The flags that every Codex agent starts with: Codex's own sandbox. Empty: none. */
  codexArgs: string[];
  /** The flags that every Claude Code agent starts with, after the engine's own. Empty: none. */
  claudeArgs: string[];
  /** The argv that starts each tool. Default: the tool's own name. A test or a wrapper script may name another program. */
  bins: Record<Tool, string[]>;
}

/** Defaults from SPEC.md, "Defaults, with the why". */
export const DEFAULTS: Config = {
  terminalApp: "iTerm",
  portFrom: 8787,
  workers: 2,
  maxWorkers: 3,
  checkAttempts: 3,
  checkTimeoutMin: 15,
  maxHeavy: 1,
  stallMin: 10,
  contextRestartAt: 85,
  switch: { enabled: true, at: 90, from: "claude", to: "codex" },
  roles: {
    admin: { tool: "claude", model: "opus" },
    orchestrator: { tool: "claude", model: "opus" },
    worker: { tool: "codex", model: "" },
    reviewer1: { tool: "codex", model: "" },
    reviewer2: { tool: "claude", model: "sonnet" },
    cardRunner: { tool: "codex", model: "luna" },
  },
  codexArgs: ["-s", "workspace-write", "-a", "never"],
  claudeArgs: [],
  bins: { claude: ["claude"], codex: ["codex"] },
};

/** How many workers one chat gets: `workers`, and never more than `maxWorkers`. */
export function workerCount(cfg: Pick<Config, "workers" | "maxWorkers">): number {
  return Math.min(cfg.workers, cfg.maxWorkers);
}

export class ConfigError extends Error {
  constructor(
    public file: string,
    public reason: string,
  ) {
    super(`${file}: ${reason}`);
    this.name = "ConfigError";
  }
}

/** The root of Starship's own state. Tests point STARSHIP_HOME at a temp folder. */
export function home(): string {
  return process.env.STARSHIP_HOME || join(homedir(), ".starship");
}

export const paths = {
  config: () => join(home(), "config.json"),
  engine: () => join(home(), "engine.json"),
  repos: () => join(home(), "repos"),
  repo: (name: string) => join(home(), "repos", `${name}.json`),
  chats: () => join(home(), "chats"),
  chat: (id: string) => join(home(), "chats", id),
};

function isObject(v: unknown): v is Record<string, unknown> {
  return typeof v === "object" && v !== null && !Array.isArray(v);
}

function num(file: string, key: string, v: unknown, min: number, max: number): number {
  if (typeof v !== "number" || !Number.isFinite(v) || v < min || v > max) {
    throw new ConfigError(file, `"${key}" must be a number from ${min} to ${max}`);
  }
  return v;
}

function tool(file: string, key: string, v: unknown): Tool {
  if (v !== "claude" && v !== "codex") throw new ConfigError(file, `"${key}" must be "claude" or "codex"`);
  return v;
}

/** A non-empty list of non-empty text: the argv of a program. */
function argv(file: string, key: string, v: unknown): string[] {
  if (!Array.isArray(v) || v.length === 0 || !v.every((x): x is string => typeof x === "string" && x !== "")) {
    throw new ConfigError(file, `"${key}" must be a list of text, with at least one item`);
  }
  return [...v];
}

/** A list of text. It may be empty. */
function strings(file: string, key: string, v: unknown): string[] {
  if (!Array.isArray(v) || !v.every((x): x is string => typeof x === "string")) {
    throw new ConfigError(file, `"${key}" must be a list of text`);
  }
  return [...v];
}

/** Reads config.json over the defaults. A missing file gives the defaults. A bad file is an error that names the file. */
export function loadConfig(): Config {
  const file = paths.config();
  if (!existsSync(file)) return structuredClone(DEFAULTS);

  let raw: unknown;
  try {
    raw = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    throw new ConfigError(file, `not valid JSON (${(e as Error).message})`);
  }
  return parseConfig(raw, file);
}

/** Checks one config value over the defaults. `file` only names the source in the error. */
export function parseConfig(raw: unknown, file: string): Config {
  const cfg: Config = structuredClone(DEFAULTS);
  if (!isObject(raw)) throw new ConfigError(file, "must hold one JSON object");

  if ("terminalApp" in raw) {
    if (raw.terminalApp !== "iTerm" && raw.terminalApp !== "Terminal") {
      throw new ConfigError(file, `"terminalApp" must be "iTerm" or "Terminal"`);
    }
    cfg.terminalApp = raw.terminalApp;
  }
  if ("portFrom" in raw) cfg.portFrom = num(file, "portFrom", raw.portFrom, 1024, 65535);
  if ("workers" in raw) cfg.workers = num(file, "workers", raw.workers, 1, 3);
  if ("maxWorkers" in raw) cfg.maxWorkers = num(file, "maxWorkers", raw.maxWorkers, 1, 3);
  if ("checkAttempts" in raw) cfg.checkAttempts = num(file, "checkAttempts", raw.checkAttempts, 1, 10);
  if ("checkTimeoutMin" in raw) cfg.checkTimeoutMin = num(file, "checkTimeoutMin", raw.checkTimeoutMin, 1, 240);
  // One heavy command at a time on the whole Mac is a rule of the design, not a setting.
  if ("maxHeavy" in raw && raw.maxHeavy !== 1) throw new ConfigError(file, "maxHeavy must be 1");
  if ("stallMin" in raw) cfg.stallMin = num(file, "stallMin", raw.stallMin, 1, 240);
  if ("contextRestartAt" in raw) cfg.contextRestartAt = num(file, "contextRestartAt", raw.contextRestartAt, 10, 100);
  // A file that names both must agree. A file that names only maxWorkers caps the default: see `workerCount`.
  if ("workers" in raw && "maxWorkers" in raw && cfg.workers > cfg.maxWorkers) throw new ConfigError(file, `"workers" must not be more than "maxWorkers"`);
  if ("codexArgs" in raw) cfg.codexArgs = strings(file, "codexArgs", raw.codexArgs);
  if ("claudeArgs" in raw) cfg.claudeArgs = strings(file, "claudeArgs", raw.claudeArgs);

  if ("switch" in raw) {
    if (!isObject(raw.switch)) throw new ConfigError(file, `"switch" must be an object`);
    const s = raw.switch;
    if ("enabled" in s) {
      if (typeof s.enabled !== "boolean") throw new ConfigError(file, `"switch.enabled" must be true or false`);
      cfg.switch.enabled = s.enabled;
    }
    if ("at" in s) cfg.switch.at = num(file, "switch.at", s.at, 1, 100);
    if ("from" in s) cfg.switch.from = tool(file, "switch.from", s.from);
    if ("to" in s) cfg.switch.to = tool(file, "switch.to", s.to);
    if (cfg.switch.from === cfg.switch.to) throw new ConfigError(file, `"switch.from" and "switch.to" must differ`);
  }

  if ("roles" in raw) {
    if (!isObject(raw.roles)) throw new ConfigError(file, `"roles" must be an object`);
    for (const [key, value] of Object.entries(raw.roles)) {
      if (!(key in cfg.roles)) throw new ConfigError(file, `"roles.${key}" is not a role`);
      if (!isObject(value)) throw new ConfigError(file, `"roles.${key}" must be an object`);
      const role = cfg.roles[key as RoleKey];
      if ("tool" in value) role.tool = tool(file, `roles.${key}.tool`, value.tool);
      if ("model" in value) {
        if (typeof value.model !== "string") throw new ConfigError(file, `"roles.${key}.model" must be text`);
        role.model = value.model;
      }
    }
  }

  if ("bins" in raw) {
    if (!isObject(raw.bins)) throw new ConfigError(file, `"bins" must be an object`);
    for (const [key, value] of Object.entries(raw.bins)) {
      if (key !== "claude" && key !== "codex") throw new ConfigError(file, `"bins.${key}" is not a tool`);
      cfg.bins[key] = argv(file, `bins.${key}`, value);
    }
  }
  return cfg;
}

export function saveConfig(cfg: Config): void {
  const file = paths.config();
  mkdirSync(dirname(file), { recursive: true });
  writeFileSync(file, JSON.stringify(cfg, null, 2) + "\n");
}

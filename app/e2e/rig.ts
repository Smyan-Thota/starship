/**
 * The shared rig of the browser specs: a real engine on a temp STARSHIP_HOME, with the fake agent in place of Claude
 * Code and Codex, a page in the installed Chrome, and a teardown that leaves nothing behind.
 *
 * The engine runs with a temp STARSHIP_HOME, a temp FAKE_SESSIONS_DIR and STARSHIP_TMUX_PREFIX=sst-<random>-. Its
 * config.json points `bins` at engine/test/fake-agent.ts. Teardown stops the engine, kills the tmux sessions that
 * start with this rig's own prefix (and no other), and deletes the temp folders. It runs after a failure too.
 * Not a spec: Playwright runs only *.spec.ts.
 */
import { type ChildProcess, spawn, spawnSync } from "node:child_process";
import { cpSync, mkdirSync, mkdtempSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { fileURLToPath } from "node:url";
import { type Browser, expect, type Page } from "@playwright/test";
import type { ChatState } from "../../engine/src/types.ts";

export const ROOT = fileURLToPath(new URL("../..", import.meta.url));
const CLI = join(ROOT, "engine", "src", "cli.ts");
const FAKE = join(ROOT, "engine", "test", "fake-agent.ts");
const DIST = join(ROOT, "app", "dist");

/** The absolute path of bun. A spec may run under node, so the path comes from the shell. */
function bunPath(): string {
  const r = spawnSync("sh", ["-c", "command -v bun"], { encoding: "utf8" });
  const p = r.stdout.trim();
  if (r.status !== 0 || !p) throw new Error("bun is not on the PATH");
  return p;
}

export interface CliResult {
  code: number;
  out: string;
  err: string;
}

export interface Rig {
  home: string;
  work: string;
  prefix: string;
  address: string;
  /** Opens the window in a new page, with its problem listeners on. */
  open: (browser: Browser, viewport?: { width: number; height: number }) => Promise<Page>;
  /** Runs the real `starship` command against this engine. */
  cli: (args: string[], env?: Record<string, string>) => CliResult;
  get: <T>(path: string) => Promise<T>;
  post: (path: string, body?: unknown) => Promise<Response>;
  /** A temp git repo with one commit, added to the engine as `name`. Returns its path. */
  repo: (name: string) => string;
  /** The state of a chat through the route. */
  state: (id: string) => Promise<ChatState>;
  /** Console errors and uncaught page errors seen so far. */
  problems: string[];
  /** Responses with a status of 500 or more. */
  serverErrors: string[];
  /** Responses with a status of 400 or more, for the log. */
  refusals: string[];
  /** Fails when a page logged an error or a response had a status of 500 or more. */
  assertClean: () => void;
  stop: () => Promise<void>;
}

function firstLine(p: ChildProcess, ms: number): Promise<string> {
  return new Promise((resolve, reject) => {
    let out = "";
    let err = "";
    const timer = setTimeout(() => reject(new Error(`no address from the engine in ${ms} ms: ${err.trim()}`)), ms);
    p.stderr?.on("data", (d: Buffer) => {
      err += d.toString();
    });
    p.stdout?.on("data", (d: Buffer) => {
      out += d.toString();
      const nl = out.indexOf("\n");
      if (nl >= 0) {
        clearTimeout(timer);
        resolve(out.slice(0, nl));
      }
    });
    p.on("exit", (code) => {
      clearTimeout(timer);
      reject(new Error(`the engine exited with ${code}: ${err.trim()}`));
    });
  });
}

/** The tmux sessions whose name starts with the prefix. */
function sessionsOf(prefix: string): string[] {
  const r = spawnSync("tmux", ["list-sessions", "-F", "#{session_name}"], { encoding: "utf8" });
  if (r.status !== 0) return [];
  return r.stdout.split("\n").filter((n) => n.startsWith(prefix));
}

export async function startRig(): Promise<Rig> {
  const rand = Math.random().toString(36).slice(2, 10);
  const prefix = `sst-${rand}-`;
  const home = realpathSync(mkdtempSync(join(tmpdir(), "starship-e2e-home-")));
  const work = realpathSync(mkdtempSync(join(tmpdir(), "starship-e2e-work-")));
  const fakeDir = realpathSync(mkdtempSync(join(tmpdir(), "starship-e2e-fake-")));
  const bun = bunPath();
  writeFileSync(join(home, "config.json"), JSON.stringify({ bins: { claude: [bun, FAKE, "--as", "claude"], codex: [bun, FAKE, "--as", "codex"] } }));
  const env = { ...process.env, STARSHIP_HOME: home, FAKE_SESSIONS_DIR: fakeDir, STARSHIP_TMUX_PREFIX: prefix };

  let engine: ChildProcess | null = null;
  const problems: string[] = [];
  const serverErrors: string[] = [];
  const refusals: string[] = [];
  const pages: Page[] = [];

  const stop = async () => {
    for (const p of pages.splice(0)) await p.close().catch(() => {});
    const p = engine;
    engine = null;
    if (p && p.exitCode === null && p.signalCode === null) {
      const gone = new Promise<void>((resolve) => p.once("exit", () => resolve()));
      p.kill("SIGTERM");
      const late = setTimeout(() => p.kill("SIGKILL"), 3000);
      await gone;
      clearTimeout(late);
    }
    // Only sessions of this rig's own prefix.
    for (const name of sessionsOf(prefix)) spawnSync("tmux", ["kill-session", "-t", `=${name}`]);
    for (const d of [home, work, fakeDir]) rmSync(d, { recursive: true, force: true });
  };

  try {
    const port = 20000 + Math.floor(Math.random() * 20000);
    engine = spawn(bun, [CLI, "daemon", "--port", String(port), "--static", DIST], { env, cwd: ROOT, stdio: ["ignore", "pipe", "pipe"] });
    const line = await firstLine(engine, 15_000);
    const m = line.match(/(http:\/\/127\.0\.0\.1:(\d+)\/\?token=([0-9a-f]+))/);
    if (!m?.[1] || !m[2] || !m[3]) throw new Error(`unexpected engine line: ${line}`);
    const address = m[1];
    const base = `http://127.0.0.1:${m[2]}`;
    const token = m[3];

    const api = (path: string, init: RequestInit = {}) => {
      const headers = new Headers(init.headers);
      headers.set("authorization", `Bearer ${token}`);
      if (init.body) headers.set("content-type", "application/json");
      return fetch(`${base}${path}`, { ...init, headers });
    };

    const rig: Rig = {
      home,
      work,
      prefix,
      address,
      problems,
      serverErrors,
      refusals,
      open: async (browser, viewport = { width: 1400, height: 900 }) => {
        const page = await browser.newPage({ viewport });
        pages.push(page);
        page.on("console", (msg) => {
          if (msg.type() !== "error") return;
          // The browser words a failed load as "Failed to load resource"; the response listener names the URL.
          if (msg.text().startsWith("Failed to load resource")) return;
          problems.push(`console: ${msg.text()}`);
        });
        page.on("pageerror", (e) => problems.push(`pageerror: ${e.message}`));
        page.on("response", (r) => {
          const line = `${r.status()} ${r.request().method()} ${new URL(r.url()).pathname}`;
          if (r.status() >= 500) serverErrors.push(line);
          if (r.status() >= 400) refusals.push(line);
        });
        await page.goto(address);
        return page;
      },
      cli: (args, extra = {}) => {
        const r = spawnSync(bun, [CLI, ...args], { env: { ...env, ...extra }, cwd: ROOT, encoding: "utf8", timeout: 30_000 });
        return { code: r.status ?? -1, out: r.stdout, err: r.stderr };
      },
      get: async <T>(path: string) => {
        const res = await api(path);
        if (!res.ok) throw new Error(`${path}: ${res.status} ${await res.text()}`);
        return (await res.json()) as T;
      },
      post: (path, body) => api(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
      repo: (name) => {
        const dir = join(work, `repo-${name}`);
        mkdirSync(dir);
        const git = (...args: string[]) => {
          const r = spawnSync("git", ["-c", "user.name=e2e", "-c", "user.email=e2e@example.invalid", "-c", "commit.gpgsign=false", ...args], { cwd: dir, encoding: "utf8" });
          if (r.status !== 0) throw new Error(`git ${args[0]} failed: ${r.stderr}`);
        };
        git("init", "-q", "-b", "main");
        writeFileSync(join(dir, "README.md"), "# Repo\n");
        git("add", ".");
        git("commit", "-q", "-m", "start");
        const added = rig.cli(["repo", "add", dir, "--name", name, "--base", "main"]);
        if (added.code !== 0) throw new Error(`repo add failed: ${added.err}`);
        return dir;
      },
      state: (id) => rig.get<ChatState>(`/api/chats/${id}`),
      assertClean: () => {
        if (rig.refusals.length > 0) console.log(`responses with status >= 400:\n${[...new Set(rig.refusals)].join("\n")}`);
        expect(rig.problems).toEqual([]);
        expect(rig.serverErrors).toEqual([]);
      },
      stop,
    };
    return rig;
  } catch (e) {
    await stop();
    throw e;
  }
}

/** The folder of one spec's screenshots, app/test-results/<name>/. */
export function shotsDir(name: string): string {
  const dir = join(ROOT, "app", "test-results", name);
  rmSync(dir, { recursive: true, force: true });
  mkdirSync(dir, { recursive: true });
  return dir;
}

export const BIG = { width: 1400, height: 900 };
export const SMALL = { width: 1100, height: 700 };

/**
 * Two screenshots of the whole page: <name>.png at 1400 wide and <name>-1100.png at 1100 wide. The window scrolls inside
 * its own pages, so the viewport grows to the height of the content for the picture. Also two checks at the real sizes
 * of 1400 x 900 and 1100 x 700: the page does not overflow sideways, and the input of the conversation stays in view.
 * Scrollable regions of their own (the map, a code block) do not count as overflow.
 */
export async function shotBoth(page: Page, dir: string, name: string): Promise<void> {
  for (const [vp, suffix] of [[BIG, ""], [SMALL, "-1100"]] as const) {
    await page.setViewportSize(vp);
    await page.waitForTimeout(150);
    const over = await page.evaluate(() => {
      const w = document.documentElement.clientWidth;
      const out: string[] = [];
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        // An element inside a region that scrolls sideways may reach beyond the page. The region is the overflow.
        let scroller = el.parentElement;
        let inside = false;
        while (scroller && scroller !== document.body) {
          const o = getComputedStyle(scroller).overflowX;
          if (o === "auto" || o === "scroll" || o === "hidden") {
            inside = true;
            break;
          }
          scroller = scroller.parentElement;
        }
        if (inside) continue;
        const r = el.getBoundingClientRect();
        if (r.width > 0 && r.right > w + 1) out.push(`${el.tagName.toLowerCase()}.${el.className} right=${Math.round(r.right)} of ${w}`);
      }
      // A region that scrolls sideways on its own is allowed for the map, code and tables. Any other one is clipped content.
      for (const el of document.querySelectorAll<HTMLElement>("body *")) {
        const o = getComputedStyle(el).overflowX;
        if ((o === "auto" || o === "scroll") && el.scrollWidth > el.clientWidth + 1 && !el.matches(".map-wrap, pre, .ap-prompt, .md table, .md pre")) {
          out.push(`${el.tagName.toLowerCase()}.${el.className} scrolls sideways: ${el.scrollWidth} in ${el.clientWidth}`);
        }
      }
      const form = document.querySelector<HTMLElement>("section.chat form");
      const chatShown = form !== null && getComputedStyle(form.closest("section") as Element).display !== "none";
      const formBottom = chatShown && form ? form.getBoundingClientRect().bottom : 0;
      return { scrollW: document.documentElement.scrollWidth, w, h: window.innerHeight, formBottom, out: out.slice(0, 5) };
    });
    expect(over.out, `an element reaches past the page at ${vp.width} x ${vp.height}`).toEqual([]);
    expect(over.scrollW, `the page scrolls sideways at ${vp.width} x ${vp.height}`).toBeLessThanOrEqual(over.w);
    expect(over.formBottom, `the input of the conversation is in view at ${vp.width} x ${vp.height}`).toBeLessThanOrEqual(over.h + 1);
    // The picture: a viewport as tall as the page's content.
    const need = await page.evaluate(() => {
      const scrolls = Array.from(document.querySelectorAll<HTMLElement>(".page, .msgs, .side"));
      return Math.max(0, ...scrolls.map((el) => el.scrollHeight + el.getBoundingClientRect().top));
    });
    await page.setViewportSize({ width: vp.width, height: Math.max(vp.height, Math.min(4000, Math.ceil(need) + 24)) });
    await page.waitForTimeout(150);
    await page.screenshot({ path: join(dir, `${name}${suffix}.png`) });
  }
  await page.setViewportSize(BIG);
}

/** Copies a fixture folder into the rig's work folder. */
export function copyFixture(rig: Rig, name: string, to: string): string {
  const dest = join(rig.work, to);
  cpSync(join(ROOT, "fixtures", name), dest, { recursive: true });
  return dest;
}

/** The common wait for an engine fact that a spec drives from the CLI: polls the chat state until `check` holds. */
export async function waitState(rig: Rig, id: string, what: string, check: (s: ChatState) => boolean, timeout = 60_000): Promise<ChatState> {
  let last: ChatState | null = null;
  await expect
    .poll(
      async () => {
        last = await rig.state(id);
        return check(last);
      },
      { message: what, timeout, intervals: [200, 400, 800] },
    )
    .toBe(true);
  if (!last) throw new Error(`no state for ${what}`);
  return last;
}

/** A plan that the engine's validator accepts: the files of docs/features/<slug>/ other than TASKS.md. */
export const PLAN_FILES = {
  "SPEC.md": "# SPEC\n\n## Problem\n\nA problem.\n\n## Scope\n\n- one\n",
  "PLAN.md": ["# PLAN", "", "## Goal", "", "A goal.", "", "## In scope", "", "1. Alpha", "", "## Out of scope", "", "- Gamma", "", "## Data", "", "## Interfaces", "", "## Errors", "", "## Edge cases", "", "## Tests", "", "## Rollout", ""].join("\n"),
  "ACCEPTANCE.md": "# Acceptance\n\n## Behavior\n\n- Alpha works.\n",
} as const;

/** Makes a chat on a repo and writes a valid plan with the given TASKS.md into its feature folder. Returns the chat id. */
export async function planChat(rig: Rig, title: string, repo: string, tasks: string): Promise<{ id: string; dir: string; worktree: string }> {
  const made = await rig.post("/api/chats", { title, repo });
  if (!made.ok) throw new Error(`chat new failed: ${await made.text()}`);
  const state = (await made.json()) as ChatState;
  const dir = state.chat.featureDir;
  if (!dir || !state.chat.worktree) throw new Error("the chat has no feature folder");
  for (const [name, text] of Object.entries(PLAN_FILES)) writeFileSync(join(dir, name), text);
  writeFileSync(join(dir, "TASKS.md"), tasks);
  return { id: state.chat.id, dir, worktree: state.chat.worktree };
}

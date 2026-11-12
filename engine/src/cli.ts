#!/usr/bin/env bun
/**
 * The `starship` command.
 *
 *   starship daemon [--port N] [--static <dir>]
 *   starship status [--json]
 *   starship repo add <path> [--name <n>] [--base <branch>] | list
 *   starship chat new --title <t> [--repo <name>] [--feature <slug>] [--folder <path>] | list
 *   starship plan check | map build|import|validate|overlay | note | ask | answer | finding ... | card result
 *   starship note ack | task add|edit|split|block|drop|retry | check <task> | chat halt|resume <id>
 *   starship agent pause|resume|restart <chat> <agent> | term <chat> <agent>
 *   starship hook <claude|codex> [json] | status   (the tools' own hooks: see hook-entry.ts)
 *
 * Repo and chat commands call the library directly: the files are the state. Then they ask a running
 * engine to announce the change. A stopped engine is not an error.
 *
 * The commands of the agents and the admin agent call the engine over HTTP with the token. The chat comes
 * from `--chat <id>` or STARSHIP_CHAT, the agent from STARSHIP_AGENT. Each prints one short line and exits 0,
 * or prints the engine's error and exits 1.
 */
import { chmodSync, existsSync, readFileSync, statSync, writeFileSync } from "node:fs";
import { join, resolve } from "node:path";
import { routes } from "./api.ts";
import { type Engine, createEngine } from "./engine.ts";
import { main as hookMain } from "./hook-entry.ts";
import { createChat, listChats } from "./chats.ts";
import { home, loadConfig, paths } from "./config.ts";
import { readMapFile } from "./map/schema.ts";
import { addRepo, listRepos } from "./repos.ts";
import { type EngineInfo, type EngineServer, LOOPBACK, readInfo, startServer } from "./server.ts";
import type { EngineEvent } from "./types.ts";
import { FolderWatcher, PlanWatch } from "./watch.ts";

const USAGE = `usage:
  starship daemon [--port N] [--static <dir>]
  starship status [--json]
  starship repo add <path> [--name <n>] [--base <branch>]
  starship repo list
  starship chat new --title <t> [--repo <name>] [--feature <slug>] [--folder <path>]
  starship chat list
  starship plan check [--chat <id>]
  starship map build <repo>
  starship map import <file> --repo <name>
  starship map validate <file>
  starship map overlay <file> [--chat <id>]
  starship note --to orchestrator|plan|fixes|repo --said "<words>" "<note>" [--chat <id>]
  starship ask --task <id> "<question>" [--chat <id>]
  starship answer <Qn> "<text>" [--chat <id>]
  starship finding add --sev high|medium|low --where <file:line> "<text>" [--chat <id>]
  starship finding dispute <n> "<why>" [--chat <id>]
  starship finding accept <n> [--chat <id>]
  starship finding reject <n> "<why>" [--chat <id>]
  starship card result <card> pass|fail|unclear "<note>" [--chat <id>]
  starship note ack <n>... [--chat <id>]
  starship task add --phase <n> --text "<t>" --files <a,b> --verify "<cmd>" [--parallel] [--chat <id>]
  starship task edit <id> [--text "<t>"] [--files <a,b>] [--verify "<cmd>"] [--chat <id>]
  starship task split <id> --into "<a>" "<b>" [--chat <id>]
  starship task block <id> --reason "<why>" [--chat <id>]
  starship task drop <id> --reason "<why>" [--chat <id>]
  starship task retry <id> [--chat <id>]
  starship check <task> [--chat <id>]
  starship finding none [--chat <id>]
  starship chat halt <id>
  starship chat resume <id>
  starship agent pause|resume|restart <chat> <agent>
  starship term <chat> <agent>
  starship hook <claude|codex> [json]
The chat is --chat or STARSHIP_CHAT. The agent is STARSHIP_AGENT.`;

class UsageError extends Error {}

/** The engine refused, or is not there. The message is printed whole. */
class EngineError extends Error {
  constructor(
    message: string,
    /** The list the engine sent with a refusal, such as the errors of a map overlay. */
    public errors: string[] = [],
  ) {
    super(message);
  }
}

interface Args {
  pos: string[];
  flags: Map<string, string | true>;
}

function parse(argv: string[], valued: string[], bare: string[]): Args {
  const pos: string[] = [];
  const flags = new Map<string, string | true>();
  for (let i = 0; i < argv.length; i++) {
    const a = argv[i] ?? "";
    if (a.startsWith("--")) {
      const [key = "", inline] = a.slice(2).split(/=(.*)/s, 2);
      if (bare.includes(key) && inline === undefined) flags.set(key, true);
      else if (valued.includes(key)) {
        const v = inline ?? argv[++i];
        if (v === undefined || v === "") throw new UsageError(`--${key} needs a value`);
        flags.set(key, v);
      } else throw new UsageError(`unknown option --${key}`);
    } else pos.push(a);
  }
  return { pos, flags };
}

function str(args: Args, key: string): string | undefined {
  const v = args.flags.get(key);
  return typeof v === "string" ? v : undefined;
}

async function health(info: EngineInfo): Promise<boolean> {
  try {
    const res = await fetch(`http://${LOOPBACK}:${info.port}/health`, { signal: AbortSignal.timeout(1000) });
    if (!res.ok) return false;
    const body = (await res.json()) as { ok?: boolean; pid?: number };
    return body.ok === true && body.pid === info.pid;
  } catch {
    return false;
  }
}

async function live(): Promise<EngineInfo | null> {
  const info = readInfo();
  return info && (await health(info)) ? info : null;
}

/** Asks a running engine to push events. A stopped engine is not an error. */
async function refresh(chat?: string): Promise<void> {
  const info = await live();
  if (!info) return;
  try {
    const q = chat ? `?chat=${encodeURIComponent(chat)}` : "";
    await fetch(`http://${LOOPBACK}:${info.port}/api/refresh${q}`, { method: "POST", headers: { authorization: `Bearer ${info.token}` }, signal: AbortSignal.timeout(1000) });
  } catch {
    // The engine went away; the files are already written.
  }
}

/** One request to the running engine. A refusal is an EngineError with the engine's own text. */
async function call(method: "GET" | "POST", path: string, body?: unknown, timeoutMs = 10_000): Promise<Record<string, unknown>> {
  const info = await live();
  if (!info) throw new EngineError("the engine is not running. Start it with: starship daemon");
  let res: Response;
  try {
    res = await fetch(`http://${LOOPBACK}:${info.port}${path}`, {
      method,
      headers: { authorization: `Bearer ${info.token}`, ...(body === undefined ? {} : { "content-type": "application/json" }) },
      ...(body === undefined ? {} : { body: JSON.stringify(body) }),
      signal: AbortSignal.timeout(timeoutMs),
    });
  } catch (e) {
    throw new EngineError(`the engine did not answer: ${(e as Error).message}`);
  }
  const data: unknown = await res.json().catch(() => ({}));
  const out = typeof data === "object" && data !== null && !Array.isArray(data) ? (data as Record<string, unknown>) : {};
  if (!res.ok) {
    const errors = Array.isArray(out.errors) ? out.errors.filter((x): x is string => typeof x === "string") : [];
    throw new EngineError(typeof out.error === "string" ? out.error : `the engine answered ${res.status}`, errors);
  }
  return out;
}

const enc = encodeURIComponent;

function chatOf(args: Args): string {
  const id = str(args, "chat") ?? process.env.STARSHIP_CHAT;
  if (!id) throw new UsageError("this command needs --chat <id> or STARSHIP_CHAT");
  return id;
}

function agentOf(): string {
  const id = process.env.STARSHIP_AGENT;
  if (!id) throw new UsageError("this command needs STARSHIP_AGENT");
  return id;
}

/** The words of a command: every positional from `from` on, as one text. */
function words(args: Args, from: number, what: string, required = true): string {
  const text = args.pos.slice(from).join(" ").trim();
  if (required && !text) throw new UsageError(`${what} is missing`);
  return text;
}

const address = (info: EngineInfo) => `Starship engine http://${LOOPBACK}:${info.port}/?token=${info.token}`;

/**
 * The argv that runs this same program. A compiled binary runs itself. Bun's compiled files live under `/$bunfs/`
 * (`B:/~BUN/` on Windows), so `import.meta.path` there is no file that `bun` can run.
 */
export function selfArgv(): string[] {
  const compiled = import.meta.path.startsWith("/$bunfs/") || import.meta.path.includes("~BUN");
  return compiled ? [process.execPath] : [process.execPath, import.meta.path];
}

/** The daemon must be listening, with engine.json written, this long after start. Edge I6. */
export const STARTUP_LIMIT_MS = 5000;

async function daemon(argv: string[]): Promise<number> {
  // Last line of defense (edge I6): whatever blocks the startup path, the daemon says so and exits 1.
  let server: EngineServer | undefined;
  const watchdog = setTimeout(() => {
    console.error(`The engine did not start within ${STARTUP_LIMIT_MS / 1000} s: ${server ? `${paths.engine()} does not name it` : "no port is bound"}`);
    server?.stop();
    process.exit(1);
  }, STARTUP_LIMIT_MS);
  try {
    return await runDaemon(argv, (s) => {
      server = s;
    }, () => clearTimeout(watchdog));
  } finally {
    clearTimeout(watchdog);
  }
}

/** The FAKE_* variables of the daemon's environment. They go on to the agents, so a test can run the daemon on the fake agent. */
function fakeEnv(source: NodeJS.ProcessEnv): Record<string, string> {
  const out: Record<string, string> = {};
  for (const [k, v] of Object.entries(source)) if (k.startsWith("FAKE_") && v !== undefined) out[k] = v;
  return out;
}

async function runDaemon(argv: string[], started: (s: EngineServer) => void, ready: () => void): Promise<number> {
  const args = parse(argv, ["port", "static"], []);
  if (args.pos.length) throw new UsageError(`unexpected ${args.pos[0]}`);
  let port: number | undefined;
  const p = str(args, "port");
  if (p !== undefined) {
    port = Number(p);
    if (!Number.isInteger(port) || port < 1024 || port > 65535) throw new UsageError("--port must be a number from 1024 to 65535");
  }
  let staticDir = str(args, "static");
  if (staticDir !== undefined) {
    staticDir = resolve(staticDir);
    if (!existsSync(staticDir) || !statSync(staticDir).isDirectory()) throw new Error(`${staticDir} is not a folder`);
  } else {
    const built = join(import.meta.dir, "..", "..", "app", "dist");
    if (existsSync(built)) staticDir = built;
  }

  const running = await live();
  if (running) {
    console.log(address(running));
    return 0;
  }

  const watchers = new Map<string, { dir: string; watcher: FolderWatcher; plan: PlanWatch }>();
  let server: EngineServer | undefined;
  const publish = (e: EngineEvent) => {
    server?.publish(e);
    if (e.type === "chats") sync();
  };
  // The engine runs this same program as its hook, and `<home>/bin/starship` runs it for the agents.
  const cfg = loadConfig();
  const prefix = process.env.STARSHIP_TMUX_PREFIX;
  const engine: Engine = createEngine({
    publish,
    self: selfArgv(),
    bins: cfg.bins,
    ...(prefix ? { prefix } : {}),
    env: fakeEnv(process.env),
  });
  const sync = () => {
    const want = new Map<string, string>();
    for (const c of listChats()) {
      if (c.featureDir && existsSync(c.featureDir) && statSync(c.featureDir).isDirectory()) want.set(c.id, c.featureDir);
    }
    for (const [id, w] of watchers) {
      if (want.get(id) !== w.dir) {
        w.watcher.close();
        watchers.delete(id);
      }
    }
    for (const [id, dir] of want) {
      if (watchers.has(id)) continue;
      try {
        const watcher = new FolderWatcher(dir, (changed) => {
          server?.publish({ type: "chat", id });
          // TASKS.md, or the folder itself, changed: the build looks at the chat again.
          if (changed.some((p) => p === "TASKS.md" || p === "." || p === "")) engine.loop.kick(id);
        });
        watchers.set(id, { dir, watcher, plan: new PlanWatch(dir) });
      } catch {
        // The folder went away between the check and the watch. The chat shows it as missing.
      }
    }
  };

  const portFrom = port ?? cfg.portFrom;
  // The token outlives one engine run: an open window and its cookie then work again after a restart,
  // with no new address to open. It is kept in its own 0600 file, because engine.json goes away on a clean stop.
  const tokenFile = join(home(), "token");
  let kept: string | undefined;
  try {
    const t = readFileSync(tokenFile, "utf8").trim();
    if (/^[0-9a-f]{32,128}$/.test(t)) kept = t;
  } catch {
    // no token yet
  }
  server = startServer({
    routes: routes({ publish, engine, handEdits: (id) => watchers.get(id)?.plan.handEdits() ?? [] }),
    portFrom,
    ...(kept ? { token: kept } : {}),
    ...(staticDir ? { staticDir } : {}),
  });
  started(server);
  if (!kept) {
    try {
      writeFileSync(tokenFile, server.info.token + "\n", { mode: 0o600 });
      chmodSync(tokenFile, 0o600);
    } catch {
      // The engine still runs. The next start then makes a new token.
    }
  }
  const written = readInfo();
  if (!written || written.pid !== server.info.pid || written.port !== server.info.port || written.token !== server.info.token) {
    server.stop();
    throw new Error(`${paths.engine()} does not name this engine after the write`);
  }
  ready();
  sync();
  console.log(address(server.info));

  const live_ = server;
  const stopped = new Promise<void>((done) => {
    const stop = () => {
      engine.stop();
      for (const w of watchers.values()) w.watcher.close();
      watchers.clear();
      live_.stop();
      done();
    };
    process.once("SIGINT", stop);
    process.once("SIGTERM", stop);
  });
  // The agents' own state comes back after the address is out: a slow tmux must not delay the start.
  engine.start().catch((e: unknown) => console.error(`the engine did not recover its agents: ${(e as Error).message}`));
  await stopped;
  return 0;
}

/** The text on stdin, or "" when stdin is a terminal, is closed, or says nothing within `ms`. */
async function stdinText(ms: number): Promise<string> {
  if (process.stdin.isTTY) return "";
  try {
    return await Promise.race([Bun.stdin.text(), Bun.sleep(ms).then(() => "")]);
  } catch {
    return "";
  }
}

async function status(argv: string[]): Promise<number> {
  const args = parse(argv, [], ["json"]);
  if (args.pos.length) throw new UsageError(`unexpected ${args.pos[0]}`);
  if (!args.flags.has("json")) {
    // Claude Code runs `starship status` as its status line command, with its JSON on stdin. A person runs it in a terminal.
    const input = await stdinText(1000);
    if (input.trim() !== "") {
      process.stdout.write(`${await hookMain(["status"], input)}\n`);
      return 0;
    }
  }
  const info = await live();
  if (args.flags.has("json")) {
    console.log(JSON.stringify(info ? { running: true, pid: info.pid, port: info.port, url: `http://${LOOPBACK}:${info.port}` } : { running: false }));
  } else {
    console.log(info ? `running http://${LOOPBACK}:${info.port} pid ${info.pid}` : "not running");
  }
  return 0;
}

async function repo(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "add") {
    const args = parse(rest, ["name", "base"], []);
    if (args.pos.length !== 1) throw new UsageError("repo add needs one path");
    const name = str(args, "name");
    const base = str(args, "base");
    const r = addRepo(resolve(args.pos[0] ?? ""), { ...(name ? { name } : {}), ...(base ? { base } : {}) });
    console.log(`${r.name}\t${r.baseBranch}\t${r.path}`);
    await refresh();
    return 0;
  }
  if (sub === "list") {
    const args = parse(rest, [], []);
    if (args.pos.length) throw new UsageError(`unexpected ${args.pos[0]}`);
    for (const r of listRepos()) console.log(`${r.name}\t${r.baseBranch}\t${r.path}`);
    return 0;
  }
  throw new UsageError(`unknown command: repo ${sub ?? ""}`.trim());
}

async function chat(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "new") {
    const args = parse(rest, ["title", "repo", "feature", "folder"], []);
    if (args.pos.length) throw new UsageError(`unexpected ${args.pos[0]}`);
    const title = str(args, "title");
    if (!title) throw new UsageError("chat new needs --title");
    const repoName = str(args, "repo");
    const folder = str(args, "folder");
    const feature = str(args, "feature");
    const c = createChat({ title, ...(repoName ? { repo: repoName } : {}), ...(feature ? { feature } : {}), ...(folder ? { folder: resolve(folder) } : {}) });
    console.log(c.id);
    await refresh(c.id);
    return 0;
  }
  if (sub === "list") {
    const args = parse(rest, [], []);
    if (args.pos.length) throw new UsageError(`unexpected ${args.pos[0]}`);
    for (const c of listChats()) console.log(`${c.id}\t${c.stage ?? "-"}\t${c.title}`);
    return 0;
  }
  if (sub === "halt" || sub === "resume") {
    const args = parse(rest, [], []);
    if (args.pos.length !== 1) throw new UsageError(`chat ${sub} needs one chat id`);
    const id = args.pos[0] ?? "";
    const got = await call("POST", `/api/chats/${enc(id)}/${sub}`);
    const did = sub === "halt" ? got.halted : got.resumed;
    console.log(`${id} ${sub === "halt" ? (did ? "halted" : "was halted already") : did ? "resumed" : "had nothing to resume"}`);
    return 0;
  }
  throw new UsageError(`unknown command: chat ${sub ?? ""}`.trim());
}

async function plan(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "check") throw new UsageError(`unknown command: plan ${sub ?? ""}`.trim());
  const args = parse(rest, ["chat"], []);
  if (args.pos.length) throw new UsageError(`unexpected ${args.pos[0]}`);
  const got = await call("GET", `/api/chats/${enc(chatOf(args))}/plan/check`);
  const problems = Array.isArray(got.problems) ? (got.problems as { file: string; line: number | null; text: string }[]) : [];
  if (!problems.length) {
    console.log("plan is valid");
    return 0;
  }
  for (const p of problems) console.log(`${p.file}${p.line === null ? "" : `:${p.line}`} ${p.text}`);
  return 1;
}

async function map(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "build") {
    const args = parse(rest, [], []);
    if (args.pos.length !== 1) throw new UsageError("map build needs one repo name");
    const repoName = args.pos[0] ?? "";
    const got = await call("POST", `/api/repos/${enc(repoName)}/map/build`);
    const boxes = (got.map as { boxes?: unknown[] } | null)?.boxes?.length ?? 0;
    console.log(`map built for ${repoName}: ${boxes} boxes, low detail`);
    return 0;
  }
  if (sub === "import") {
    const args = parse(rest, ["repo"], []);
    const repoName = str(args, "repo");
    if (args.pos.length !== 1) throw new UsageError("map import needs one file");
    if (!repoName) throw new UsageError("map import needs --repo <name>");
    const got = await call("POST", `/api/repos/${enc(repoName)}/map/import`, { file: resolve(args.pos[0] ?? "") });
    console.log(`map imported for ${repoName}: ${(got.map as { name?: string } | null)?.name ?? ""}`.trimEnd());
    return 0;
  }
  if (sub === "overlay") {
    const args = parse(rest, ["chat"], []);
    if (args.pos.length !== 1) throw new UsageError("map overlay needs one file");
    const file = resolve(args.pos[0] ?? "");
    try {
      await call("POST", `/api/chats/${enc(chatOf(args))}/map/overlay`, { file });
    } catch (e) {
      if (e instanceof EngineError && e.errors.length > 0) {
        console.error(e.message);
        for (const x of e.errors) console.error(`- ${x}`);
        return 1;
      }
      throw e;
    }
    console.log("overlay written");
    return 0;
  }
  if (sub === "validate") {
    // Local: it reads the file and needs no engine.
    const args = parse(rest, [], []);
    if (args.pos.length !== 1) throw new UsageError("map validate needs one file");
    const { map: value, errors } = readMapFile(resolve(args.pos[0] ?? ""));
    if (value === null) {
      for (const e of errors) console.error(`- ${e}`);
      return 1;
    }
    console.log(`map is valid: ${value.name}`);
    return 0;
  }
  throw new UsageError(`unknown command: map ${sub ?? ""}`.trim());
}

async function noteAck(argv: string[]): Promise<number> {
  const args = parse(argv, ["chat"], []);
  if (args.pos.length === 0) throw new UsageError("note ack needs one note number or more");
  const numbers = args.pos.map((p) => {
    const n = Number(p.replace(/^N/i, ""));
    if (!Number.isInteger(n) || n < 1) throw new UsageError(`"${p}" is not a note number`);
    return n;
  });
  await call("POST", `/api/chats/${enc(chatOf(args))}/notes/ack`, { numbers });
  console.log(`read ${numbers.map((n) => `note ${n}`).join(", ")}`);
  return 0;
}

async function note(argv: string[]): Promise<number> {
  if (argv[0] === "ack") return noteAck(argv.slice(1));
  const args = parse(argv, ["to", "said", "chat"], []);
  const to = str(args, "to");
  const said = str(args, "said");
  if (!to) throw new UsageError("note needs --to <target>");
  if (said === undefined) throw new UsageError('note needs --said "<words>"');
  const text = words(args, 0, "the note");
  const got = await call("POST", `/api/chats/${enc(chatOf(args))}/notes`, { to, said, note: text });
  console.log(`note ${String(got.n)} ${String(got.status)}`);
  return 0;
}

async function ask(argv: string[]): Promise<number> {
  const args = parse(argv, ["task", "chat"], []);
  const task = str(args, "task");
  if (!task) throw new UsageError("ask needs --task <id>");
  const got = await call("POST", `/api/chats/${enc(chatOf(args))}/questions`, { task, text: words(args, 0, "the question"), agent: agentOf() });
  console.log(`Q${String(got.n)} asked`);
  return 0;
}

async function answer(argv: string[]): Promise<number> {
  const args = parse(argv, ["chat"], []);
  const q = args.pos[0];
  if (!q) throw new UsageError("answer needs a question number such as Q3");
  const got = await call("POST", `/api/chats/${enc(chatOf(args))}/questions/${enc(q)}/answer`, { text: words(args, 1, "the answer") });
  console.log(`Q${String(got.n)} answered`);
  return 0;
}

async function finding(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub === "add") {
    const args = parse(rest, ["sev", "where", "chat"], []);
    const sev = str(args, "sev");
    const where = str(args, "where");
    if (!sev) throw new UsageError("finding add needs --sev high|medium|low");
    if (!where) throw new UsageError("finding add needs --where <file:line>");
    const got = await call("POST", `/api/chats/${enc(chatOf(args))}/findings`, { sev, where, text: words(args, 0, "the finding"), reviewer: agentOf() });
    console.log(`F${String(got.n)} ${String(got.status)}`);
    return 0;
  }
  if (sub === "none") {
    const args = parse(rest, ["chat"], []);
    if (args.pos.length) throw new UsageError(`unexpected ${args.pos[0]}`);
    await call("POST", `/api/chats/${enc(chatOf(args))}/findings/none`, { reviewer: agentOf() });
    console.log(`${agentOf()} found nothing`);
    return 0;
  }
  if (sub === "dispute" || sub === "accept" || sub === "reject") {
    const args = parse(rest, ["chat"], []);
    const n = args.pos[0];
    if (!n) throw new UsageError(`finding ${sub} needs a finding number`);
    const chat = enc(chatOf(args));
    const path = `/api/chats/${chat}/findings/${enc(n.replace(/^F/i, ""))}/${sub}`;
    const body = sub === "dispute" ? { reviewer: agentOf(), why: words(args, 1, "the reason") } : sub === "reject" ? { why: words(args, 1, "the reason") } : undefined;
    const got = await call("POST", path, body);
    console.log(`F${String(got.n)} ${String(got.status)}`);
    return 0;
  }
  throw new UsageError(`unknown command: finding ${sub ?? ""}`.trim());
}

async function card(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "result") throw new UsageError(`unknown command: card ${sub ?? ""}`.trim());
  const args = parse(rest, ["chat"], []);
  const [id, result] = args.pos;
  if (!id || !result) throw new UsageError("card result needs a card and pass|fail|unclear");
  const got = await call("POST", `/api/chats/${enc(chatOf(args))}/cards/${enc(id)}/result`, { result, note: words(args, 2, "the note", false) });
  console.log(`${String(got.id)} ${String(got.result)}`);
  return 0;
}

async function task(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  const send = async (args: Args, body: Record<string, unknown>): Promise<Record<string, unknown>> =>
    call("POST", `/api/chats/${enc(chatOf(args))}/tasks`, { agent: agentOf(), ...body });
  const idOf = (args: Args, what: string): string => {
    const id = args.pos[0];
    if (!id) throw new UsageError(`task ${sub} needs ${what}`);
    return id;
  };
  if (sub === "add") {
    const args = parse(rest, ["phase", "text", "files", "verify", "chat"], ["parallel"]);
    if (args.pos.length) throw new UsageError(`unexpected ${args.pos[0]}`);
    const phase = Number(str(args, "phase"));
    if (!Number.isInteger(phase) || phase < 1) throw new UsageError("task add needs --phase <n>");
    const text = str(args, "text");
    const files = str(args, "files");
    if (!text) throw new UsageError('task add needs --text "<t>"');
    if (!files) throw new UsageError("task add needs --files <a,b>");
    const verify = str(args, "verify");
    const got = await send(args, { command: "add", phase, text, files: files.split(","), ...(verify ? { verify } : {}), parallel: args.flags.has("parallel") });
    console.log(`${String(got.id)} added`);
    return 0;
  }
  if (sub === "edit") {
    const args = parse(rest, ["text", "files", "verify", "chat"], []);
    const text = str(args, "text");
    const files = str(args, "files");
    const verify = str(args, "verify");
    if (text === undefined && files === undefined && verify === undefined) throw new UsageError("task edit needs --text, --files or --verify");
    const id = idOf(args, "a task id");
    await send(args, { command: "edit", id, ...(text !== undefined ? { text } : {}), ...(files !== undefined ? { files: files.split(",") } : {}), ...(verify !== undefined ? { verify } : {}) });
    console.log(`${id} edited`);
    return 0;
  }
  if (sub === "split") {
    const args = parse(rest, ["into", "chat"], []);
    const first = str(args, "into");
    const id = idOf(args, "a task id");
    // `--into "<a>" "<b>"`: the first part is the flag's value, the others follow it as words.
    const into = [...(first ? [first] : []), ...args.pos.slice(1)];
    if (into.length < 2) throw new UsageError('task split needs --into "<a>" "<b>"');
    const got = await send(args, { command: "split", id, into });
    console.log(`${id} split, first part ${String(got.id)}`);
    return 0;
  }
  if (sub === "block" || sub === "drop") {
    const args = parse(rest, ["reason", "chat"], []);
    const reason = str(args, "reason");
    if (!reason) throw new UsageError(`task ${sub} needs --reason "<why>"`);
    const id = idOf(args, "a task id");
    await send(args, { command: sub, id, reason });
    console.log(`${id} ${sub === "block" ? "blocked" : "dropped"}`);
    return 0;
  }
  if (sub === "retry") {
    const args = parse(rest, ["chat"], []);
    const id = idOf(args, "a task id");
    await send(args, { command: "retry", id });
    console.log(`${id} queued`);
    return 0;
  }
  throw new UsageError(`unknown command: task ${sub ?? ""}`.trim());
}

/** The longest a `starship check` waits for the engine: the run queue's own timeout is 15 minutes by default. */
const CHECK_WAIT_MS = 4 * 60 * 60 * 1000;

async function check(argv: string[]): Promise<number> {
  const args = parse(argv, ["chat"], []);
  const id = args.pos[0];
  if (!id || args.pos.length !== 1) throw new UsageError("check needs one task id");
  const got = await call("POST", `/api/chats/${enc(chatOf(args))}/check`, { task: id }, CHECK_WAIT_MS);
  const outcome = String(got.outcome);
  console.log(`${id} ${outcome}${typeof got.exit === "number" ? ` (exit ${got.exit})` : ""}`);
  if (typeof got.tail === "string" && got.tail !== "") console.log(got.tail);
  return outcome === "pass" ? 0 : 1;
}

async function agent(argv: string[]): Promise<number> {
  const [sub, ...rest] = argv;
  if (sub !== "pause" && sub !== "resume" && sub !== "restart") throw new UsageError(`unknown command: agent ${sub ?? ""}`.trim());
  const args = parse(rest, [], []);
  const [chatId, agentId] = args.pos;
  if (!chatId || !agentId || args.pos.length !== 2) throw new UsageError(`agent ${sub} needs a chat and an agent`);
  await call("POST", `/api/chats/${enc(chatId)}/agents/${enc(agentId)}/${sub}`);
  console.log(`${agentId} ${sub === "pause" ? "paused" : sub === "resume" ? "resumed" : "restarted"}`);
  return 0;
}

async function term(argv: string[]): Promise<number> {
  const args = parse(argv, [], []);
  const [chatId, agentId] = args.pos;
  if (!chatId || !agentId || args.pos.length !== 2) throw new UsageError("term needs a chat and an agent");
  const got = await call("POST", `/api/chats/${enc(chatId)}/agents/${enc(agentId)}/terminal`);
  console.log(`opened ${String(got.session)}`);
  return 0;
}

export async function main(argv: string[]): Promise<number> {
  const [cmd, ...rest] = argv;
  try {
    switch (cmd) {
      case "daemon":
        return await daemon(rest);
      case "status":
        return await status(rest);
      case "repo":
        return await repo(rest);
      case "chat":
        return await chat(rest);
      case "plan":
        return await plan(rest);
      case "map":
        return await map(rest);
      case "note":
        return await note(rest);
      case "ask":
        return await ask(rest);
      case "answer":
        return await answer(rest);
      case "finding":
        return await finding(rest);
      case "card":
        return await card(rest);
      case "task":
        return await task(rest);
      case "check":
        return await check(rest);
      case "agent":
        return await agent(rest);
      case "term":
        return await term(rest);
      case "hook": {
        // A tool runs this. It never fails loudly: the answer is the guard's, or nothing.
        const out = await hookMain(["hook", ...rest]);
        if (out) process.stdout.write(`${out}\n`);
        return 0;
      }
      default:
        throw new UsageError(cmd ? `unknown command: ${cmd}` : "no command");
    }
  } catch (e) {
    if (e instanceof UsageError) {
      console.error(`${e.message}\n${USAGE}`);
      return 2;
    }
    if (e instanceof EngineError) {
      console.error(e.message);
      return 1;
    }
    console.error(((e as Error).message || String(e)).split("\n")[0]);
    return 1;
  }
}

if (import.meta.main) {
  process.exit(await main(process.argv.slice(2)));
}

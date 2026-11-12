/**
 * T034: the notes API and the note commands, through the real HTTP server and the real CLI.
 * A real engine runs with the fake agent. No build starts, so no agent session is made; if one is, its name
 * starts with `sst-` plus a random part and the teardown kills it. STARSHIP_HOME is a temp folder.
 * No real claude or codex starts.
 */
import { afterEach, describe, expect, test } from "bun:test";
import { existsSync, readFileSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { kill, list } from "../src/agents/tmux.ts";
import { routes } from "../src/api.ts";
import { createEngine, type Engine } from "../src/engine.ts";
import { markRead, parseNotes } from "../src/folder/notes.ts";
import { addRepo } from "../src/repos.ts";
import { readRunState, updateRunState } from "../src/run/state.ts";
import { type EngineServer, startServer } from "../src/server.ts";
import type { ChatState, Note } from "../src/types.ts";
import { drop, tempDir, tempHome } from "./helpers.ts";

const FAKE = join(import.meta.dir, "fake-agent.ts");
const CLI = join(import.meta.dir, "..", "src", "cli.ts");
const rand = () => Math.random().toString(36).slice(2, 10);

interface Rig {
  engine: Engine;
  server: EngineServer;
  prefix: string;
  home: ReturnType<typeof tempHome>;
  get: <T>(path: string) => Promise<T>;
  post: (path: string, body?: unknown) => Promise<Response>;
  cli: (...args: string[]) => Promise<{ code: number; out: string; err: string }>;
}

const rigs: Rig[] = [];
const dirs: string[] = [];

afterEach(() => {
  for (const r of rigs.splice(0)) {
    r.engine.stop();
    r.server.stop();
    for (const n of list(r.prefix)) kill(n);
    r.home.restore();
  }
  for (const d of dirs.splice(0)) drop(d);
});

function git(cwd: string, ...args: string[]): void {
  const r = Bun.spawnSync(["git", "-C", cwd, ...args], { stdout: "pipe", stderr: "pipe" });
  if (r.exitCode !== 0) throw new Error(`git ${args.join(" ")}: ${r.stderr.toString()}`);
}

function gitRepo(): string {
  const dir = tempDir("starship-repo-");
  dirs.push(dir);
  git(dir, "init", "-q", "-b", "main");
  git(dir, "config", "user.name", "Test");
  git(dir, "config", "user.email", "test@example.com");
  git(dir, "config", "commit.gpgsign", "false");
  writeFileSync(join(dir, "README.md"), "# Repo\n");
  git(dir, "add", ".");
  git(dir, "commit", "-q", "-m", "one");
  return dir;
}

async function boot(): Promise<Rig> {
  const home = tempHome();
  const fakeDir = tempDir("starship-fake-sessions-");
  dirs.push(fakeDir);
  const prefix = `sst-${rand()}-`;
  let server: EngineServer | undefined;
  const publish = (e: Parameters<EngineServer["publish"]>[0]) => server?.publish(e);
  const engine = createEngine({
    publish,
    bins: { claude: [process.execPath, FAKE, "--as", "claude"], codex: [process.execPath, FAKE, "--as", "codex"] },
    prefix,
    env: { FAKE_SESSIONS_DIR: fakeDir },
    codexSessionsDir: join(fakeDir, "sessions"),
    pollMs: 100,
    stallMs: 60_000,
    readyMs: 20_000,
    self: [process.execPath, CLI],
  });
  const started = startServer({ routes: routes({ publish, engine }), portFrom: 20000 + Math.floor(Math.random() * 20000) });
  server = started;
  await engine.start();
  const api = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${started.info.token}`);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(`${started.url}${path}`, { ...init, headers });
  };
  const rig: Rig = {
    engine,
    server: started,
    prefix,
    home,
    get: async <T>(path: string) => {
      const res = await api(path);
      if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
      return (await res.json()) as T;
    },
    post: (path, body) => api(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) }),
    cli: async (...args) => {
      const p = Bun.spawn([process.execPath, CLI, ...args], {
        env: { ...process.env, STARSHIP_HOME: home.dir },
        stdin: "ignore",
        stdout: "pipe",
        stderr: "pipe",
      });
      const [out, err] = await Promise.all([new Response(p.stdout).text(), new Response(p.stderr).text()]);
      return { code: await p.exited, out, err };
    },
  };
  rigs.push(rig);
  return rig;
}

/** A chat on a new repo, in the stage it starts in. Its feature folder has no notes yet. */
async function chat(r: Rig): Promise<{ id: string; dir: string; file: string }> {
  addRepo(gitRepo(), { name: "demo" });
  const res = await r.post("/api/chats", { title: "Notes api", repo: "demo" });
  expect(res.status).toBe(200);
  const s = (await res.json()) as ChatState;
  const dir = s.chat.featureDir ?? "";
  return { id: s.chat.id, dir, file: join(dir, "run", "handoffs.md") };
}

const WORDS = "match recipe numbers without the dash";
const send = async (r: Rig, id: string, to: string, note = `A note to ${to}.`, said = WORDS): Promise<Note> => {
  const res = await r.post(`/api/chats/${id}/notes`, { to, said, note });
  expect(res.status).toBe(200);
  return (await res.json()) as Note;
};
const notesOf = (file: string): Note[] => parseNotes(readFileSync(file, "utf8")).notes;
const statusOf = (file: string, n: number) => notesOf(file).find((x) => x.n === n)?.status;
const undo = (r: Rig, id: string, n: number) => r.post(`/api/chats/${id}/notes/${n}/undo`);
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

describe("a note for each target", () => {
  test("plan and repo are read at once, fixes is queued, orchestrator is queued; each is in handoffs.md with the owner's words", async () => {
    const r = await boot();
    const c = await chat(r);
    const orchestrator = await send(r, c.id, "orchestrator");
    const plan = await send(r, c.id, "plan");
    const repo = await send(r, c.id, "repo");
    const fixes = await send(r, c.id, "fixes");

    expect(orchestrator).toMatchObject({ n: 1, to: "orchestrator", status: "queued", said: WORDS });
    expect(plan).toMatchObject({ n: 2, to: "plan", status: "read", said: WORDS });
    expect(plan.readAt).toMatch(/^\d{2}:\d{2}$/);
    expect(repo).toMatchObject({ n: 3, to: "repo", status: "read", said: WORDS });
    expect(fixes).toMatchObject({ n: 4, to: "fixes", status: "queued", said: WORDS });

    const text = readFileSync(c.file, "utf8");
    for (const to of ["orchestrator", "plan", "repo", "fixes"]) {
      expect(text).toContain(`→ ${to}\nYou: ${WORDS}\nNote: A note to ${to}.\n`);
    }
    expect(notesOf(c.file).map((n) => [n.n, n.to, n.status])).toEqual([
      [1, "orchestrator", "queued"],
      [2, "plan", "read"],
      [3, "repo", "read"],
      [4, "fixes", "queued"],
    ]);
    // The state the window reads says the same.
    const s = await r.get<ChatState>(`/api/chats/${c.id}`);
    expect(s.notes.map((n) => [n.n, n.status])).toEqual([[1, "queued"], [2, "read"], [3, "read"], [4, "queued"]]);
  });

  test("a note to the orchestrator is held while the chat is halted; the others are recorded as usual", async () => {
    const r = await boot();
    const c = await chat(r);
    expect((await r.post(`/api/chats/${c.id}/halt`)).status).toBe(200);
    expect((await send(r, c.id, "orchestrator")).status).toBe("held");
    expect((await send(r, c.id, "plan")).status).toBe("read");
    expect((await send(r, c.id, "repo")).status).toBe("read");
    expect((await send(r, c.id, "fixes")).status).toBe("queued");
    // Undo of a held note is allowed and the note is never delivered.
    expect((await undo(r, c.id, 1)).status).toBe(200);
    expect(statusOf(c.file, 1)).toBe("undone");
  });
});

describe("edge rows", () => {
  test("B2: with no build started, a plan note is recorded at once and an orchestrator note stays queued", async () => {
    const r = await boot();
    const c = await chat(r);
    expect((await r.get<ChatState>(`/api/chats/${c.id}`)).build.status).toBe("notStarted");
    const plan = await send(r, c.id, "plan");
    const orchestrator = await send(r, c.id, "orchestrator");
    expect(plan.status).toBe("read");
    expect(orchestrator.status).toBe("queued");
    // Give a delivery time to start if one would. None does: no delivery was counted, no agent session exists.
    await Bun.sleep(300);
    await r.engine.notes.idle();
    expect(statusOf(c.file, orchestrator.n)).toBe("queued");
    expect(readRunState(c.dir).notes[String(orchestrator.n)]).toBeUndefined();
    expect(list(r.prefix)).toEqual([]);
  });

  test("B4: Undo of a queued note makes it undone; an undone fixes note leaves the fix list", async () => {
    const r = await boot();
    const c = await chat(r);
    const orchestrator = await send(r, c.id, "orchestrator");
    const fixes = await send(r, c.id, "fixes", "Rename the label on the button.");
    const fixList = join(c.dir, "run", "review", "fixes.md");
    expect(readFileSync(fixList, "utf8")).toContain("Rename the label on the button.");

    const a = await undo(r, c.id, orchestrator.n);
    expect(a.status).toBe(200);
    expect(await a.json()).toEqual({ n: orchestrator.n, status: "undone" });
    expect(statusOf(c.file, orchestrator.n)).toBe("undone");
    // An undone note is not queued any more, so no delivery takes it.
    expect(r.engine.notes.needsYou(c.id)).toEqual([]);

    const b = await undo(r, c.id, fixes.n);
    expect(b.status).toBe(200);
    expect(statusOf(c.file, fixes.n)).toBe("undone");
    expect(readFileSync(fixList, "utf8")).not.toContain("Rename the label on the button.");
    expect((await r.get<ChatState>(`/api/chats/${c.id}`)).notes.map((n) => [n.n, n.status])).toEqual([[1, "undone"], [2, "undone"]]);
  });

  test("B5: Undo of a read note answers 409 with the text Already read", async () => {
    const r = await boot();
    const c = await chat(r);
    // A plan note and a repo note are read when they are written.
    for (const to of ["plan", "repo"]) {
      const n = await send(r, c.id, to);
      const res = await undo(r, c.id, n.n);
      expect(res.status).toBe(409);
      expect(await errorOf(res)).toBe("Already read");
      expect(statusOf(c.file, n.n)).toBe("read");
    }
    // An orchestrator note that the orchestrator confirmed is read too.
    const o = await send(r, c.id, "orchestrator");
    writeFileSync(c.file, markRead(readFileSync(c.file, "utf8"), o.n, "10:15"));
    const res = await undo(r, c.id, o.n);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("Already read");
    expect(statusOf(c.file, o.n)).toBe("read");
    // A second Undo of an undone note is refused with its own text.
    const f = await send(r, c.id, "fixes");
    expect((await undo(r, c.id, f.n)).status).toBe(200);
    const again = await undo(r, c.id, f.n);
    expect(again.status).toBe(409);
    expect(await errorOf(again)).toBe("Already undone");
  });

  test("B13: Undo while the note is being read answers 409 Being read, and the note stays queued", async () => {
    const r = await boot();
    const c = await chat(r);
    const o = await send(r, c.id, "orchestrator");
    // The state the engine writes at the moment it hands the note to the orchestrator.
    updateRunState(c.dir, (s) => {
      s.notes[String(o.n)] = { deliveries: 1, reading: true };
    });
    const res = await undo(r, c.id, o.n);
    expect(res.status).toBe(409);
    expect(await errorOf(res)).toBe("Being read");
    expect(statusOf(c.file, o.n)).toBe("queued");
    // Undo before that moment wins: the same note, not being read, is undone.
    updateRunState(c.dir, (s) => {
      s.notes[String(o.n)] = { deliveries: 1, reading: false };
    });
    expect((await undo(r, c.id, o.n)).status).toBe(200);
    expect(statusOf(c.file, o.n)).toBe("undone");
  });
});

describe("the CLI", () => {
  test("starship note --to orchestrator --said records the same note as the route", async () => {
    const r = await boot();
    const c = await chat(r);
    const cli = await r.cli("note", "--to", "orchestrator", "--said", WORDS, "Match recipe numbers with or without the dash.", "--chat", c.id);
    expect(cli.err).toBe("");
    expect(cli.code).toBe(0);
    expect(cli.out.trim()).toBe("note 1 queued");
    const viaRoute = await send(r, c.id, "orchestrator", "Match recipe numbers with or without the dash.");

    const [a, b] = notesOf(c.file);
    expect(a).toBeDefined();
    expect(b).toBeDefined();
    expect(viaRoute.n).toBe(2);
    // Same target, owner's words, note text, stage and status; only the number (and the minute) may differ.
    const same = (n: Note | undefined) => n && { to: n.to, said: n.said, note: n.note, stage: n.stage, status: n.status };
    expect(same(a)).toEqual({ to: "orchestrator", said: WORDS, note: "Match recipe numbers with or without the dash.", stage: viaRoute.stage, status: "queued" });
    expect(same(a)).toEqual(same(b));
    expect(readFileSync(c.file, "utf8")).toContain(`You: ${WORDS}\nNote: Match recipe numbers with or without the dash.\nStatus: queued\n`);
  });

  test("starship note needs --to and --said", async () => {
    const r = await boot();
    const c = await chat(r);
    expect((await r.cli("note", "--said", "x", "A note.", "--chat", c.id)).code).not.toBe(0);
    expect((await r.cli("note", "--to", "plan", "A note.", "--chat", c.id)).code).not.toBe(0);
    expect(existsSync(c.file)).toBe(false);
  });
});

describe("note ack", () => {
  test("ack of a note that is not being read changes nothing and does not fail, through the route and the CLI", async () => {
    const r = await boot();
    const c = await chat(r);
    const queued = await send(r, c.id, "orchestrator");
    const plan = await send(r, c.id, "plan");
    const before = readFileSync(c.file, "utf8");
    const runBefore = JSON.stringify(readRunState(c.dir).notes);

    const res = await r.post(`/api/chats/${c.id}/notes/ack`, { numbers: [queued.n, plan.n, 99] });
    expect(res.status).toBe(200);
    expect(await res.json()).toEqual({ ok: true, numbers: [queued.n, plan.n, 99] });

    const cli = await r.cli("note", "ack", String(queued.n), "--chat", c.id);
    expect(cli.err).toBe("");
    expect(cli.code).toBe(0);
    expect(cli.out.trim()).toBe(`read note ${queued.n}`);

    await Bun.sleep(200);
    await r.engine.notes.idle();
    expect(readFileSync(c.file, "utf8")).toBe(before);
    expect(statusOf(c.file, queued.n)).toBe("queued");
    expect(JSON.stringify(readRunState(c.dir).notes)).toBe(runBefore);
    // Bad input is still refused.
    expect((await r.post(`/api/chats/${c.id}/notes/ack`, { numbers: [] })).status).toBe(400);
  });
});

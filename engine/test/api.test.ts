import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, realpathSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routes } from "../src/api.ts";
import { ChatError, appendMessage, chatState, createChat, getChat, listChats, readMessages, saveChat, slugify } from "../src/chats.ts";
import { paths } from "../src/config.ts";
import { appendNote } from "../src/folder/notes.ts";
import { readRunState, updateRunState } from "../src/run/state.ts";
import { RepoError, addRepo, getRepo, listRepos } from "../src/repos.ts";
import { type EngineServer, startServer } from "../src/server.ts";
import type { ChatState, ChatSummary, EngineEvent, FileBody, FileInfo, RepoInfo } from "../src/types.ts";
import { drop, fixture, tempDir, tempHome } from "./helpers.ts";

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

let home: ReturnType<typeof tempHome>;
let server: EngineServer;
let opened: string[][];
let published: EngineEvent[];
let dirs: string[];

beforeEach(() => {
  home = tempHome();
  opened = [];
  published = [];
  dirs = [];
  server = startServer({
    routes: routes({
      publish: (e) => {
        published.push(e);
        server.publish(e);
      },
      run: (cmd) => {
        opened.push(cmd);
      },
    }),
    portFrom: randomPort(),
  });
});
afterEach(() => {
  server.stop();
  for (const d of dirs) drop(d);
  home.restore();
});

function api(path: string, init: RequestInit = {}): Promise<Response> {
  const headers = new Headers(init.headers);
  headers.set("authorization", `Bearer ${server.info.token}`);
  if (init.body) headers.set("content-type", "application/json");
  return fetch(`${server.url}${path}`, { ...init, headers });
}
async function get<T>(path: string): Promise<T> {
  const res = await api(path);
  if (res.status !== 200) throw new Error(`${path}: ${res.status} ${await res.text()}`);
  return (await res.json()) as T;
}
const post = (path: string, body?: unknown) => api(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

function copyOfSample(): string {
  const base = tempDir();
  dirs.push(base);
  const dir = join(base, "docs", "features", "recipe-search");
  cpSync(fixture("recipe-search"), dir, { recursive: true });
  return dir;
}

function gitRepo(): string {
  const dir = tempDir("starship-repo-");
  dirs.push(dir);
  const g = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# Repo\n");
  g("add", ".");
  g("commit", "-q", "-m", "one");
  return dir;
}

describe("chats library", () => {
  test("the id is a slug of the title; a clash gets -2, -3", () => {
    expect(slugify("Recipe search!")).toBe("recipe-search");
    expect(slugify("  Ünïcode — test  ")).toBe("unicode-test");
    expect(slugify("!!!")).toBe("chat");
    expect(createChat({ title: "Recipe search" }).id).toBe("recipe-search");
    expect(createChat({ title: "Recipe  search" }).id).toBe("recipe-search-2");
    expect(createChat({ title: "recipe search" }).id).toBe("recipe-search-3");
    expect(listChats().map((c) => c.id).sort()).toEqual(["recipe-search", "recipe-search-2", "recipe-search-3"]);
  });

  test("a chat with a folder adopts it in plan; with a repo and no folder it records the repo; with neither it has no stage", () => {
    const a = createChat({ title: "A", folder: fixture("recipe-search") });
    expect(a).toMatchObject({ stage: "plan", featureDir: realpathSync(fixture("recipe-search")), slug: "recipe-search", repo: null, worktree: null, branch: null, halted: null, agents: {} });
    const repo = addRepo(gitRepo(), { name: "demo" });
    const b = createChat({ title: "B", repo: repo.name });
    // A chat on a repo gets a worktree and its feature folder; the repo has no map, so it opens in Map.
    expect(b).toMatchObject({ repo: "demo", stage: "map", slug: "b", branch: "starship/b", worktree: join(home.dir, "worktrees", "demo", "b"), featureDir: join(home.dir, "worktrees", "demo", "b", "docs", "features", "b") });
    expect(existsSync(join(b.featureDir ?? "", "run"))).toBe(true);
    const c = createChat({ title: "C" });
    expect(c).toMatchObject({ repo: null, stage: null, featureDir: null });
    expect(createChat({ title: "D", folder: fixture("recipe-search"), stage: "build" }).stage).toBe("build");
    for (const f of ["chat.json", "messages.jsonl", "events.jsonl"]) expect(existsSync(join(paths.chat(c.id), f))).toBe(true);
    expect(getChat("a")).toEqual(a);
  });

  test("bad input is refused and creates nothing", () => {
    expect(() => createChat({ title: "  " })).toThrow(ChatError);
    expect(() => createChat({ title: "X", folder: "relative/path" })).toThrow(ChatError);
    expect(() => createChat({ title: "X", folder: "/no/such/folder" })).toThrow(ChatError);
    expect(() => createChat({ title: "X", folder: fixture("recipe-search", "PLAN.md") })).toThrow(ChatError);
    expect(() => createChat({ title: "X", repo: "nope" })).toThrow(RepoError);
    expect(() => createChat({ title: "X", stage: "later" as never })).toThrow(ChatError);
    expect(listChats()).toEqual([]);
  });

  test("getChat throws a 404 ChatError for an unknown or malformed id, and a 500 one for a broken chat.json", () => {
    for (const id of ["nope", "../etc", "A-chat", "-x", "", "a/b", "a.b"]) {
      let err: unknown;
      try {
        getChat(id);
      } catch (e) {
        err = e;
      }
      expect(err).toBeInstanceOf(ChatError);
      expect((err as ChatError).status).toBe(404);
    }
    const c = createChat({ title: "Broken" });
    writeFileSync(join(paths.chat(c.id), "chat.json"), "{nope");
    expect(() => getChat(c.id)).toThrow(ChatError);
    expect(listChats()).toEqual([]);
  });

  test("saveChat keeps agents; messages skip a line that is not JSON", () => {
    const c = createChat({ title: "Talk" });
    c.agents.admin = { id: "admin", name: "Admin", role: "admin", tool: "claude", model: "opus", tmux: "sst-admin", status: "idle", task: null, history: [] };
    saveChat(c);
    expect(getChat(c.id).agents.admin?.model).toBe("opus");
    appendMessage(c.id, { id: "m1", who: "you", at: "15:00", stage: null, text: "hello" });
    appendFileSync(join(paths.chat(c.id), "messages.jsonl"), "not json\n{\"id\":3}\n");
    appendMessage(c.id, { id: "m2", who: "admin", at: "15:01", stage: null, text: "hi" });
    expect(readMessages(c.id).map((m) => m.id)).toEqual(["m1", "m2"]);
    expect(() => appendMessage("nope", { id: "m", who: "you", at: "15:00", stage: null, text: "x" })).toThrow(ChatError);
  });

  test("chatState: a bad state.json and a bad links.json are ignored, never fatal", () => {
    const dir = copyOfSample();
    writeFileSync(join(dir, "run", "state.json"), "{nope");
    writeFileSync(join(dir, "wireframes", "links.json"), "[nope");
    const c = createChat({ title: "S", folder: dir });
    const s = chatState(c.id);
    const t22 = s.tasks?.phases.flatMap((p) => p.tasks).find((t) => t.id === "T022");
    expect(t22).toMatchObject({ state: "queued", agent: null, attempts: 0 });
    expect(s.wireframes).toEqual([{ name: "search", path: "wireframes/search.html", url: null }]);
  });

  test("chatState: an unknown state in state.json is ignored; a done task is always verified", () => {
    const dir = copyOfSample();
    writeFileSync(join(dir, "run", "state.json"), JSON.stringify({ tasks: { T022: { state: "dancing", agent: "worker-a", attempts: 2 }, T001: { state: "working" } } }));
    const c = createChat({ title: "S", folder: dir });
    const tasks = chatState(c.id).tasks?.phases.flatMap((p) => p.tasks) ?? [];
    expect(tasks.find((t) => t.id === "T022")).toMatchObject({ state: "queued", agent: "worker-a", attempts: 2 });
    expect(tasks.find((t) => t.id === "T001")).toMatchObject({ state: "verified", done: true });
  });

  test("chatState: events are display lines, newest first, at most 50", () => {
    const c = createChat({ title: "Ev" });
    const lines = [];
    for (let i = 0; i < 60; i++) lines.push(JSON.stringify({ type: "log", at: "15:00", text: `e${i}` }));
    lines.push("not json", JSON.stringify({ type: "hook", at: "15:00", text: "hidden" }));
    writeFileSync(join(paths.chat(c.id), "events.jsonl"), lines.join("\n") + "\n");
    const ev = chatState(c.id).events;
    expect(ev.length).toBe(50);
    expect(ev[0]?.text).toBe("e59");
    expect(ev[49]?.text).toBe("e10");
  });

  test("chatState: queue and handEdits come from extra", () => {
    const c = createChat({ title: "X" });
    const s = chatState(c.id, { handEdits: ["PLAN.md"], queue: [{ id: "q1", chat: c.id, task: "T022", command: "x", state: "waiting" }] });
    expect(s.handEdits).toEqual(["PLAN.md"]);
    expect(s.queue.length).toBe(1);
    expect(chatState(c.id).queue).toEqual([]);
  });
});

describe("api", () => {
  let chatId: string;
  beforeEach(() => {
    const c = createChat({ title: "Recipe search", folder: fixture("recipe-search") });
    c.agents["worker-a"] = { id: "worker-a", name: "Worker A", role: "worker", tool: "codex", model: "", tmux: "sst-recipes-worker-a", status: "working", task: "T022", history: [] };
    c.agents["worker-b"] = { id: "worker-b", name: "Worker B", role: "worker", tool: "codex", model: "", tmux: "sst-recipes-worker-b", status: "idle", task: null, history: [] };
    saveChat(c);
    chatId = c.id;
  });

  test("the chat list", async () => {
    createChat({ title: "Empty chat" });
    const list = await get<ChatSummary[]>("/api/chats");
    expect(list.map((c) => c.id).sort()).toEqual(["empty-chat", "recipe-search"]);
    const recipe = list.find((c) => c.id === chatId);
    expect(recipe).toMatchObject({ title: "Recipe search", repo: null, stage: "plan", halted: null });
    expect(recipe?.needsYou).toBeGreaterThanOrEqual(1);
  });

  test("the chat state of the sample folder", async () => {
    const s = await get<ChatState>(`/api/chats/${chatId}`);
    expect(s.folderMissing).toBe(false);
    expect(s.tasksError).toBeNull();
    expect(s.tasks?.verified).toBe(9);
    expect(s.tasks?.total).toBe(20);
    const tasks = s.tasks?.phases.flatMap((p) => p.tasks) ?? [];
    expect(tasks.find((t) => t.id === "T022")).toMatchObject({ state: "working", agent: "worker-a", attempts: 1, done: false });
    expect(tasks.find((t) => t.id === "T023")).toMatchObject({ state: "checking", agent: "worker-b" });
    expect(tasks.find((t) => t.id === "T031")).toMatchObject({ state: "blocked" });
    expect(tasks.find((t) => t.id === "T024")).toMatchObject({ state: "queued", agent: null, attempts: 0 });
    expect(tasks.find((t) => t.id === "T001")).toMatchObject({ state: "verified" });
    expect(s.notes.length).toBe(3);
    expect(s.unreadableNotes).toEqual([]);
    expect(s.questions.filter((q) => q.status === "open").length).toBe(1);
    // One open question plus T031 in needsYou.
    expect(s.chat.needsYou).toBe(2);
    expect(s.needs.map((n) => [n.kind, n.task])).toEqual([
      ["question", "T023"],
      ["blocked", "T031"],
    ]);
    // The sample is a folder with no repo: no build, no plan page. It has review files.
    expect(s.build).toEqual({ status: "notStarted", reason: null, outside: [], dropped: [], lastFixSent: 0 });
    expect(s.plan).toBeNull();
    expect(s.review).toMatchObject({ none: [] });
    expect(s.review?.findings.length).toBe(2);
    expect(s.review?.cards.length).toBe(2);
    expect(s.review?.fixes.length).toBe(2);
    expect(s.wireframes).toEqual([{ name: "search", path: "wireframes/search.html", url: "https://example.com/wireframes/search" }]);
    const a = s.agents.find((x) => x.id === "worker-a");
    expect(a?.prompts.length).toBe(1);
    const p = a?.prompts[0];
    expect(p?.v).toBe(1);
    expect(p?.file).toBe("run/prompts/worker-a-T022-v1.md");
    expect(p?.at).toMatch(/^\d{2}:\d{2}$/);
    expect(p?.text).toBe(readFileSync(fixture("recipe-search", "run", "prompts", "worker-a-T022-v1.md"), "utf8"));
    expect(p?.lines[0]).toEqual({ text: "Implement T022 only: recipe numbers match with or without the dash." });
    expect(p?.lines.filter((l) => l.note === 3).map((l) => l.text)).toEqual(["R111 and R-111 return the same recipes (note 3)."]);
    expect(s.agents.find((x) => x.id === "worker-b")?.prompts).toEqual([]);
    expect(s.files.slice(0, 4).map((f) => f.path)).toEqual(["SPEC.md", "PLAN.md", "TASKS.md", "ACCEPTANCE.md"]);
    expect(s.queue).toEqual([]);
    expect(s.handEdits).toEqual([]);
    expect(s.messages).toEqual([]);
  });

  test("prompts are sorted by version, both name forms count, and another agent's prompt does not", async () => {
    const dir = copyOfSample();
    const pdir = join(dir, "run", "prompts");
    writeFileSync(join(pdir, "worker-a-T022-v10.md"), "Ten.\n");
    writeFileSync(join(pdir, "worker-a-v2.md"), "Two.\n\n  \nSecond line (note 12).\n");
    writeFileSync(join(pdir, "worker-ab-v3.md"), "Other agent.\n");
    writeFileSync(join(pdir, "worker-a-notes.md"), "Not a prompt.\n");
    const c = createChat({ title: "P", folder: dir });
    c.agents["worker-a"] = { id: "worker-a", name: "Worker A", role: "worker", tool: "codex", model: "", tmux: "t", status: "idle", task: null, history: [] };
    saveChat(c);
    const s = await get<ChatState>(`/api/chats/${c.id}`);
    const prompts = s.agents[0]?.prompts ?? [];
    expect(prompts.map((p) => p.v)).toEqual([1, 2, 10]);
    expect(prompts[1]?.lines).toEqual([{ text: "Two." }, { text: "Second line (note 12).", note: 12 }]);
  });

  test("the file list, and reading PLAN.md", async () => {
    const files = await get<FileInfo[]>(`/api/chats/${chatId}/files`);
    expect(files.some((f) => f.path === "run/state.json" && f.kind === "run")).toBe(true);
    const body = await get<FileBody>(`/api/chats/${chatId}/file?path=PLAN.md`);
    expect(body.open).toBe(false);
    expect(body.text).toContain("# PLAN — Recipe search");
    expect(body.info.path).toBe("PLAN.md");
  });

  test("a path that leaves the folder is 400; a missing path is 400", async () => {
    for (const p of ["../../../package.json", "/etc/passwd", "..%2F..%2Fpackage.json", "nope.md"]) {
      const res = await api(`/api/chats/${chatId}/file?path=${p}`);
      expect(res.status).toBe(400);
      expect((await res.json()).error).toBeString();
    }
    expect((await api(`/api/chats/${chatId}/file`)).status).toBe(400);
  });

  test("an .html file comes back with text: null and open: true", async () => {
    const body = await get<FileBody>(`/api/chats/${chatId}/file?path=wireframes/search.html`);
    expect(body).toMatchObject({ text: null, open: true });
    expect(opened).toEqual([]);
  });

  test("open: an .html file of the folder and a wireframe link open in the browser; other files and leaving paths are refused", async () => {
    expect((await post(`/api/chats/${chatId}/open?path=wireframes/search.html`)).status).toBe(200);
    expect(opened).toEqual([["open", join(realpathSync(fixture("recipe-search")), "wireframes", "search.html")]]);
    expect((await post(`/api/chats/${chatId}/open?wireframe=search`)).status).toBe(200);
    expect(opened[1]).toEqual(["open", "https://example.com/wireframes/search"]);
    expect((await post(`/api/chats/${chatId}/open?path=PLAN.md`)).status).toBe(400);
    expect((await post(`/api/chats/${chatId}/open?path=../../x.html`)).status).toBe(400);
    expect((await post(`/api/chats/${chatId}/open`)).status).toBe(400);
    expect((await post(`/api/chats/${chatId}/open?wireframe=nope`)).status).toBe(404);
    expect(opened.length).toBe(2);
  });

  test("open: a wireframe with no link opens its file", async () => {
    const dir = copyOfSample();
    rmSync(join(dir, "wireframes", "links.json"));
    const c = createChat({ title: "W", folder: dir });
    expect((await post(`/api/chats/${c.id}/open?wireframe=search`)).status).toBe(200);
    expect(opened).toEqual([["open", join(dir, "wireframes", "search.html")]]);
  });

  test("an unknown chat is 404 on every chat route", async () => {
    for (const path of ["/api/chats/nope", "/api/chats/nope/files", "/api/chats/nope/file?path=PLAN.md", "/api/chats/BAD..ID"]) {
      expect((await api(path)).status).toBe(404);
    }
    expect((await post("/api/chats/nope/open?path=a.html")).status).toBe(404);
  });

  test("C4: a missing folder gives folderMissing: true on the state and 409 on a file read", async () => {
    const dir = copyOfSample();
    const c = createChat({ title: "Gone", folder: dir });
    rmSync(dir, { recursive: true });
    const s = await get<ChatState>(`/api/chats/${c.id}`);
    expect(s.folderMissing).toBe(true);
    expect(s.tasks).toBeNull();
    expect(s.notes).toEqual([]);
    expect(s.files).toEqual([]);
    expect(s.wireframes).toEqual([]);
    expect((await api(`/api/chats/${c.id}/file?path=PLAN.md`)).status).toBe(409);
    expect((await api(`/api/chats/${c.id}/files`)).status).toBe(409);
    expect((await post(`/api/chats/${c.id}/open?path=wireframes/search.html`)).status).toBe(409);
    expect(existsSync(dir)).toBe(false);
  });

  test("C2: a broken TASKS.md gives tasksError with the file and the line", async () => {
    const dir = copyOfSample();
    const file = join(dir, "TASKS.md");
    const lines = readFileSync(file, "utf8").split("\n");
    const at = lines.findIndex((l) => l.startsWith("- [ ] T023"));
    lines[at] = "- [ ] T023 a line with no files and no verify";
    writeFileSync(file, lines.join("\n"));
    const c = createChat({ title: "Broken", folder: dir });
    const s = await get<ChatState>(`/api/chats/${c.id}`);
    expect(s.tasks).toBeNull();
    expect(s.tasksError).toMatchObject({ file: "TASKS.md", line: at + 1 });
    expect(s.tasksError?.reason).toContain("verify");
    expect(s.notes.length).toBe(3);
  });

  test("a chat with no folder has an empty file list and 404 on a file read", async () => {
    const c = createChat({ title: "Bare" });
    expect(await get<FileInfo[]>(`/api/chats/${c.id}/files`)).toEqual([]);
    expect((await api(`/api/chats/${c.id}/file?path=PLAN.md`)).status).toBe(404);
    const s = await get<ChatState>(`/api/chats/${c.id}`);
    expect(s).toMatchObject({ folderMissing: false, tasks: null, files: [], needs: [], plan: null, review: null, chat: { stage: null, needsYou: 0 } });
    expect(s.build.status).toBe("notStarted");
  });

  test("creating a chat by POST pushes a chats event on the WebSocket", async () => {
    const ws = new WebSocket(`ws://127.0.0.1:${server.info.port}/api/events?token=${server.info.token}`);
    await new Promise<void>((resolve, reject) => {
      ws.onopen = () => resolve();
      ws.onerror = () => reject(new Error("no socket"));
    });
    for (let i = 0; i < 50 && server.clients() < 1; i++) await Bun.sleep(10);
    const got = new Promise<EngineEvent>((resolve) => {
      ws.onmessage = (m) => resolve(JSON.parse(String(m.data)));
    });
    const res = await post("/api/chats", { title: "New one", folder: fixture("recipe-search") });
    expect(res.status).toBe(200);
    const s = (await res.json()) as ChatState;
    expect(s.chat).toMatchObject({ id: "new-one", stage: "plan" });
    expect(await got).toEqual({ type: "chats" });
    ws.close();
    expect((await get<ChatSummary[]>("/api/chats")).some((c) => c.id === "new-one")).toBe(true);
  });

  test("POST /api/chats refuses bad input with 400 and an unknown repo with 404", async () => {
    expect((await post("/api/chats", {})).status).toBe(400);
    expect((await post("/api/chats", { title: 3 })).status).toBe(400);
    expect((await post("/api/chats", { title: "x", folder: "relative" })).status).toBe(400);
    expect((await post("/api/chats", { title: "x", folder: "/no/such" })).status).toBe(400);
    expect((await post("/api/chats", [1])).status).toBe(400);
    expect((await post("/api/chats", null)).status).toBe(400);
    expect((await api("/api/chats", { method: "POST", body: "{bad" })).status).toBe(400);
    expect((await post("/api/chats", { title: "x", repo: "nope" })).status).toBe(404);
    expect(published).toEqual([]);
  });

  test("POST /api/refresh pushes events", async () => {
    expect((await post(`/api/refresh?chat=${chatId}`)).status).toBe(200);
    expect(published).toEqual([{ type: "chats" }, { type: "repos" }, { type: "chat", id: chatId }]);
  });
});

describe("repos", () => {
  test("addRepo on a temp git repo, then GET /api/repos lists it", async () => {
    const dir = gitRepo();
    const r = addRepo(dir);
    expect(r).toMatchObject({ path: realpathSync(dir), baseBranch: "main", featureDir: "docs/features", commitPlanFiles: true });
    expect(getRepo(r.name).path).toBe(r.path);
    const list = await get<RepoInfo[]>("/api/repos");
    expect(list).toEqual([{ name: r.name, path: r.path, baseBranch: "main", hasMap: false }]);
  });

  test("POST /api/repos adds a repo with a name and pushes a repos event", async () => {
    const dir = gitRepo();
    const res = await post("/api/repos", { path: dir, name: "demo", base: "main" });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ name: "demo", baseBranch: "main" });
    expect(published).toEqual([{ type: "repos" }]);
    expect(listRepos().map((r) => r.name)).toEqual(["demo"]);
  });

  test("a folder that is not a repo, and a path that does not exist, are refused", async () => {
    const plain = tempDir();
    dirs.push(plain);
    expect(() => addRepo(plain)).toThrow(/not a git repo/);
    expect(() => addRepo(join(plain, "missing"))).toThrow(/not a folder/);
    expect((await post("/api/repos", { path: plain })).status).toBe(400);
    expect((await post("/api/repos", {})).status).toBe(400);
    expect(listRepos()).toEqual([]);
  });

  test("a name clash with another path is refused; the same path again updates", async () => {
    const a = gitRepo();
    const b = gitRepo();
    addRepo(a, { name: "demo" });
    expect(() => addRepo(b, { name: "demo" })).toThrow(/taken by/);
    expect((await post("/api/repos", { path: b, name: "demo" })).status).toBe(400);
    expect(addRepo(a, { name: "demo" }).path).toBe(realpathSync(a));
    expect(() => addRepo(a, { name: "../evil" })).toThrow(/not a usable repo name/);
  });

  test("--base that does not exist is refused", () => {
    const dir = gitRepo();
    expect(() => addRepo(dir, { base: "nope" })).toThrow(/no branch "nope"/);
    expect(listRepos()).toEqual([]);
  });

  test("a detached HEAD with no --base is refused; with --base it works", () => {
    const dir = gitRepo();
    Bun.spawnSync(["git", "-C", dir, "checkout", "-q", "--detach"]);
    expect(() => addRepo(dir)).toThrow(/not on a branch/);
    expect(addRepo(dir, { base: "main" }).baseBranch).toBe("main");
  });

  test("a subfolder of a repo registers the repo root", () => {
    const dir = gitRepo();
    mkdirSync(join(dir, "sub"));
    expect(addRepo(join(dir, "sub")).path).toBe(realpathSync(dir));
  });

  test("an unknown repo is a 404 RepoError", () => {
    let err: unknown;
    try {
      getRepo("nope");
    } catch (e) {
      err = e;
    }
    expect(err).toBeInstanceOf(RepoError);
    expect((err as RepoError).notFound).toBe(true);
  });
});

describe("chat state with live agents", () => {
  test("the live agents replace the stored ones; their prompts come from run/prompts and their history stays", () => {
    const dir = copyOfSample();
    const chat = createChat({ title: "Live", folder: dir });
    mkdirSync(join(dir, "run", "prompts"), { recursive: true });
    writeFileSync(join(dir, "run", "prompts", "worker-q-T001-v1.md"), "Do the task.\n");
    saveChat({
      ...getChat(chat.id),
      agents: { "worker-q": { id: "worker-q", name: "worker-q", role: "worker", tool: "claude", model: "old", tmux: "old", status: "stopped", task: null, history: [{ at: "10:00", text: "old" }] } },
    });
    // With no live agents the stored ones show, as before.
    expect(chatState(chat.id).agents).toMatchObject([{ id: "worker-q", tool: "claude", model: "old", status: "stopped" }]);
    const live = { id: "worker-q", name: "worker-q", role: "worker" as const, tool: "codex" as const, model: "new", tmux: "sst-1", status: "working" as const, task: "T001", prompts: [], history: [] };
    const s = chatState(chat.id, { agents: [live, { ...live, id: "worker-r", name: "worker-r", status: "needsYou", task: null }] });
    expect(s.agents.map((a) => [a.id, a.tool, a.model, a.tmux, a.status, a.task])).toEqual([
      ["worker-q", "codex", "new", "sst-1", "working", "T001"],
      ["worker-r", "codex", "new", "sst-1", "needsYou", null],
    ]);
    expect(s.agents[0]?.history).toEqual([{ at: "10:00", text: "old" }]);
    expect(s.agents[0]?.prompts.map((p) => [p.v, p.file, p.text])).toEqual([[1, "run/prompts/worker-q-T001-v1.md", "Do the task.\n"]]);
    // A live agent that waits for a permission is something that needs the owner.
    expect(s.needs.filter((n) => n.kind === "permission")).toMatchObject([{ kind: "permission", agent: "worker-r" }]);
  });

  test("the needs list says why an agent waits: trust, permission, other", () => {
    const dir = copyOfSample();
    const chat = createChat({ title: "Why", folder: dir });
    const base = { role: "worker" as const, tool: "codex" as const, model: "m", tmux: "t", status: "needsYou" as const, task: null, prompts: [], history: [] };
    const s = chatState(chat.id, {
      agents: [
        { ...base, id: "worker-a", name: "worker-a", need: "trust" },
        { ...base, id: "worker-b", name: "worker-b", need: "permission" },
        { ...base, id: "worker-c", name: "worker-c" },
        { ...base, id: "admin", name: "admin", role: "admin", need: "other" },
        { ...base, id: "worker-d", name: "worker-d", status: "working", need: "trust" },
      ],
    });
    const agentNeeds = s.needs.filter((n) => n.kind === "trust" || n.kind === "permission");
    expect(agentNeeds.map((n) => [n.kind, n.text, n.agent])).toEqual([
      ["trust", "worker-a: trust question", "worker-a"],
      ["permission", "worker-b needs a permission", "worker-b"],
      ["permission", "worker-c needs a permission", "worker-c"],
      ["permission", "admin: a dialog waits", "admin"],
    ]);
    expect(s.chat.needsYou).toBe(s.needs.length);
  });
});

describe("B9: the needs list holds each note that the engine stopped delivering, once", () => {
  const withNotes = (n: number): string => {
    const dir = copyOfSample();
    const chat = createChat({ title: "Notes", folder: dir });
    mkdirSync(join(dir, "run"), { recursive: true });
    let text = "";
    for (let i = 1; i <= n; i++) text = appendNote(text, { at: "2026-11-11 10:00", stage: "build", to: "orchestrator", said: `say ${i}`, note: `Do ${i}.` }).text;
    writeFileSync(join(dir, "run", "handoffs.md"), text);
    return chat.id;
  };
  const noteNeeds = (id: string) => chatState(id, { stuckNotes: [] }).needs.filter((x) => x.kind === "note");

  test("a note that the engine's own list names shows once, also when the file's own rule names it", () => {
    const id = withNotes(2);
    const dir = getChat(id).featureDir ?? "";
    // Note 1 is stuck by both rules. Note 2 has had 1 delivery: only the engine's list names it.
    updateRunState(dir, (s) => {
      s.notes["1"] = { deliveries: 3, reading: false };
      s.notes["2"] = { deliveries: 1, reading: false };
    });
    expect(noteNeeds(id).map((x) => x.text)).toEqual(["Note 1 was never confirmed: Do 1."]);
    const both = chatState(id, { stuckNotes: [1, 2] });
    expect(both.needs.filter((x) => x.kind === "note").map((x) => x.text)).toEqual(["Note 1 was never confirmed: Do 1.", "Note 2 was never confirmed: Do 2."]);
    expect(both.chat.needsYou).toBe(both.needs.length);
    // The same number twice in the list still shows once.
    expect(chatState(id, { stuckNotes: [2, 2, 1] }).needs.filter((x) => x.kind === "note")).toHaveLength(2);
  });

  test("a note that is not queued is not listed, even when the engine's list names it", () => {
    const id = withNotes(1);
    const dir = getChat(id).featureDir ?? "";
    writeFileSync(join(dir, "run", "handoffs.md"), readFileSync(join(dir, "run", "handoffs.md"), "utf8").replace("Status: queued", "Status: read"));
    expect(chatState(id, { stuckNotes: [1] }).needs.filter((x) => x.kind === "note")).toEqual([]);
  });
});

describe("G2: the needs list holds each commit the engine did not make", () => {
  test("one entry of kind build per foreign commit, in order, and none for a state with no commit", () => {
    const dir = copyOfSample();
    const chat = createChat({ title: "Foreign", folder: dir });
    mkdirSync(join(dir, "run"), { recursive: true });
    const commitNeeds = (id: string) => chatState(id).needs.filter((x) => x.text.startsWith("A commit the engine did not make"));
    expect(commitNeeds(chat.id)).toEqual([]);
    updateRunState(dir, (s) => {
      s.foreignCommits = [
        { sha: "0123456789abcdef0123456789abcdef01234567", subject: "fix by hand", at: "2026-11-11T12:00:00.000Z" },
        { sha: "fedcba9876543210fedcba9876543210fedcba98", subject: "second one", at: "2026-11-11T12:05:00.000Z" },
      ];
    });
    const s = chatState(chat.id);
    expect(commitNeeds(chat.id)).toEqual([
      { kind: "build", text: "A commit the engine did not make: 0123456 fix by hand", agent: null, task: null },
      { kind: "build", text: "A commit the engine did not make: fedcba9 second one", agent: null, task: null },
    ]);
    expect(s.chat.needsYou).toBe(s.needs.length);
  });

  test("a state file with a broken list of foreign commits keeps the good entries and does not throw", () => {
    const dir = copyOfSample();
    const chat = createChat({ title: "Foreign", folder: dir });
    mkdirSync(join(dir, "run"), { recursive: true });
    writeFileSync(
      join(dir, "run", "state.json"),
      JSON.stringify({ foreignCommits: [{ sha: "abcdef1234567", subject: "ok", at: "t" }, { sha: 3 }, "x", { sha: "bad" }], lastCommit: 5 }),
    );
    const run = readRunState(dir);
    expect(run.foreignCommits).toEqual([{ sha: "abcdef1234567", subject: "ok", at: "t" }, { sha: "bad", subject: "", at: "" }]);
    expect(run.lastCommit).toBeNull();
    expect(chatState(chat.id).needs.filter((x) => x.kind === "build")).toHaveLength(2);
  });
});

describe("G7: the role prompt is the first prompt of an agent that is not a worker", () => {
  const view = (id: string, role: "admin" | "orchestrator" | "worker" | "reviewer" | "cardRunner") => ({
    id, name: id, role, tool: "claude" as const, model: "m", tmux: "sst-x", status: "idle" as const, task: null, prompts: [], history: [],
  });
  const agentsDir = (chat: string) => join(paths.chat(chat), "agents");

  test("admin, orchestrator, reviewer and card runner show their role prompt as version 1; a worker keeps its per-task prompts only", () => {
    const dir = copyOfSample();
    const chat = createChat({ title: "Prompts", folder: dir });
    mkdirSync(agentsDir(chat.id), { recursive: true });
    const roleText = (who: string) => `# Role of ${who}\n\nYou are ${who}.\nSecond line (note 4).\n`;
    for (const who of ["admin", "orchestrator", "card-runner", "worker-b"]) writeFileSync(join(agentsDir(chat.id), `${who}.prompt.md`), roleText(who));
    // A reviewer's role prompt is the file its agent record names, inside the feature folder.
    mkdirSync(join(dir, "run", "prompts"), { recursive: true });
    const rv = join(dir, "run", "prompts", "reviewer-1-review-v1.md");
    writeFileSync(rv, roleText("reviewer-1"));
    writeFileSync(join(agentsDir(chat.id), "reviewer-1.json"), JSON.stringify({ id: "reviewer-1", promptFile: rv }));

    const s = chatState(chat.id, {
      agents: [view("admin", "admin"), view("orchestrator", "orchestrator"), view("reviewer-1", "reviewer"), view("card-runner", "cardRunner"), view("worker-b", "worker"), view("worker-a", "worker")],
    });
    const of = (id: string) => s.agents.find((a) => a.id === id)?.prompts ?? [];
    for (const [id, file] of [["admin", "agents/admin.prompt.md"], ["orchestrator", "agents/orchestrator.prompt.md"], ["card-runner", "agents/card-runner.prompt.md"], ["reviewer-1", "run/prompts/reviewer-1-review-v1.md"]] as const) {
      const p = of(id);
      expect(p).toHaveLength(1);
      expect(p[0]?.v).toBe(1);
      expect(p[0]?.file).toBe(file);
      expect(p[0]?.at).toMatch(/^\d{2}:\d{2}$/);
      expect(p[0]?.text).toBe(roleText(id));
      expect(p[0]?.lines.map((l) => l.text)).toEqual([`# Role of ${id}`, `You are ${id}.`, "Second line (note 4)."]);
      expect(p[0]?.lines[2]?.note).toBe(4);
    }
    // A worker keeps what it had: no role prompt in its list; the sample's per-task prompt stays.
    expect(of("worker-b")).toEqual([]);
    expect(of("worker-a").map((p) => p.file)).toEqual(["run/prompts/worker-a-T022-v1.md"]);
  });

  test("a chat with no repo and no feature folder shows the role prompt too, and an agent with no file shows none", () => {
    const chat = createChat({ title: "Just talk" });
    mkdirSync(agentsDir(chat.id), { recursive: true });
    writeFileSync(join(agentsDir(chat.id), "admin.prompt.md"), "You are the admin.\n");
    const s = chatState(chat.id, { agents: [view("admin", "admin"), view("orchestrator", "orchestrator")] });
    expect(s.agents.find((a) => a.id === "admin")?.prompts.map((p) => [p.v, p.file, p.text])).toEqual([[1, "agents/admin.prompt.md", "You are the admin.\n"]]);
    expect(s.agents.find((a) => a.id === "orchestrator")?.prompts).toEqual([]);
    // Without live agents the stored ones show the same.
    saveChat({ ...getChat(chat.id), agents: { admin: { id: "admin", name: "admin", role: "admin", tool: "claude", model: "m", tmux: "t", status: "idle", task: null, history: [] } } });
    expect(chatState(chat.id).agents[0]?.prompts.map((p) => p.text)).toEqual(["You are the admin.\n"]);
  });
});

describe("the config route", () => {
  test("a save that does not name bins keeps the bins the file has", async () => {
    writeFileSync(paths.config(), JSON.stringify({ bins: { claude: ["bun", "/x/fake.ts"] } }));
    const res = await api("/api/config", { method: "PUT", body: JSON.stringify({ workers: 1 }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(paths.config(), "utf8"))).toMatchObject({ workers: 1, bins: { claude: ["bun", "/x/fake.ts"], codex: ["codex"] } });
    const named = await api("/api/config", { method: "PUT", body: JSON.stringify({ bins: { codex: ["bun", "/x/other.ts"] } }) });
    expect(named.status).toBe(200);
    expect(JSON.parse(readFileSync(paths.config(), "utf8")).bins).toEqual({ claude: ["claude"], codex: ["bun", "/x/other.ts"] });
    expect((await api("/api/config", { method: "PUT", body: JSON.stringify({ bins: { claude: [] } }) })).status).toBe(400);
  });

  test("a save that does not name claudeArgs keeps the claudeArgs the file has; a save that names it changes it", async () => {
    writeFileSync(paths.config(), JSON.stringify({ claudeArgs: ["--setting-sources", "project,local"] }));
    const res = await api("/api/config", { method: "PUT", body: JSON.stringify({ workers: 1 }) });
    expect(res.status).toBe(200);
    expect(JSON.parse(readFileSync(paths.config(), "utf8"))).toMatchObject({ workers: 1, claudeArgs: ["--setting-sources", "project,local"] });
    const named = await api("/api/config", { method: "PUT", body: JSON.stringify({ claudeArgs: [] }) });
    expect(named.status).toBe(200);
    expect(JSON.parse(readFileSync(paths.config(), "utf8")).claudeArgs).toEqual([]);
    expect((await api("/api/config", { method: "PUT", body: JSON.stringify({ claudeArgs: "x" }) })).status).toBe(400);
  });
});

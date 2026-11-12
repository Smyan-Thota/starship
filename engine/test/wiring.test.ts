/**
 * The wiring of chats, repos, maps, notes, questions, findings and cards through the real HTTP server.
 * Every test runs with STARSHIP_HOME in a temp folder and git only inside temp repos.
 */
import { afterEach, beforeEach, describe, expect, test } from "bun:test";
import { appendFileSync, cpSync, existsSync, mkdirSync, readFileSync, readdirSync, rmSync, writeFileSync } from "node:fs";
import { join } from "node:path";
import { routes } from "../src/api.ts";
import { type Engine, Refused } from "../src/engine.ts";
import { chatState, createChat, getChat, saveChat } from "../src/chats.ts";
import { DEFAULTS, paths } from "../src/config.ts";
import { addFinding, disputeFinding, markNoFindings } from "../src/folder/findings.ts";
import { validatePlan } from "../src/folder/plan.ts";
import type { Question } from "../src/folder/questions.ts";
import { addRepo } from "../src/repos.ts";
import { writeCards } from "../src/review/cards.ts";
import { type EngineServer, startServer } from "../src/server.ts";
import type { AgentView, ChatState, ChatSummary, EngineEvent, MapFile, Note, QueueItem } from "../src/types.ts";
import { drop, fixture, tempDir, tempHome } from "./helpers.ts";

const randomPort = () => 20000 + Math.floor(Math.random() * 20000);

let home: ReturnType<typeof tempHome>;
let server: EngineServer;
let published: EngineEvent[];
let calls: string[];
let dirs: string[];

beforeEach(() => {
  home = tempHome();
  published = [];
  calls = [];
  dirs = [];
  server = startServer({
    routes: routes({
      publish: (e) => {
        published.push(e);
        server.publish(e);
      },
      onNote: (id, n: Note) => calls.push(`note ${id} ${n.n} ${n.to} ${n.status}`),
      onQuestion: (id, q: Question) => calls.push(`question ${id} Q${q.n} ${q.status}`),
      onAnswer: (id, q: Question) => calls.push(`answer ${id} Q${q.n} ${q.status}`),
      onFinding: (id) => calls.push(`finding ${id}`),
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
const put = (path: string, body: unknown) => api(path, { method: "PUT", body: JSON.stringify(body) });
const errorOf = async (res: Response) => ((await res.json()) as { error: string }).error;

/** A temp git repo on main. `features` are feature folders committed on main. */
function gitRepo(features: string[] = []): string {
  const dir = tempDir("starship-repo-");
  dirs.push(dir);
  const g = (...args: string[]) => {
    const r = Bun.spawnSync(["git", "-C", dir, "-c", "user.name=Test", "-c", "user.email=test@example.com", "-c", "commit.gpgsign=false", ...args], { stdout: "pipe", stderr: "pipe" });
    if (r.exitCode !== 0) throw new Error(r.stderr.toString());
    return r.stdout.toString().trim();
  };
  g("init", "-q", "-b", "main");
  writeFileSync(join(dir, "README.md"), "# Repo\n");
  mkdirSync(join(dir, "src"));
  writeFileSync(join(dir, "src", "index.ts"), "export {};\n");
  for (const f of features) {
    mkdirSync(join(dir, "docs", "features", f), { recursive: true });
    writeFileSync(join(dir, "docs", "features", f, "PLAN.md"), "# Plan\n");
    writeFileSync(join(dir, "docs", "features", f, "SPEC.md"), "# Spec\n");
  }
  g("add", ".");
  g("commit", "-q", "-m", "one");
  g("branch", "-q", "other");
  return dir;
}

function addDemo(features: string[] = []): string {
  const dir = gitRepo(features);
  addRepo(dir, { name: "demo" });
  return dir;
}

async function newChat(title: string, extra: Record<string, unknown> = {}): Promise<ChatState> {
  const res = await post("/api/chats", { title, repo: "demo", ...extra });
  if (res.status !== 200) throw new Error(`new chat: ${res.status} ${await res.text()}`);
  return (await res.json()) as ChatState;
}

/** A chat on the demo repo whose feature folder holds a copy of the sample plan, run files and wireframe. */
async function sampleChat(title = "Recipe search", withReview = true): Promise<{ id: string; dir: string; state: ChatState }> {
  const state = await newChat(title);
  const dir = state.chat.featureDir ?? "";
  cpSync(fixture("recipe-search"), dir, { recursive: true, force: true });
  if (!withReview) rmSync(join(dir, "run", "review"), { recursive: true, force: true });
  return { id: state.chat.id, dir, state: await get<ChatState>(`/api/chats/${state.chat.id}`) };
}

const read = (...p: string[]) => readFileSync(join(...p), "utf8");

describe("new chat on a repo", () => {
  test("C13: two chats with one title on one repo get a worktree each, the second slug ends in -2", async () => {
    addDemo();
    const a = await newChat("Recipe search");
    const b = await newChat("Recipe search");
    expect(a.chat).toMatchObject({ slug: "recipe-search", branch: "starship/recipe-search", stage: "map", repo: "demo" });
    expect(b.chat).toMatchObject({ slug: "recipe-search-2", branch: "starship/recipe-search-2", stage: "map" });
    const wt = join(home.dir, "worktrees", "demo", "recipe-search");
    expect(a.chat.worktree).toBe(wt);
    expect(a.chat.featureDir).toBe(join(wt, "docs", "features", "recipe-search"));
    expect(existsSync(join(wt, "docs", "features", "recipe-search", "run"))).toBe(true);
    expect(b.chat.worktree).toBe(join(home.dir, "worktrees", "demo", "recipe-search-2"));
    // chat.json holds the four fields.
    const stored = JSON.parse(read(paths.chat(a.chat.id), "chat.json"));
    expect(stored).toMatchObject({ worktree: wt, branch: "starship/recipe-search", slug: "recipe-search", featureDir: a.chat.featureDir });
    expect(published).toEqual([{ type: "chats" }, { type: "chats" }]);
  });

  test("a repo with a map starts the chat in plan, one without starts it in map", async () => {
    addDemo();
    expect((await newChat("First")).chat.stage).toBe("map");
    cpSync(fixture("maps", "starship.json"), join(paths.repos(), "demo.map.json"));
    expect((await newChat("Second")).chat.stage).toBe("plan");
  });

  test("a feature that is on the base branch is adopted: slug, folder and plan stage", async () => {
    addDemo(["v1-repos"]);
    const s = await newChat("Anything", { feature: "v1-repos" });
    expect(s.chat).toMatchObject({ slug: "v1-repos", branch: "starship/v1-repos", stage: "plan" });
    expect(readFileSync(join(s.chat.featureDir ?? "", "PLAN.md"), "utf8")).toBe("# Plan\n");
  });

  test("C14: a branch that exists makes git fail, the chat is not created, and the error is git's text", async () => {
    const dir = addDemo(["v1-repos"]);
    Bun.spawnSync(["git", "-C", dir, "branch", "starship/v1-repos"]);
    const res = await post("/api/chats", { title: "Again", repo: "demo", feature: "v1-repos" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toMatch(/starship\/v1-repos/);
    expect((await get<ChatSummary[]>("/api/chats")).length).toBe(0);
    expect(existsSync(join(home.dir, "worktrees", "demo", "v1-repos"))).toBe(false);
    expect(published).toEqual([]);
  });

  test("C14: a feature that is not on the base branch is refused with no chat", async () => {
    addDemo();
    const res = await post("/api/chats", { title: "Ghost", repo: "demo", feature: "ghost" });
    expect(res.status).toBe(400);
    expect(await errorOf(res)).toContain("ghost");
    expect((await get<ChatSummary[]>("/api/chats")).length).toBe(0);
  });

  test("a feature name that leaves the folder is refused; a feature with no repo is refused", async () => {
    addDemo();
    for (const feature of ["../x", "a/b", ".."]) expect((await post("/api/chats", { title: "x", repo: "demo", feature })).status).toBe(400);
    expect((await post("/api/chats", { title: "x", feature: "v1" })).status).toBe(400);
    expect((await get<ChatSummary[]>("/api/chats")).length).toBe(0);
  });

  test("a chat with no repo has no stage and no worktree, as before", async () => {
    const res = await post("/api/chats", { title: "Loose" });
    const s = (await res.json()) as ChatState;
    expect(s.chat).toMatchObject({ stage: null, worktree: null, branch: null, slug: null, featureDir: null });
    expect(s.build.status).toBe("notStarted");
    expect(s.plan).toBeNull();
    expect(s.review).toBeNull();
  });
});

describe("chat state", () => {
  test("build comes from run/state.json for a chat with a repo; a chat with no repo is notStarted", async () => {
    addDemo();
    const { id, dir } = await sampleChat();
    const build = {
      status: "stopped",
      reason: { kind: "checkpoint" as const, text: "Phase 1 checkpoint failed 3 times" },
      startedAt: "2026-11-11T15:00:00Z",
    };
    writeFileSync(
      join(dir, "run", "state.json"),
      JSON.stringify({ build, tasks: {}, outside: ["scripts/x.ts"], dropped: [{ task: "T040", text: "Cache", reason: "not needed" }], lastFixSent: 2 }),
    );
    const s = await get<ChatState>(`/api/chats/${id}`);
    expect(s.build).toEqual({ status: "stopped", reason: build.reason, outside: ["scripts/x.ts"], dropped: [{ task: "T040", text: "Cache", reason: "not needed" }], lastFixSent: 2 });

    const folderOnly = createChat({ title: "Folder only", folder: dir });
    expect(chatState(folderOnly.id).build).toEqual({ status: "notStarted", reason: null, outside: [], dropped: [], lastFixSent: 0 });
  });

  test("a chat with a repo and no run/state.json is notStarted", async () => {
    addDemo();
    const s = await newChat("Fresh");
    expect(s.build).toEqual({ status: "notStarted", reason: null, outside: [], dropped: [], lastFixSent: 0 });
  });

  test("task states merge from run/state.json, including blocked and dropped", async () => {
    addDemo();
    const { id, dir } = await sampleChat();
    writeFileSync(
      join(dir, "run", "state.json"),
      JSON.stringify({ tasks: { T022: { state: "blocked", agent: null, attempts: 3 }, T023: { state: "dropped", agent: null, attempts: 0 }, T024: { state: "escalated", agent: "worker-a", attempts: 3 }, T030: { state: "parked" } } }),
    );
    const tasks = (await get<ChatState>(`/api/chats/${id}`)).tasks?.phases.flatMap((p) => p.tasks) ?? [];
    expect(tasks.find((t) => t.id === "T022")).toMatchObject({ state: "blocked", attempts: 3 });
    expect(tasks.find((t) => t.id === "T023")).toMatchObject({ state: "dropped" });
    expect(tasks.find((t) => t.id === "T024")).toMatchObject({ state: "escalated", agent: "worker-a" });
    expect(tasks.find((t) => t.id === "T030")).toMatchObject({ state: "parked" });
  });

  test("a prompt version carries the text of its file", async () => {
    addDemo();
    const { id, dir } = await sampleChat();
    const c = getChat(id);
    c.agents["worker-a"] = { id: "worker-a", name: "Worker A", role: "worker", tool: "codex", model: "", tmux: "t", status: "working", task: "T022", history: [] };
    saveChat(c);
    const s = await get<ChatState>(`/api/chats/${id}`);
    const p = s.agents[0]?.prompts[0];
    expect(p?.text).toBe(read(dir, "run", "prompts", "worker-a-T022-v1.md"));
    expect(p?.lines.length).toBeGreaterThan(1);
  });

  test("plan: problems come from the validator and the lines from the plan files", async () => {
    addDemo();
    const { id, dir, state } = await sampleChat();
    expect(state.plan?.problems).toEqual(validatePlan(dir, { adrDir: join(state.chat.worktree ?? "", "docs", "adr") }));
    expect(state.plan?.problems.length).toBeGreaterThan(0);
    expect(state.plan?.lines).toEqual([
      { label: "Problem", value: "Cooks scroll the whole cookbook to find one recipe.", file: "SPEC.md", heading: "Problem" },
      { label: "Scope", value: "3 in scope, 2 out", file: "PLAN.md", heading: "In scope" },
      { label: "Tasks", value: "20 in 5 phases", file: "TASKS.md", heading: null },
      { label: "Wireframes", value: "1", file: "wireframes", heading: null },
    ]);

    // A test heading gives the Tests line: the first non-empty line under it.
    writeFileSync(join(dir, "PLAN.md"), read(dir, "PLAN.md") + "\n## Test strategy\n\nUnit tests for the parser, then one browser test.\nMore text.\n");
    const withTests = (await get<ChatState>(`/api/chats/${id}`)).plan?.lines ?? [];
    expect(withTests.map((l) => l.label)).toEqual(["Problem", "Scope", "Tasks", "Tests", "Wireframes"]);
    expect(withTests.find((l) => l.label === "Tests")).toEqual({ label: "Tests", value: "Unit tests for the parser, then one browser test.", file: "PLAN.md", heading: "Test strategy" });
  });

  test("plan: a line is left out when its source is missing", async () => {
    addDemo();
    const { id, dir } = await sampleChat();
    rmSync(join(dir, "SPEC.md"));
    rmSync(join(dir, "wireframes"), { recursive: true });
    writeFileSync(join(dir, "TASKS.md"), "# Tasks\n\nnot a task line\n- [ ] T001 broken\n");
    const s = await get<ChatState>(`/api/chats/${id}`);
    expect(s.plan?.lines.map((l) => l.label)).toEqual(["Scope"]);
    expect(s.plan?.problems.some((p) => p.file === "SPEC.md" && p.code === "missing-file")).toBe(true);
  });

  test("plan: a decision record that is Superseded is a problem, found under the worktree's docs/adr", async () => {
    addDemo();
    const { id, dir, state } = await sampleChat();
    const adr = join(state.chat.worktree ?? "", "docs", "adr");
    mkdirSync(adr, { recursive: true });
    writeFileSync(join(adr, "2026-11-11-search-in-postgres.md"), "# Search in Postgres\n\nStatus: Superseded\n");
    const problems = (await get<ChatState>(`/api/chats/${id}`)).plan?.problems ?? [];
    expect(problems.find((p) => p.code === "decision-status")).toMatchObject({ file: "PLAN.md" });
    expect(dir.startsWith(state.chat.worktree ?? "?")).toBe(true);
  });

  test("a chat with no repo has no plan", async () => {
    const dir = tempDir();
    dirs.push(dir);
    cpSync(fixture("recipe-search"), dir, { recursive: true });
    const c = createChat({ title: "Folder", folder: dir });
    expect(chatState(c.id).plan).toBeNull();
  });

  test("wireframes come from the wireframes folder with their links", async () => {
    addDemo();
    const { state } = await sampleChat();
    expect(state.wireframes).toEqual([{ name: "search", path: "wireframes/search.html", url: "https://example.com/wireframes/search" }]);
  });

  test("review is null with no file in run/review/, and holds findings, cards and fixes with one", async () => {
    addDemo();
    const without = await sampleChat("No review", false);
    expect(without.state.review).toBeNull();
    const withReview = await sampleChat("With review");
    expect(withReview.state.review?.findings.map((f) => [f.n, f.status])).toEqual([
      [1, "open"],
      [2, "accepted"],
    ]);
    expect(withReview.state.review?.cards.map((c) => [c.id, c.result])).toEqual([
      ["C1", "pass"],
      ["C2", null],
    ]);
    expect(withReview.state.review?.fixes.map((f) => [f.n, f.from])).toEqual([
      [1, "F1"],
      [2, "F2"],
    ]);
    expect(withReview.state.review?.none).toEqual([]);
    markNoFindings(withReview.dir, "card-runner");
    expect((await get<ChatState>(`/api/chats/${withReview.id}`)).review?.none).toEqual(["card-runner"]);
  });

  test("a folder with an empty run/review/ has no review", async () => {
    addDemo();
    const s = await newChat("Empty review");
    mkdirSync(join(s.chat.featureDir ?? "", "run", "review"), { recursive: true });
    expect((await get<ChatState>(`/api/chats/${s.chat.id}`)).review).toBeNull();
  });

  test("needs lists each thing that waits for the owner, and needsYou is its length in the state and the chat list", async () => {
    addDemo();
    const { id, dir } = await sampleChat("Needs", false);
    expect((await get<ChatState>(`/api/chats/${id}`)).needs.map((n) => n.kind)).toEqual(["question", "blocked"]);

    const c = getChat(id);
    const agent = (key: string, status: "needsYou" | "stalled" | "stopped" | "working" | "idle") => {
      c.agents[key] = { id: key, name: key, role: "worker", tool: "codex", model: "", tmux: `t-${key}`, status, task: null, history: [] };
    };
    agent("a-perm", "needsYou");
    agent("a-stall", "stalled");
    agent("a-dead", "stopped");
    agent("a-ok", "working");
    agent("a-idle", "idle");
    saveChat(c);

    appendFileSync(join(dir, "run", "handoffs.md"), "\n## Note 4 · 2026-11-11 16:00 · build → orchestrator\nYou: a\nNote: Four.\nStatus: queued\n\n## Note 5 · 2026-11-11 16:01 · build → orchestrator\nYou: b\nNote: Five.\nStatus: queued\n\n## Note 6 · 2026-11-11 16:02 · build → orchestrator\nYou: c\nNote: Six.\nStatus: read 16:05\n");
    writeFileSync(
      join(dir, "run", "state.json"),
      JSON.stringify({
        build: { status: "stopped", reason: { kind: "tasks", text: "TASKS.md line 9 cannot be read" }, startedAt: null },
        tasks: { T031: { state: "blocked", agent: null, attempts: 0 } },
        notes: { "3": { deliveries: 5, reading: false }, "4": { deliveries: 3, reading: false }, "5": { deliveries: 2, reading: false }, "6": { deliveries: 3, reading: false } },
      }),
    );
    addFinding(dir, { sev: "high", reviewer: "codex", where: "a.ts:1", text: "Bad." });
    disputeFinding(dir, 1, "claude", "Not bad.");

    const s = await get<ChatState>(`/api/chats/${id}`);
    expect(s.needs.map((n) => n.kind)).toEqual(["question", "permission", "stalled", "stopped", "blocked", "build", "finding", "note"]);
    expect(s.needs[0]).toMatchObject({ agent: "worker-b", task: "T023" });
    expect(s.needs[1]).toMatchObject({ agent: "a-perm" });
    expect(s.needs[4]).toMatchObject({ task: "T031" });
    expect(s.needs[5]?.text).toContain("TASKS.md line 9");
    expect(s.needs[6]?.text).toContain("F1");
    expect(s.needs[7]?.text).toContain("Note 4");
    expect(s.chat.needsYou).toBe(8);
    const list = await get<ChatSummary[]>("/api/chats");
    expect(list.find((x) => x.id === id)?.needsYou).toBe(8);
  });

  test("a bad run/state.json never breaks the state", async () => {
    addDemo();
    const { id, dir } = await sampleChat();
    writeFileSync(join(dir, "run", "state.json"), "{nope");
    const s = await get<ChatState>(`/api/chats/${id}`);
    expect(s.build.status).toBe("notStarted");
    expect(s.tasks?.total).toBe(20);
  });
});

describe("map routes", () => {
  const starship = () => JSON.parse(readFileSync(fixture("maps", "starship.json"), "utf8")) as MapFile;

  test("GET gives null and no errors before a map exists; an unknown repo is 404", async () => {
    addDemo();
    expect(await get("/api/repos/demo/map")).toEqual({ map: null, errors: [] });
    expect((await api("/api/repos/nope/map")).status).toBe(404);
  });

  test("import checks the file, copies it, and the repo shows a map", async () => {
    addDemo();
    const res = await post("/api/repos/demo/map/import", { file: fixture("maps", "starship.json") });
    expect(res.status).toBe(200);
    expect(published).toContainEqual({ type: "repos" });
    const got = await get<{ map: MapFile; errors: string[] }>("/api/repos/demo/map");
    expect(got.errors).toEqual([]);
    expect(got.map.name).toBe("starship");
    expect(existsSync(join(paths.repos(), "demo.map.json"))).toBe(true);
    expect((await get<{ hasMap: boolean }[]>("/api/repos"))[0]?.hasMap).toBe(true);
  });

  test("I1: a map with a step on a missing pipe is refused with the list of errors, and nothing is written", async () => {
    addDemo();
    const bad = starship();
    bad.flows.over = { name: "Overview", steps: [{ n: "1", pipe: "no-such-pipe", label: "x", text: "A step on a pipe that is not there.", where: "a.ts" }] };
    const file = join(tempDir(), "bad.map.json");
    dirs.push(join(file, ".."));
    writeFileSync(file, JSON.stringify(bad));
    const res = await post("/api/repos/demo/map/import", { file });
    expect(res.status).toBe(400);
    const body = (await res.json()) as { error: string; errors: string[] };
    expect(body.errors.length).toBeGreaterThan(0);
    expect(body.errors.join("\n")).toContain("no-such-pipe");
    expect(body.error).toContain("no-such-pipe");
    expect(existsSync(join(paths.repos(), "demo.map.json"))).toBe(false);
    expect((await post("/api/repos/demo/map/import", { file: "relative.json" })).status).toBe(400);
    expect((await post("/api/repos/demo/map/import", {})).status).toBe(400);
    expect((await post("/api/repos/nope/map/import", { file: fixture("maps", "starship.json") })).status).toBe(404);
  });

  test("I2: build writes a low detail map from the repo's folders", async () => {
    addDemo();
    const res = await post("/api/repos/demo/map/build");
    expect(res.status).toBe(200);
    const body = (await res.json()) as { map: MapFile; errors: string[] };
    expect(body.map.detail).toBe("low");
    expect(body.map.boxes.map((b) => b.id)).toContain("src");
    const got = await get<{ map: MapFile }>("/api/repos/demo/map");
    expect(got.map.detail).toBe("low");
    expect(published).toContainEqual({ type: "repos" });
    expect((await post("/api/repos/nope/map/build")).status).toBe(404);
  });

  test("with ?chat= the chat's overlay is applied: the flow 'plan' comes first", async () => {
    addDemo();
    await post("/api/repos/demo/map/import", { file: fixture("maps", "starship.json") });
    const s = await newChat("Overlay");
    const box = starship().boxes.find((b) => b.chips.length > 0);
    const chip = box?.chips[0];
    if (!box || chip === undefined) throw new Error("the sample map has no chip");
    const dir = s.chat.featureDir ?? "";
    writeFileSync(join(dir, "run", "map-overlay.json"), JSON.stringify({ lit: { [box.id]: [chip] }, steps: [] }));
    const got = await get<{ map: MapFile; errors: string[] }>(`/api/repos/demo/map?chat=${s.chat.id}`);
    expect(got.errors).toEqual([]);
    expect(got.map.order[0]).toBe("plan");
    expect(got.map.flows.plan?.name).toBe("This plan");
    expect(got.map.flows.plan?.lit).toEqual({ [box.id]: [chip] });
    // Without ?chat= the map is as imported.
    expect((await get<{ map: MapFile }>("/api/repos/demo/map")).map.flows.plan).toBeUndefined();

    writeFileSync(join(dir, "run", "map-overlay.json"), JSON.stringify({ lit: { nope: ["x"] } }));
    const bad = await get<{ map: MapFile; errors: string[] }>(`/api/repos/demo/map?chat=${s.chat.id}`);
    expect(bad.errors.join("\n")).toContain("nope");
    expect(bad.map.order[0]).toBe("plan");
    expect((await api("/api/repos/demo/map?chat=nope")).status).toBe(404);
  });
});

describe("config routes", () => {
  test("GET gives the defaults; PUT checks, saves and announces", async () => {
    expect(await get("/api/config")).toEqual(DEFAULTS);
    const res = await put("/api/config", { workers: 3, terminalApp: "Terminal" });
    expect(res.status).toBe(200);
    expect(published).toEqual([{ type: "config" }]);
    const saved = (await res.json()) as typeof DEFAULTS;
    expect(saved).toMatchObject({ workers: 3, terminalApp: "Terminal", maxWorkers: 3 });
    expect(JSON.parse(read(home.dir, "config.json"))).toEqual(saved);
    expect(await get("/api/config")).toEqual(saved);
  });

  test("PUT that leaves out codexArgs keeps the file's own; a PUT that names it changes it", async () => {
    writeFileSync(join(home.dir, "config.json"), JSON.stringify({ codexArgs: ["-s", "read-only"] }));
    const kept = (await (await put("/api/config", { workers: 2 })).json()) as typeof DEFAULTS;
    expect(kept.codexArgs).toEqual(["-s", "read-only"]);
    expect(JSON.parse(read(home.dir, "config.json")).codexArgs).toEqual(["-s", "read-only"]);
    const set = (await (await put("/api/config", { codexArgs: [] })).json()) as typeof DEFAULTS;
    expect(set.codexArgs).toEqual([]);
    expect((await put("/api/config", { maxHeavy: 2 })).status).toBe(400);
  });

  test("PUT refuses a bad value with 400 and the error text, and saves nothing", async () => {
    for (const [body, word] of [
      [{ workers: 9 }, "workers"],
      [{ terminalApp: "Foo" }, "terminalApp"],
      [{ switch: { from: "claude", to: "claude" } }, "switch"],
      [{ roles: { nobody: { tool: "claude" } } }, "nobody"],
    ] as const) {
      const res = await put("/api/config", body);
      expect(res.status).toBe(400);
      expect(await errorOf(res)).toContain(word);
    }
    expect((await put("/api/config", [1])).status).toBe(400);
    expect(existsSync(join(home.dir, "config.json"))).toBe(false);
    expect(published).toEqual([]);
  });
});

describe("wireframe link", () => {
  test("a link is saved to links.json and shows in the state", async () => {
    addDemo();
    const { id, dir } = await sampleChat();
    const res = await post(`/api/chats/${id}/wireframes/search/link`, { url: "https://claude.ai/artifact/new" });
    expect(res.status).toBe(200);
    expect(JSON.parse(read(dir, "wireframes", "links.json"))).toEqual({ search: "https://claude.ai/artifact/new" });
    expect((await get<ChatState>(`/api/chats/${id}`)).wireframes[0]?.url).toBe("https://claude.ai/artifact/new");
    expect(published).toContainEqual({ type: "chat", id });
  });

  test("a bad url is 400; an unknown wireframe is 404; an unknown chat is 404", async () => {
    addDemo();
    const { id } = await sampleChat();
    expect((await post(`/api/chats/${id}/wireframes/search/link`, { url: "javascript:alert(1)" })).status).toBe(400);
    expect((await post(`/api/chats/${id}/wireframes/search/link`, {})).status).toBe(400);
    expect((await post(`/api/chats/${id}/wireframes/nope/link`, { url: "https://x.example/a" })).status).toBe(404);
    expect((await post("/api/chats/nope/wireframes/search/link", { url: "https://x.example/a" })).status).toBe(404);
  });
});

describe("notes", () => {
  const note = (id: string, to: string, extra: Record<string, unknown> = {}) => post(`/api/chats/${id}/notes`, { to, said: "owner words", note: "The note.", ...extra });

  test("a note to the orchestrator is queued; a note to the plan or the repo is read at once; a note to fixes is queued", async () => {
    addDemo();
    const { id, dir } = await sampleChat("Notes", false);
    const o = (await (await note(id, "orchestrator")).json()) as Note;
    expect(o).toMatchObject({ n: 4, to: "orchestrator", status: "queued", said: "owner words", note: "The note.", stage: "map" });
    const p = (await (await note(id, "plan")).json()) as Note;
    expect(p).toMatchObject({ n: 5, to: "plan", status: "read" });
    expect(p.readAt).toMatch(/^\d{2}:\d{2}$/);
    const r = (await (await note(id, "repo")).json()) as Note;
    expect(r).toMatchObject({ n: 6, to: "repo", status: "read" });
    const f = (await (await note(id, "fixes")).json()) as Note;
    expect(f).toMatchObject({ n: 7, to: "fixes", status: "queued" });

    const s = await get<ChatState>(`/api/chats/${id}`);
    expect(s.notes.map((n) => [n.n, n.to, n.status])).toEqual([
      [1, "plan", "read"],
      [2, "plan", "read"],
      [3, "orchestrator", "read"],
      [4, "orchestrator", "queued"],
      [5, "plan", "read"],
      [6, "repo", "read"],
      [7, "fixes", "queued"],
    ]);
    expect(s.unreadableNotes).toEqual([]);
    expect(read(dir, "run", "handoffs.md")).toContain("## Note 4 ");
    expect(calls).toEqual([`note ${id} 4 orchestrator queued`, `note ${id} 5 plan read`, `note ${id} 6 repo read`, `note ${id} 7 fixes queued`]);
    expect(published.filter((e) => e.type === "chat").length).toBe(4);
  });

  test("a repo note is also appended to the repo's notes file", async () => {
    addDemo();
    const { id } = await sampleChat("Repo notes", false);
    await note(id, "repo", { note: "The repo uses bun." });
    await note(id, "repo", { note: "Tests live in test/." });
    const text = read(paths.repos(), "demo.notes.md");
    expect(text.startsWith("# ")).toBe(true);
    expect(text).toContain("The repo uses bun.");
    expect(text).toContain("Tests live in test/.");
    expect(text.indexOf("bun")).toBeLessThan(text.indexOf("test/"));
    expect(text).toContain(id);
    // A note to the plan does not go to the repo file.
    await note(id, "plan", { note: "Plan only." });
    expect(read(paths.repos(), "demo.notes.md")).not.toContain("Plan only.");
  });

  test("B3: a note to the orchestrator is held while the chat is halted; the others are recorded as usual", async () => {
    addDemo();
    const { id } = await sampleChat("Halted", false);
    const c = getChat(id);
    c.halted = "15:30";
    saveChat(c);
    expect(((await (await note(id, "orchestrator")).json()) as Note).status).toBe("held");
    expect(((await (await note(id, "plan")).json()) as Note).status).toBe("read");
    expect(((await (await note(id, "fixes")).json()) as Note).status).toBe("queued");
    expect(((await (await note(id, "repo")).json()) as Note).status).toBe("read");
  });

  test("a fixes note joins the fix list and keeps the numbers of the fixes before it", async () => {
    addDemo();
    const { id, dir } = await sampleChat("Fix notes");
    await note(id, "fixes", { note: "Also rename the label." });
    const s = await get<ChatState>(`/api/chats/${id}`);
    expect(s.review?.fixes.map((f) => [f.n, f.from, f.text])).toEqual([
      [1, "F1", 'Search does not trim the query, so " R-111" finds nothing. (api/src/services/RecipeSearchService.ts:42)'],
      [2, "F2", "The empty state gives no hint to clear the filter. (app/src/RecipeSearch.tsx:18)"],
      [3, "Note 4", "Also rename the label."],
    ]);
    expect(read(dir, "run", "review", "fixes.md")).toContain("- X3 Also rename the label. — from Note 4");
  });

  test("a note that is not for fixes does not create the review files", async () => {
    addDemo();
    const { id, dir } = await sampleChat("No review files", false);
    await note(id, "orchestrator");
    await note(id, "plan");
    expect(existsSync(join(dir, "run", "review"))).toBe(false);
    expect((await get<ChatState>(`/api/chats/${id}`)).review).toBeNull();
  });

  test("bad input is 400, a repo note on a chat with no repo is 400, an unknown chat is 404, a chat with no folder is 404", async () => {
    addDemo();
    const { id, dir } = await sampleChat("Bad notes", false);
    expect((await note(id, "nobody")).status).toBe(400);
    expect((await note(id, "plan", { note: "  " })).status).toBe(400);
    expect((await note(id, "plan", { said: undefined })).status).toBe(400);
    expect((await post(`/api/chats/${id}/notes`, [1])).status).toBe(400);
    expect((await note("nope", "plan")).status).toBe(404);
    const bare = createChat({ title: "Bare" });
    expect((await note(bare.id, "plan")).status).toBe(404);
    const folderOnly = createChat({ title: "Folder only", folder: dir });
    expect((await note(folderOnly.id, "repo")).status).toBe(400);
    expect(read(dir, "run", "handoffs.md")).not.toContain("Note 4");
    expect(calls).toEqual([]);
  });
});

describe("questions", () => {
  test("a question is added open, the owner answers it, and each step calls the loop", async () => {
    addDemo();
    const { id, dir } = await sampleChat("Questions", false);
    const res = await post(`/api/chats/${id}/questions`, { task: "T024", text: "Sort by name or number?", agent: "worker-a" });
    expect(res.status).toBe(200);
    const q = (await res.json()) as Question;
    expect(q).toMatchObject({ n: 2, agent: "worker-a", task: "T024", question: "Sort by name or number?", status: "open" });
    expect(read(dir, "run", "questions.md")).toContain("## Q2 · ");
    expect((await get<ChatState>(`/api/chats/${id}`)).needs.filter((n) => n.kind === "question").length).toBe(2);

    const ans = await post(`/api/chats/${id}/questions/Q2/answer`, { text: "By name." });
    expect(ans.status).toBe(200);
    expect((await ans.json()) as Question).toMatchObject({ n: 2, status: "answered", answer: "By name." });
    expect((await get<ChatState>(`/api/chats/${id}`)).questions.find((x) => x.n === 2)).toMatchObject({ status: "answered", answer: "By name." });
    expect(calls).toEqual([`question ${id} Q2 open`, `answer ${id} Q2 answered`]);
    expect(published.filter((e) => e.type === "chat").length).toBe(2);

    // The plain number works too.
    expect((await post(`/api/chats/${id}/questions/1/answer`, { text: "Exclude them." })).status).toBe(200);
  });

  test("an answer twice is 400, an unknown question is 404, bad input is 400, an unknown chat is 404", async () => {
    addDemo();
    const { id } = await sampleChat("Q errors", false);
    expect((await post(`/api/chats/${id}/questions/Q1/answer`, { text: "Yes." })).status).toBe(200);
    expect((await post(`/api/chats/${id}/questions/Q1/answer`, { text: "Again." })).status).toBe(400);
    expect((await post(`/api/chats/${id}/questions/Q9/answer`, { text: "x" })).status).toBe(404);
    expect((await post(`/api/chats/${id}/questions/abc/answer`, { text: "x" })).status).toBe(400);
    expect((await post(`/api/chats/${id}/questions/Q1/answer`, {})).status).toBe(400);
    expect((await post(`/api/chats/${id}/questions`, { task: "T1", text: "", agent: "a" })).status).toBe(400);
    expect((await post(`/api/chats/${id}/questions`, { task: "T1", text: "Why?" })).status).toBe(400);
    expect((await post(`/api/chats/${id}/questions`, { text: "Why?", agent: "a" })).status).toBe(400);
    expect((await post("/api/chats/nope/questions", { task: "T1", text: "Why?", agent: "a" })).status).toBe(404);
    expect(calls).toEqual([`answer ${id} Q1 answered`]);
  });
});

describe("findings and cards", () => {
  const finding = (id: string, extra: Record<string, unknown> = {}) => post(`/api/chats/${id}/findings`, { sev: "high", where: "api/a.ts:12", text: "It breaks.", reviewer: "codex", ...extra });

  test("H4: a finding is added open, another reviewer disputes it, the owner accepts or rejects it; the fix list follows each step", async () => {
    addDemo();
    const { id, dir } = await sampleChat("Findings", false);
    const fixes = () => (existsSync(join(dir, "run", "review", "fixes.md")) ? read(dir, "run", "review", "fixes.md") : "");

    const added = await finding(id);
    expect(added.status).toBe(200);
    expect(await added.json()).toMatchObject({ n: 1, sev: "high", reviewer: "codex", where: "api/a.ts:12", text: "It breaks.", status: "open" });
    expect(fixes()).toContain("- X1 It breaks. (api/a.ts:12) — from F1");

    const disputed = await post(`/api/chats/${id}/findings/1/dispute`, { reviewer: "claude", why: "It does not." });
    expect(disputed.status).toBe(200);
    expect(await disputed.json()).toMatchObject({ status: "disputed", dispute: { reviewer: "claude", why: "It does not." } });
    expect(fixes()).not.toContain("F1");
    const s = await get<ChatState>(`/api/chats/${id}`);
    expect(s.needs.some((n) => n.kind === "finding")).toBe(true);
    expect(s.review?.findings[0]?.status).toBe("disputed");

    const accepted = await post(`/api/chats/${id}/findings/1/accept`);
    expect(accepted.status).toBe(200);
    expect(await accepted.json()).toMatchObject({ n: 1, status: "accepted" });
    expect(fixes()).toContain("— from F1");

    await finding(id, { where: "api/b.ts:3", text: "Second.", reviewer: "claude" });
    const rejected = await post(`/api/chats/${id}/findings/2/reject`, { why: "By design." });
    expect(await rejected.json()).toMatchObject({ n: 2, status: "rejected" });
    expect(fixes()).toContain("from F1");
    expect(fixes()).not.toContain("from F2");
    expect((await get<ChatState>(`/api/chats/${id}`)).needs.some((n) => n.kind === "finding")).toBe(false);
    expect(calls).toEqual([`finding ${id}`, `finding ${id}`, `finding ${id}`, `finding ${id}`, `finding ${id}`]);
    expect(published.filter((e) => e.type === "chat").length).toBe(5);
  });

  test("a fix keeps its number when the list is built again", async () => {
    addDemo();
    const { id, dir } = await sampleChat("Fix numbers");
    // The sample has X1 for F1 and X2 for F2. A new finding gets X3 and the old two stay.
    await finding(id, { where: "api/c.ts:9", text: "Third.", reviewer: "claude" });
    expect(read(dir, "run", "review", "fixes.md")).toBe(
      "# Fixes\n\n" +
        '- X1 Search does not trim the query, so " R-111" finds nothing. (api/src/services/RecipeSearchService.ts:42) — from F1\n' +
        "- X2 The empty state gives no hint to clear the filter. (app/src/RecipeSearch.tsx:18) — from F2\n" +
        "- X3 Third. (api/c.ts:9) — from F3\n",
    );
  });

  test("errors: own dispute, bad severity, bad where, unknown finding, reject with no why", async () => {
    addDemo();
    const { id } = await sampleChat("Finding errors", false);
    await finding(id);
    expect((await post(`/api/chats/${id}/findings/1/dispute`, { reviewer: "codex", why: "mine" })).status).toBe(400);
    expect((await post(`/api/chats/${id}/findings/1/dispute`, { reviewer: "claude" })).status).toBe(400);
    expect((await finding(id, { sev: "huge" })).status).toBe(400);
    expect((await finding(id, { where: "no-line" })).status).toBe(400);
    expect((await finding(id, { text: "" })).status).toBe(400);
    expect((await finding(id, { reviewer: undefined })).status).toBe(400);
    expect((await post(`/api/chats/${id}/findings/9/accept`)).status).toBe(404);
    expect((await post(`/api/chats/${id}/findings/9/reject`, { why: "x" })).status).toBe(404);
    expect((await post(`/api/chats/${id}/findings/x/accept`)).status).toBe(400);
    expect((await post(`/api/chats/${id}/findings/1/reject`, {})).status).toBe(400);
    expect((await finding("nope")).status).toBe(404);
    expect(calls).toEqual([`finding ${id}`]);
  });

  test("a card result is written to the card and shows in the review", async () => {
    addDemo();
    const { id, dir } = await sampleChat("Cards", false);
    writeCards(dir, [{ id: "C1", title: "Search", description: "", criteria: ["It finds R-111"], result: null, note: "" }]);
    const res = await post(`/api/chats/${id}/cards/C1/result`, { result: "fail", note: "Found nothing." });
    expect(res.status).toBe(200);
    expect(await res.json()).toMatchObject({ id: "C1", result: "fail", note: "Found nothing." });
    expect((await get<ChatState>(`/api/chats/${id}`)).review?.cards[0]).toMatchObject({ id: "C1", result: "fail", note: "Found nothing." });
    expect(published).toContainEqual({ type: "chat", id });
    // A note is optional.
    expect((await post(`/api/chats/${id}/cards/C1/result`, { result: "pass" })).status).toBe(200);
    expect((await post(`/api/chats/${id}/cards/C9/result`, { result: "pass", note: "" })).status).toBe(404);
    expect((await post(`/api/chats/${id}/cards/C1/result`, { result: "maybe" })).status).toBe(400);
    expect((await post(`/api/chats/${id}/cards/C1/result`, {})).status).toBe(400);
  });
});

describe("plan check", () => {
  test("GET gives the problems of the validator", async () => {
    addDemo();
    const { id, dir, state } = await sampleChat("Check");
    const got = await get<{ problems: unknown[] }>(`/api/chats/${id}/plan/check`);
    expect(got.problems).toEqual(validatePlan(dir, { adrDir: join(state.chat.worktree ?? "", "docs", "adr") }));
    expect(got.problems.length).toBeGreaterThan(0);
    rmSync(join(dir, "ACCEPTANCE.md"));
    const next = await get<{ problems: { file: string; code: string }[] }>(`/api/chats/${id}/plan/check`);
    expect(next.problems.some((p) => p.file === "ACCEPTANCE.md" && p.code === "missing-file")).toBe(true);
  });

  test("a chat with no feature folder is 404 and an unknown chat is 404", async () => {
    const bare = createChat({ title: "Bare" });
    expect((await api(`/api/chats/${bare.id}/plan/check`)).status).toBe(404);
    expect((await api("/api/chats/nope/plan/check")).status).toBe(404);
  });
});

describe("files the engine writes", () => {
  test("the run files of a new chat stay out of git status of its worktree", async () => {
    addDemo();
    const s = await newChat("Ignored");
    await post(`/api/chats/${s.chat.id}/notes`, { to: "orchestrator", said: "a", note: "b" });
    const out = Bun.spawnSync(["git", "-C", s.chat.worktree ?? "", "status", "--porcelain"], { stdout: "pipe" }).stdout.toString();
    expect(out).toBe("");
    expect(readdirSync(join(s.chat.featureDir ?? "", "run"))).toContain("handoffs.md");
  });
});

describe("the engine's parts behind the routes", () => {
  /** Only the calls the routes make. The parts themselves are tested in their own files and in engine.test.ts. */
  const calls: string[] = [];
  const agent: AgentView = { id: "worker-a", name: "worker-a", role: "worker", tool: "codex", model: "m", tmux: "sst-x", status: "needsYou", task: "T001", prompts: [], history: [] };
  const queued: QueueItem = { id: "j1", chat: "", task: "T001", command: "true", state: "running" };
  let engine: Engine;
  let live: EngineServer;
  let who: { chat: string };

  beforeEach(() => {
    calls.length = 0;
    who = { chat: "" };
    // The stub is cast: it has the members that the routes under test use and nothing else.
    engine = {
      agentViews: () => [agent],
      queueItems: () => [{ ...queued, chat: who.chat }],
      notes: {
        recorded: async (c: string, n: number) => void calls.push(`recorded ${c} ${n}`),
        ack: (c: string, n: number[]) => void calls.push(`ack ${c} ${n.join(",")}`),
        undo: () => "Being read",
      },
      questions: {
        asked: (c: string, q: { n: number; task: string; agent: string; text: string }) => void calls.push(`asked ${c} Q${q.n} ${q.task} ${q.agent} ${q.text}`),
        answered: async (c: string, q: { n: number; task: string; text: string }) => void calls.push(`answered ${c} Q${q.n} ${q.task} ${q.text}`),
      },
      usage: { state: () => ({ tools: [], moves: [], switchOn: false, thresholdPct: 77 }) },
      sessions: { applyNow: (c: string) => void calls.push(`apply ${c}`) },
      setStage: async () => {
        throw new Refused("The plan is not valid", 409, { problems: [{ file: "PLAN.md", line: null, code: "x", text: "y" }] });
      },
      halt: async () => {
        throw new Refused("nothing to halt");
      },
    } as unknown as Engine;
    live = startServer({ routes: routes({ publish: () => {}, engine }), portFrom: randomPort() });
  });
  afterEach(() => live.stop());

  const call = (path: string, init: RequestInit = {}) => {
    const headers = new Headers(init.headers);
    headers.set("authorization", `Bearer ${live.info.token}`);
    if (init.body) headers.set("content-type", "application/json");
    return fetch(`${live.url}${path}`, { ...init, headers });
  };
  const send = (path: string, body?: unknown) => call(path, { method: "POST", ...(body === undefined ? {} : { body: JSON.stringify(body) }) });

  test("a note to the orchestrator is handed to the delivery, and a note to anything else is not", async () => {
    addDemo();
    const s = await newChat("Parts");
    who.chat = s.chat.id;
    await send(`/api/chats/${s.chat.id}/notes`, { to: "orchestrator", said: "a", note: "One." });
    await send(`/api/chats/${s.chat.id}/notes`, { to: "plan", said: "a", note: "Two." });
    expect(calls).toEqual([`recorded ${s.chat.id} 1`]);
    // The engine's own `ack` and `undo` answers: a note that is being read is a 409.
    expect(await (await send(`/api/chats/${s.chat.id}/notes/ack`, { numbers: [1, "N2"] })).json()).toMatchObject({ ok: true, numbers: [1, 2] });
    expect(calls).toContain(`ack ${s.chat.id} 1,2`);
    const undo = await send(`/api/chats/${s.chat.id}/notes/1/undo`);
    expect(undo.status).toBe(409);
    expect(await undo.json()).toEqual({ error: "Being read" });
  });

  test("a question parks its task, and its answer goes to the worker", async () => {
    addDemo();
    const s = await newChat("Parts q");
    who.chat = s.chat.id;
    await send(`/api/chats/${s.chat.id}/questions`, { task: "T001", text: "Which?", agent: "worker-a" });
    await send(`/api/chats/${s.chat.id}/questions/Q1/answer`, { text: "This one." });
    expect(calls).toEqual([`asked ${s.chat.id} Q1 T001 worker-a Which?`, `answered ${s.chat.id} Q1 T001 This one.`]);
  });

  test("the chat state and the chat list show the live agents and the queue", async () => {
    addDemo();
    const s = await newChat("Parts s");
    who.chat = s.chat.id;
    const state = (await (await call(`/api/chats/${s.chat.id}`)).json()) as ChatState;
    expect(state.agents).toMatchObject([{ id: "worker-a", status: "needsYou", task: "T001", tool: "codex", tmux: "sst-x" }]);
    expect(state.queue).toMatchObject([{ id: "j1", task: "T001", state: "running" }]);
    expect(state.needs).toMatchObject([{ kind: "permission", agent: "worker-a", task: "T001" }]);
    const list = (await (await call("/api/chats")).json()) as ChatSummary[];
    expect(list.find((c) => c.id === s.chat.id)?.needsYou).toBe(1);
  });

  test("a refusal of the engine is the status it names; the plan's problems come with a 409", async () => {
    addDemo();
    const s = await newChat("Parts r");
    const stage = await send(`/api/chats/${s.chat.id}/stage`, { stage: "build" });
    expect(stage.status).toBe(409);
    expect(await stage.json()).toMatchObject({ error: "The plan is not valid", problems: [{ file: "PLAN.md" }] });
    const halt = await send(`/api/chats/${s.chat.id}/halt`);
    expect(halt.status).toBe(409);
    expect(await halt.json()).toEqual({ error: "nothing to halt" });
    expect(await (await call("/api/usage")).json()).toMatchObject({ thresholdPct: 77 });
    expect((await send("/api/hook", { chat: s.chat.id })).status).toBe(200);
    expect(calls).toContain(`apply ${s.chat.id}`);
  });

  test("without an engine the routes that need one do not exist", async () => {
    addDemo();
    const s = await newChat("Parts none");
    for (const path of [`/api/chats/${s.chat.id}/halt`, `/api/chats/${s.chat.id}/stage`, `/api/chats/${s.chat.id}/check`, "/api/hook"]) {
      expect((await post(path, {})).status).toBe(404);
    }
    expect((await api("/api/usage")).status).toBe(404);
  });
});

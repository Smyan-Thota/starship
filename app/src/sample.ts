/**
 * Hand-written sample data, built from fixtures/recipe-search/.
 * Tests render the window with it. main.tsx renders live data (data.ts).
 */
import type { AgentView, ChatState, ChatSummary, FileBody, FileInfo, MapFile, PhaseView, PromptVersion, RepoInfo, TaskState, TaskView, UsageState } from "../../engine/src/types.ts";
import type { SettingsConfig } from "./pages/Settings.tsx";

const MTIME = Date.UTC(2026, 10, 11, 15, 9);

interface Row {
  id: string;
  text: string;
  files: string[];
  verify: string;
  trace: string;
  done?: boolean;
  parallel?: boolean;
  state?: TaskState;
  agent?: string;
  attempts?: number;
}

function task(phase: number, r: Row): TaskView {
  return {
    id: r.id,
    phase,
    parallel: r.parallel ?? false,
    text: r.text,
    files: r.files,
    verify: r.verify,
    verifyNote: "",
    trace: r.trace,
    done: r.done ?? false,
    state: r.state ?? (r.done ? "verified" : "queued"),
    agent: r.agent ?? null,
    attempts: r.attempts ?? 0,
  };
}

const SERVICE = "api/src/services/RecipeSearchService.ts";
const SEARCH_TEST = "vitest run src/services/RecipeSearchService.search.test.ts";
const RESULTS = "app/src/pages/Cookbook/Results.tsx";
const RESULTS_TEST = "vitest run src/pages/Cookbook/Results.test.tsx";
const BOX = "app/src/pages/Cookbook/SearchBox.tsx";
const BOX_TEST = "vitest run src/pages/Cookbook/SearchBox.test.tsx";

const phases: PhaseView[] = [
  {
    n: 0,
    title: "Foundation",
    tasks: [
      task(0, { id: "T001", text: "Trigram index migration", files: ["db/migrations/recipes_trgm_index.sql"], verify: "yarn workspace db exec prisma migrate status", trace: "plan: Design rules", done: true, attempts: 1 }),
      task(0, { id: "T002", text: "`searchRecipes` resolver that returns an empty list", files: [SERVICE], verify: `${SEARCH_TEST} -t empty`, trace: "plan: Interfaces", done: true, attempts: 1 }),
      task(0, { id: "T003", text: "Shared types `SearchError` and the result shape", files: ["api/src/services/recipeSearch.types.ts"], verify: "vitest run src/services/recipeSearch.types.test.ts", trace: "plan: Interfaces", done: true, attempts: 1 }),
    ],
    checkpoint: { text: "the resolver answers", command: "vitest run src/services" },
  },
  {
    n: 1,
    title: "Search",
    tasks: [
      task(1, { id: "T010", text: "Search by name", files: [SERVICE], verify: `${SEARCH_TEST} -t name`, trace: "in scope #1", done: true, attempts: 1 }),
      task(1, { id: "T011", text: "Search by number", files: [SERVICE], verify: `${SEARCH_TEST} -t number`, trace: "in scope #1", done: true, attempts: 1 }),
      task(1, { id: "T012", text: "State filter", files: [SERVICE], verify: `${SEARCH_TEST} -t state`, trace: "in scope #2", done: true, attempts: 1 }),
      task(1, { id: "T013", text: "Paging", files: [SERVICE], verify: `${SEARCH_TEST} -t page`, trace: "plan: Errors and edges", done: true, attempts: 1 }),
    ],
    checkpoint: { text: "", command: SEARCH_TEST },
  },
  {
    n: 2,
    title: "Screen",
    tasks: [
      task(2, { id: "T020", text: "Search box", files: [BOX], verify: BOX_TEST, trace: "in scope #1", done: true, attempts: 1 }),
      task(2, { id: "T021", text: "Results list", files: [RESULTS], verify: `${RESULTS_TEST} -t list`, trace: "in scope #1", done: true, attempts: 1 }),
      task(2, { id: "T022", text: "Numbers match with or without the dash", files: [SERVICE], verify: `${SEARCH_TEST} -t dash`, trace: "note 3", parallel: true, state: "working", agent: "worker-a", attempts: 1 }),
      task(2, { id: "T023", text: "Empty and no-match states", files: [RESULTS], verify: `${RESULTS_TEST} -t states`, trace: "in scope #3", parallel: true, state: "checking", agent: "worker-b", attempts: 1 }),
      task(2, { id: "T024", text: "Keyboard support", files: [BOX], verify: `${BOX_TEST} -t keyboard`, trace: "in scope #1" }),
    ],
    checkpoint: { text: "the page searches", command: "vitest run src/pages/Cookbook" },
  },
  {
    n: 3,
    title: "Errors",
    tasks: [
      task(3, { id: "T030", text: "API error state", files: [RESULTS], verify: `${RESULTS_TEST} -t error`, trace: "plan: Errors and edges" }),
      task(3, { id: "T031", text: "Archived recipes", files: [SERVICE], verify: `${SEARCH_TEST} -t archived`, trace: "plan: Errors and edges", state: "blocked" }),
      task(3, { id: "T032", text: "One request per 250 ms", files: [BOX], verify: `${BOX_TEST} -t wait`, trace: "note 1" }),
      task(3, { id: "T033", text: "Short-query hint", files: [RESULTS], verify: `${RESULTS_TEST} -t short`, trace: "plan: Errors and edges" }),
    ],
    checkpoint: { text: "", command: "vitest run src/pages/Cookbook src/services" },
  },
  {
    n: 4,
    title: "Rollout",
    tasks: [
      task(4, { id: "T040", text: "Update the architecture doc", files: ["docs/ARCHITECTURE.md"], verify: "grep -q searchRecipes docs/ARCHITECTURE.md", trace: "AGENTS.md: Documentation rules" }),
      task(4, { id: "T041", text: "Write 6 story cards", files: ["docs/features/recipe-search/run/review/story-cards.md"], verify: "six cards with acceptance criteria", trace: "acceptance: Story cards" }),
      task(4, { id: "T042", text: "Run acceptance", files: ["docs/features/recipe-search/ACCEPTANCE.md"], verify: "each item checked", trace: "acceptance: all" }),
      task(4, { id: "T043", text: "Hand off for PR review", files: ["docs/features/recipe-search/run/progress.md"], verify: "the owner says go", trace: "spec: Scope" }),
    ],
    checkpoint: null,
  },
];

function file(path: string, size: number, extra: Partial<FileInfo> = {}): FileInfo {
  return { path, kind: path.startsWith("run/") ? "run" : "plan", size, mtimeMs: MTIME, binary: false, tooLarge: false, html: path.endsWith(".html"), ...extra };
}

const files: FileInfo[] = [
  file("ACCEPTANCE.md", 499),
  file("PLAN.md", 1308),
  file("SPEC.md", 322),
  file("TASKS.md", 4371),
  file("run/handoffs.md", 513),
  file("run/progress.md", 296),
  file("run/prompts/worker-a-T022-v1.md", 298),
  file("run/questions.md", 96),
  file("run/state.json", 232),
  file("wireframes/links.json", 68),
  file("wireframes/search.html", 159),
];

/** A prompt version whose `text` is its lines, as the engine writes it. */
function prompt(v: number, at: string, file: string, lines: PromptVersion["lines"]): PromptVersion {
  return { v, at, file, text: lines.map((l) => l.text).join("\n"), lines };
}

const agents: AgentView[] = [
  {
    id: "admin",
    name: "Admin",
    role: "admin",
    tool: "claude",
    model: "Claude Opus 5.5",
    tmux: "ss-recipe-search-admin",
    status: "idle",
    task: null,
    prompts: [prompt(1, "14:18", "run/prompts/admin-v1.md", [{ text: "You are the admin agent for docs/features/recipe-search/." }, { text: "Turn each instruction into one note." }])],
    history: [{ at: "14:18", text: "Started" }],
  },
  {
    id: "orchestrator",
    name: "Orchestrator",
    role: "orchestrator",
    tool: "claude",
    model: "Claude Opus 5.5",
    tmux: "ss-recipe-search-orchestrator",
    status: "working",
    task: null,
    prompts: [prompt(1, "15:00", "run/prompts/orchestrator-v1.md", [
          { text: "You are the orchestrator for docs/features/recipe-search/." },
          { text: "Read PLAN.md, TASKS.md and ACCEPTANCE.md before each task." },
          { text: "Run one phase at a time. Give each worker one task and its verify command." },
          { text: "Read handoffs.md at each task boundary." },
        ])],
    history: [
      { at: "15:00", text: "Started" },
      { at: "15:04", text: "T021 verified" },
      { at: "15:04", text: "T022 to worker-a, T023 to worker-b" },
      { at: "15:06", text: "Read note 3" },
    ],
  },
  {
    id: "worker-a",
    name: "Worker A",
    role: "worker",
    tool: "codex",
    model: "Codex",
    tmux: "ss-recipe-search-worker-a",
    status: "working",
    task: "T022",
    prompts: [prompt(1, "15:06", "run/prompts/worker-a-T022-v1.md", [
          { text: "Implement T022 only: recipe numbers match with or without the dash." },
          { text: "Files: api/src/services/RecipeSearchService.ts" },
          { text: "Verify: vitest run src/services/RecipeSearchService.search.test.ts -t dash" },
          { text: "R111 and R-111 return the same recipes (note 3).", note: 3 },
          { text: "Do not start T023 or later." },
          { text: "Ask the run queue for typecheck." },
        ])],
    history: [
      { at: "15:02", text: "Moved to Codex" },
      { at: "15:06", text: "Started T022" },
    ],
  },
  {
    id: "worker-b",
    name: "Worker B",
    role: "worker",
    tool: "claude",
    model: "Claude Sonnet 5.5",
    tmux: "ss-recipe-search-worker-b",
    status: "idle",
    task: "T023",
    prompts: [prompt(1, "15:04", "run/prompts/worker-b-T023-v1.md", [
          { text: "Implement T023 only: empty and no-match states." },
          { text: "Files: app/src/pages/Cookbook/Results.tsx" },
          { text: "Verify: vitest run src/pages/Cookbook/Results.test.tsx -t states" },
          { text: "Do not start T024 or later." },
        ])],
    history: [
      { at: "15:04", text: "Started T023" },
      { at: "15:08", text: "Check queued" },
      { at: "15:09", text: "Asked about archived recipes" },
    ],
  },
  {
    id: "reviewer-1",
    name: "Reviewer 1",
    role: "reviewer",
    tool: "codex",
    model: "Codex",
    tmux: "ss-recipe-search-reviewer-1",
    status: "stopped",
    task: null,
    prompts: [],
    history: [],
  },
  {
    id: "card-runner",
    name: "Card runner",
    role: "cardRunner",
    tool: "codex",
    model: "luna",
    tmux: "ss-recipe-search-card-runner",
    status: "stopped",
    task: null,
    prompts: [],
    history: [],
  },
];

export const sampleState: ChatState = {
  chat: {
    id: "recipe-search",
    title: "Recipe search",
    repo: "acme",
    stage: "build",
    halted: null,
    needsYou: 1,
    slug: "recipe-search",
    worktree: "/home/owner/.starship/worktrees/acme/recipe-search",
    branch: "starship/recipe-search",
    featureDir: "/home/owner/.starship/worktrees/acme/recipe-search/docs/features/recipe-search",
    createdAt: "2026-11-11T14:18:00.000Z",
  },
  build: { status: "running", reason: null, outside: [], dropped: [], lastFixSent: 0 },
  needs: [{ kind: "question", text: "Include archived recipes in results?", agent: "worker-b", task: "T023" }],
  plan: {
    problems: [],
    lines: [
      { label: "Goal", value: "Cooks find a recipe by name or number in under 5 seconds.", file: "PLAN.md", heading: "Goal" },
      { label: "In scope", value: "Search by name and number, cuisine filter, empty and error states", file: "SPEC.md", heading: "Scope" },
    ],
  },
  review: {
    findings: [
      { n: 1, sev: "high", reviewer: "reviewer-1", where: "api/src/services/RecipeSearchService.ts:41", text: "The search term goes into the query unescaped.", status: "open", dispute: null },
      { n: 2, sev: "low", reviewer: "reviewer-1", where: "SPEC.md:12", text: "The spec names no page size.", status: "disputed", dispute: { reviewer: "reviewer-2", why: "The plan sets it to 25." } },
    ],
    none: ["reviewer-2"],
    cards: [{ id: "S1", title: "Find a recipe by number", description: "Search R-111.", criteria: ["R-111 and R111 return the same recipe"], result: "pass", note: "" }],
    fixes: [{ n: 1, text: "Escape the search term", from: "F1" }],
  },
  folderMissing: false,
  tasks: { phases, verified: 9, total: 20 },
  tasksError: null,
  notes: [
    { n: 1, at: "2026-11-11 14:31", stage: "plan", to: "plan", said: "one request per 250ms, not every keystroke", note: "Typing fast: one request per 250 ms.", status: "read", readAt: "14:31", line: 3 },
    { n: 2, at: "2026-11-11 14:40", stage: "plan", to: "plan", said: "what if the api is down", note: 'API error: "Search is unavailable. Try again."', status: "read", readAt: "14:40", line: 8 },
    { n: 3, at: "2026-11-11 15:05", stage: "build", to: "orchestrator", said: "match recipe numbers without the dash too", note: "Match recipe numbers with or without the dash (R111 = R-111). T022.", status: "read", readAt: "15:06", line: 13 },
  ],
  unreadableNotes: [],
  questions: [{ n: 1, at: "15:09", agent: "worker-b", task: "T023", question: "Include archived recipes in results?", status: "open", line: 3 }],
  files,
  wireframes: [{ name: "search", path: "wireframes/search.html", url: "https://example.com/wireframes/search" }],
  messages: [
    { id: "m1", who: "you", at: "14:30", stage: "plan", text: "one request per 250ms, not every keystroke", state: "answered" },
    { id: "m2", who: "admin", at: "14:31", stage: "plan", text: "Added.", note: 1 },
    { id: "m3", who: "you", at: "14:39", stage: "plan", text: "what if the api is down", state: "answered" },
    { id: "m4", who: "admin", at: "14:40", stage: "plan", text: "Added.", note: 2 },
    { id: "m5", who: "system", at: "15:02", stage: "build", text: "Claude at 90%. Worker A moved to Codex." },
    { id: "m6", who: "you", at: "15:05", stage: "build", text: "match recipe numbers without the dash too", state: "answered" },
    { id: "m7", who: "admin", at: "15:05", stage: "build", text: "", note: 3 },
    { id: "m8", who: "admin", at: "15:09", stage: "build", text: "Worker B asks: include archived recipes in results?" },
  ],
  agents,
  queue: [{ id: "q1", chat: "recipe-search", task: "T023", command: `${RESULTS_TEST} -t states`, state: "running" }],
  events: [
    { at: "15:09", text: "Worker B asked about archived recipes" },
    { at: "15:08", text: "T023 check queued" },
    { at: "15:06", text: "Note 3 read by the orchestrator" },
    { at: "15:04", text: "T021 verified" },
    { at: "15:02", text: "Claude at 90%. Worker A moved to Codex." },
  ],
  handEdits: [],
};

export const sampleChats: ChatSummary[] = [
  { id: "recipe-search", title: "Recipe search", repo: "acme", stage: "build", halted: null, needsYou: 1 },
  { id: "login-page", title: "Login page", repo: "acme", stage: "plan", halted: null, needsYou: 2 },
  { id: "roster-cleanup", title: "Roster cleanup", repo: "acme", stage: "review", halted: null, needsYou: 0 },
  { id: "release-notes", title: "Release notes", repo: null, stage: null, halted: null, needsYou: 0 },
];

/** Text of the sample files, close to fixtures/recipe-search/. */
const texts: Record<string, string> = {
  "SPEC.md": [
    "# SPEC — Recipe search",
    "",
    "## Problem",
    "",
    "Cooks scroll the whole cookbook to find one recipe.",
    "",
    "## Scope",
    "",
    "1. Search by recipe name and number.",
    "2. Filter by cuisine.",
    "3. Empty, no-match and error states.",
    "",
    "## Deferred",
    "",
    "- Search inside PDF text",
    "- Saved searches",
    "",
    "## Success measure",
    "",
    "A cook finds R-111 in under 5 seconds.",
  ].join("\n"),
  "PLAN.md": [
    "# PLAN — Recipe search",
    "",
    "Status: Accepted 14:52",
    "",
    "## Goal",
    "",
    "Cooks find a recipe by name or number in under 5 seconds.",
    "",
    "## Design rules",
    "",
    "- Search runs in `RecipeSearchService`. The screen holds no search logic.",
    "- One index migration. No new table.",
    "",
    "## Error and edge behavior",
    "",
    "| Condition | Result |",
    "| --- | --- |",
    "| No match | \"No recipes match.\" |",
    "| R111 or R-111 | Same results |",
    "| Archived recipes | Open question |",
  ].join("\n"),
  "ACCEPTANCE.md": [
    "# Acceptance — Recipe search",
    "",
    "## Behavior",
    "",
    '- "R-111" and "R111" return the same recipe.',
    "- The cuisine filter narrows the results.",
    "",
    "## Errors",
    "",
    '- No match: "No recipes match."',
    '- API error: "Search is unavailable. Try again."',
  ].join("\n"),
  "run/questions.md": ["# Questions", "", "## Q1 · 15:09 · worker-b · T023", "Include archived recipes in results?", "Status: open"].join("\n"),
  "run/state.json": JSON.stringify({ tasks: { T022: { state: "working", agent: "worker-a", attempts: 1 } } }, null, 2),
};

function tasksText(): string {
  const out = ["# TASKS — Recipe search", ""];
  for (const p of phases) {
    out.push(`## Phase ${p.n} — ${p.title}`, "");
    for (const t of p.tasks) out.push(`- [${t.done ? "x" : " "}] ${t.id}${t.parallel ? " [P]" : ""} ${t.text}`);
    out.push("");
  }
  return out.join("\n");
}

export function sampleLoadFile(path: string): Promise<FileBody> {
  const info = files.find((f) => f.path === path);
  if (!info) return Promise.reject(new Error(`No file: ${path}`));
  if (info.html) return Promise.resolve({ info, text: null, open: true });
  const text = path === "TASKS.md" ? tasksText() : (texts[path] ?? `# ${path}`);
  return Promise.resolve({ info, text, open: false });
}

/** A file of the worktree that is not a plan file. */
export function sampleLoadCode(path: string): Promise<FileBody> {
  if (path !== "api/src/services/RecipeSearchService.ts") return Promise.reject(new Error(`No such file: ${path}`));
  const info: FileInfo = { path, kind: "plan", size: 96, mtimeMs: 0, binary: false, tooLarge: false, html: false };
  const text = "export function search(query: string) {\n  return recipes.filter((r) => r.number.includes(query));\n}\n";
  return Promise.resolve({ info, text, open: false });
}

export const sampleRepos: RepoInfo[] = [
  { name: "acme", path: "/home/owner/acme", baseBranch: "main", hasMap: true },
  { name: "starship", path: "/home/owner/starship", baseBranch: "main", hasMap: false },
];

export const sampleConfig: SettingsConfig = {
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
};

export const sampleUsage: UsageState = {
  tools: [
    { tool: "claude", windows: [{ window: "5 hour", usedPct: 91, resetsAt: "2026-11-11T18:00:00.000Z", expired: false }, { window: "7 day", usedPct: 73, resetsAt: "2026-11-15T09:00:00.000Z", expired: false }], updatedAt: "2026-11-11T15:00:00.000Z", stale: false },
    { tool: "codex", windows: [{ window: "5 hour", usedPct: 12, resetsAt: null, expired: false }], updatedAt: "2026-11-11T15:00:00.000Z", stale: false },
  ],
  moves: [{ at: "15:02", chat: "recipe-search", agent: "worker-a", from: "claude", to: "codex" }],
  switchOn: true,
  thresholdPct: 90,
};

/** The map of the sample repo: two layers, three boxes, one pipe, the overview and the overlay of this plan. */
export const sampleMap: MapFile = {
  name: "acme",
  layers: [
    ["Screens", "where cooks work"],
    ["Services", "the API and its stores"],
  ],
  boxes: [
    { id: "app", layer: 0, row: 0, left: 0.04, right: 0.96, name: "Cookbook app", what: "The screens cooks use.", dir: "app/src", chips: ["Cookbook", "Results"] },
    { id: "api", layer: 1, row: 1, left: 0.04, right: 0.45, name: "Recipe API", what: "Answers the screens.", dir: "api/src", chips: ["RecipeSearchService"] },
    { id: "db", layer: 1, row: 1, left: 0.55, right: 0.96, name: "Database", what: "Keeps the recipes.", dir: "db", chips: ["#recipes"], store: true },
  ],
  pipes: [{ id: "app-api", from: "app", to: "api", kind: "call", label: "search recipes", route: { x: 0.2 } }],
  flows: {
    overview: { name: "Overview" },
    plan: { name: "This plan", story: "Cooks search the cookbook.", lit: { app: ["Results"], api: ["RecipeSearchService"] }, marks: { "api|RecipeSearchService": "changed" } },
  },
  order: ["overview", "plan"],
};

import "./setup.ts";
import { afterEach, describe, expect, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatState } from "../../engine/src/types.ts";
import { buildData, planData, promptVersions, reviewData, usageData } from "../src/adapters.ts";
import { App } from "../src/App.tsx";
import { sampleMap, sampleState, sampleUsage } from "../src/sample.ts";
import { appProps, fakeActions, noRepoState, withState } from "./fake.ts";

afterEach(cleanup);

async function settle() {
  await act(async () => {});
}

const stages = () => within(document.querySelector('nav[aria-label="Stages"]') as HTMLElement);
const docs = () => within(document.querySelector('nav[aria-label="Documents"]') as HTMLElement);
const doc = () => within(document.querySelector("main.doc") as HTMLElement);
const side = () => within(document.querySelector("aside.side") as HTMLElement);
const topBar = () => within(document.querySelector("header.top") as HTMLElement);
const chatPane = () => within(document.querySelector("section.chat") as HTMLElement);

function mount(state: ChatState | null = sampleState, actions = fakeActions()) {
  const view = render(<App {...appProps(state, actions)} />);
  return { view, actions };
}

describe("tabs", () => {
  test("the chat opens on its own stage, and that stage is marked", async () => {
    mount();
    await settle();
    expect(doc().getByRole("heading", { name: "Build" })).toBeTruthy();
    expect(stages().getByRole("button", { name: "Build" }).getAttribute("aria-current")).toBe("true");
    const own = Array.from(document.querySelectorAll('nav[aria-label="Stages"] [data-own="true"]')).map((b) => b.textContent);
    expect(own).toEqual(["Build"]);
  });

  test("each tab shows its page, and any stage opens at any time", async () => {
    const { actions } = mount();
    await settle();

    fireEvent.click(stages().getByRole("button", { name: "Map" }));
    await settle();
    expect(actions.loadMap).toHaveBeenCalledWith("acme", "recipe-search");
    expect(doc().getByText("Cookbook app")).toBeTruthy();
    expect(doc().getByText("Recipe API")).toBeTruthy();
    expect(stages().getByRole("button", { name: "Map" }).getAttribute("aria-current")).toBe("true");
    // The mark stays on the chat's own stage.
    expect(document.querySelector('nav[aria-label="Stages"] [data-own="true"]')?.textContent).toBe("Build");

    fireEvent.click(stages().getByRole("button", { name: "Plan" }));
    expect(doc().getByRole("heading", { name: "Recipe search" })).toBeTruthy();
    expect(doc().getByText("Cooks find a recipe by name or number in under 5 seconds.")).toBeTruthy();
    expect(doc().getByRole("button", { name: "Start build" })).toBeTruthy();

    fireEvent.click(stages().getByRole("button", { name: "Build" }));
    expect(doc().getByRole("heading", { name: "Build" })).toBeTruthy();
    expect(doc().getByText("Running")).toBeTruthy();

    fireEvent.click(stages().getByRole("button", { name: "Review" }));
    expect(doc().getByRole("heading", { name: "Review" })).toBeTruthy();
    expect(doc().getByText("The search term goes into the query unescaped.")).toBeTruthy();

    fireEvent.click(docs().getByRole("button", { name: "Tasks" }));
    expect(doc().getByRole("heading", { name: "Tasks" })).toBeTruthy();
    expect(doc().getByText("9 / 20")).toBeTruthy();

    fireEvent.click(docs().getByRole("button", { name: "Files" }));
    expect(doc().getByRole("heading", { name: "Files" })).toBeTruthy();
    expect(document.querySelector('[data-path="SPEC.md"]')).not.toBeNull();
  });

  test("a chat with no repo shows no stage tabs and no page, only the conversation", async () => {
    mount(noRepoState());
    await settle();
    expect(document.querySelector('nav[aria-label="Stages"]')).toBeNull();
    expect(document.querySelector('nav[aria-label="Documents"]')).toBeNull();
    expect(document.querySelector("main.doc")).toBeNull();
    expect(document.querySelector("section.chat")).not.toBeNull();
    expect(topBar().getByText("Release notes")).toBeTruthy();
  });
});

describe("the left bar", () => {
  test("each chat has its status dot and its needs-you count; the usage bars sit at the bottom", async () => {
    mount();
    await settle();
    const recipeChat = document.querySelector('[data-chat="recipe-search"]') as HTMLElement;
    expect(document.querySelector('[data-needs="recipe-search"].cnt')?.textContent).toBe("1");
    expect(recipeChat.querySelector(".dot.wait")).not.toBeNull();
    expect((document.querySelector('[data-needs="login-page"].cnt') as HTMLElement).textContent).toBe("2");
    expect(document.querySelector('[data-needs="roster-cleanup"]')).toBeNull();
    const bars = document.querySelector("aside.side .side-use .us") as HTMLElement;
    expect(bars).not.toBeNull();
    // The sidebar's last element is the usage block.
    expect(document.querySelector("aside.side")?.lastElementChild?.className).toBe("side-use");
    const claude = bars.querySelector('[data-bar="claude|5 hour"]') as HTMLElement;
    expect(claude.textContent).toContain("91%");
    expect(bars.textContent).toContain("worker-a claude → codex");
  });

  test("a click on a chat selects it", async () => {
    const { actions } = mount();
    await settle();
    fireEvent.click(document.querySelector('[data-chat="login-page"]') as HTMLElement);
    expect(actions.selectChat).toHaveBeenCalledWith("login-page");
  });

  test("the usage controls call the store with the new value", async () => {
    const { actions } = mount();
    await settle();
    fireEvent.click(side().getByLabelText("Switch"));
    expect(actions.setSwitch).toHaveBeenCalledWith(false);
    fireEvent.change(side().getByLabelText("Threshold %"), { target: { value: "80" } });
    expect(actions.setThreshold).toHaveBeenCalledWith(80);
  });
});

describe("New chat and Settings", () => {
  test("New chat opens the form with the repos; Create sends the input and a refusal shows", async () => {
    const actions = fakeActions({ createChat: () => Promise.resolve("Title taken") });
    mount(sampleState, actions);
    await settle();
    fireEvent.click(side().getByText(/New chat/));
    await settle();
    expect(doc().getByRole("heading", { name: "New chat" })).toBeTruthy();
    const repo = screen.getByLabelText("Repo") as HTMLSelectElement;
    expect(Array.from(repo.options).map((o) => o.value)).toEqual(["", "acme", "starship"]);
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Recipe export" } });
    fireEvent.change(repo, { target: { value: "acme" } });
    fireEvent.change(screen.getByLabelText("Feature folder"), { target: { value: "recipe-export" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await settle();
    expect(actions.createChat).toHaveBeenCalledWith({ title: "Recipe export", repo: "acme", feature: "recipe-export" });
    expect(screen.getByRole("alert").textContent).toBe("Title taken");
    // The form stays open on a refusal.
    expect(screen.getByLabelText("Title")).toBeTruthy();
  });

  test("a created chat closes the form; Cancel closes it too; Add repo sends the path", async () => {
    const actions = fakeActions();
    mount(sampleState, actions);
    await settle();
    fireEvent.click(side().getByText(/New chat/));
    fireEvent.change(screen.getByLabelText("Repo path"), { target: { value: "/home/o/new-repo" } });
    fireEvent.click(screen.getByRole("button", { name: "Add repo" }));
    await settle();
    expect(actions.addRepo).toHaveBeenCalledWith("/home/o/new-repo");
    fireEvent.change(screen.getByLabelText("Title"), { target: { value: "Plain" } });
    fireEvent.click(screen.getByRole("button", { name: "Create" }));
    await settle();
    expect(actions.createChat).toHaveBeenCalledWith({ title: "Plain", repo: null, feature: null });
    expect(screen.queryByLabelText("Title")).toBeNull();
    expect(stages().getByRole("button", { name: "Build" })).toBeTruthy();

    fireEvent.click(side().getByText(/New chat/));
    fireEvent.click(screen.getByRole("button", { name: "Cancel" }));
    expect(screen.queryByLabelText("Title")).toBeNull();
  });

  test("Settings opens the page with the config; Save sends the whole config and a refusal shows", async () => {
    const actions = fakeActions({ saveConfig: () => Promise.resolve("workers must be 1 to 3") });
    mount(sampleState, actions);
    await settle();
    fireEvent.click(side().getByRole("button", { name: "Settings" }));
    await settle();
    expect(doc().getByRole("heading", { name: "Settings" })).toBeTruthy();
    expect((screen.getByLabelText("Card runner model") as HTMLInputElement).value).toBe("luna");
    fireEvent.change(screen.getByLabelText("Workers per chat"), { target: { value: "3" } });
    fireEvent.click(screen.getByRole("button", { name: "Save" }));
    await settle();
    expect(actions.saveConfig).toHaveBeenCalledTimes(1);
    const sent = actions.saveConfig.mock.calls[0]?.[0];
    expect(sent?.workers).toBe(3);
    expect(sent?.portFrom).toBe(8787);
    expect(screen.getByRole("alert").textContent).toBe("workers must be 1 to 3");
    // A chat in the list leaves the page.
    fireEvent.click(document.querySelector('[data-chat="recipe-search"]') as HTMLElement);
    expect(screen.queryByRole("heading", { name: "Settings" })).toBeNull();
  });
});

describe("the agent page", () => {
  test("a click on an agent opens its page with the prompt, and the owner's words next to a line from a note", async () => {
    mount();
    await settle();
    fireEvent.click(topBar().getByRole("button", { name: "Worker A" }));
    expect(doc().getByRole("heading", { name: "Worker A" })).toBeTruthy();
    expect(doc().getByText("T022")).toBeTruthy();
    const mine = document.querySelector(".ap-line.mine") as HTMLElement;
    expect(mine.textContent).toContain("You: match recipe numbers without the dash too");
    expect(mine.textContent).toContain("R111 and R-111 return the same recipes (note 3).");
  });

  test("Terminal and Pause post to the agent; Resume and Restart show for a paused and a stopped agent", async () => {
    const actions = fakeActions();
    mount(sampleState, actions);
    await settle();
    fireEvent.click(topBar().getByRole("button", { name: "Worker A" }));
    fireEvent.click(doc().getByRole("button", { name: "Terminal" }));
    await settle();
    expect(actions.agent).toHaveBeenLastCalledWith("worker-a", "terminal");
    fireEvent.click(doc().getByRole("button", { name: "Pause" }));
    await settle();
    expect(actions.agent).toHaveBeenLastCalledWith("worker-a", "pause");

    fireEvent.click(topBar().getByRole("button", { name: "Reviewer 1" }));
    fireEvent.click(doc().getByRole("button", { name: "Restart" }));
    await settle();
    expect(actions.agent).toHaveBeenLastCalledWith("reviewer-1", "restart");

    cleanup();
    const paused = withState({ agents: sampleState.agents.map((a) => (a.id === "worker-a" ? { ...a, status: "paused" as const } : a)) });
    const second = fakeActions();
    mount(paused, second);
    await settle();
    fireEvent.click(topBar().getByRole("button", { name: "Worker A" }));
    fireEvent.click(doc().getByRole("button", { name: "Resume" }));
    await settle();
    expect(second.agent).toHaveBeenLastCalledWith("worker-a", "resume");
  });

  test("the Build page and the Review page open an agent page, and their Terminal posts", async () => {
    const actions = fakeActions();
    mount(sampleState, actions);
    await settle();
    const row = document.querySelector('[data-agent="worker-b"].pb-agent') as HTMLElement;
    fireEvent.click(within(row).getByRole("button", { name: "Terminal" }));
    await settle();
    expect(actions.agent).toHaveBeenLastCalledWith("worker-b", "terminal");
    fireEvent.click(row.querySelector(".pb-agent-main") as HTMLElement);
    expect(doc().getByRole("heading", { name: "Worker B" })).toBeTruthy();

    fireEvent.click(stages().getByRole("button", { name: "Review" }));
    const r = document.querySelector('[data-agent="reviewer-1"].rv-agent') as HTMLElement;
    fireEvent.click(within(r).getByRole("button", { name: "Terminal" }));
    await settle();
    expect(actions.agent).toHaveBeenLastCalledWith("reviewer-1", "terminal");
    fireEvent.click(within(r).getByRole("button", { name: "Reviewer 1" }));
    expect(doc().getByRole("heading", { name: "Reviewer 1" })).toBeTruthy();
  });
});

describe("buttons call their action", () => {
  test("Start build posts the stage build; a refusal shows as it is, and the page stays", async () => {
    const actions = fakeActions({ stage: () => Promise.resolve("PLAN.md has 2 problems") });
    mount(withState({ chat: { ...sampleState.chat, stage: "plan" } }), actions);
    await settle();
    fireEvent.click(doc().getByRole("button", { name: "Start build" }));
    await settle();
    expect(actions.stage).toHaveBeenCalledWith("build");
    expect(doc().getByRole("alert").textContent).toBe("PLAN.md has 2 problems");
    expect(doc().getByRole("heading", { name: "Recipe search" })).toBeTruthy();
  });

  test("Start build, when the engine accepts, opens the Build page", async () => {
    const actions = fakeActions();
    mount(withState({ chat: { ...sampleState.chat, stage: "plan" } }), actions);
    await settle();
    fireEvent.click(doc().getByRole("button", { name: "Start build" }));
    await settle();
    expect(doc().getByRole("heading", { name: "Build" })).toBeTruthy();
  });

  test("the Plan page opens a wireframe in the browser through the engine, and a plan file in the window", async () => {
    const actions = fakeActions();
    mount(withState({ chat: { ...sampleState.chat, stage: "plan" } }), actions);
    await settle();
    fireEvent.click(doc().getByRole("button", { name: "search" }));
    await settle();
    expect(actions.openInBrowser).toHaveBeenCalledWith("wireframes/search.html");
    // The wireframe is not in the file list.
    expect(doc().queryByText("wireframes/search.html")).toBeNull();
    fireEvent.click(doc().getByRole("button", { name: "SPEC.md" }));
    await settle();
    expect(actions.loadFile).toHaveBeenCalledWith("SPEC.md");
    expect(doc().getByText(/Search by recipe name and number/)).toBeTruthy();
    expect(document.querySelector("iframe")).toBeNull();
  });

  test("Halt posts halt; Resume posts resume when the chat is halted; a refusal shows at the top", async () => {
    const actions = fakeActions();
    mount(sampleState, actions);
    await settle();
    fireEvent.click(doc().getByRole("button", { name: "Halt" }));
    await settle();
    expect(actions.halt).toHaveBeenCalledTimes(1);
    cleanup();

    const resume = fakeActions({ resume: () => Promise.resolve("Nothing to resume") });
    mount(withState({ chat: { ...sampleState.chat, halted: "15:12" } }), resume);
    await settle();
    expect(doc().getByText("Halted 15:12")).toBeTruthy();
    expect(doc().queryByRole("button", { name: "Halt" })).toBeNull();
    fireEvent.click(doc().getByRole("button", { name: "Resume" }));
    await settle();
    expect(resume.resume).toHaveBeenCalledTimes(1);
    expect(doc().getByRole("alert").textContent).toBe("Nothing to resume");
  });

  test("Tasks on the Build page opens the Tasks page", async () => {
    mount();
    await settle();
    fireEvent.click(doc().getByRole("button", { name: "Tasks" }));
    expect(doc().getByRole("heading", { name: "Tasks" })).toBeTruthy();
  });

  test("Send fixes posts; a refusal shows as it is", async () => {
    const actions = fakeActions({ sendFixes: () => Promise.resolve("Build is running") });
    mount(sampleState, actions);
    await settle();
    fireEvent.click(stages().getByRole("button", { name: "Review" }));
    fireEvent.click(doc().getByRole("button", { name: "Send fixes" }));
    await settle();
    expect(actions.sendFixes).toHaveBeenCalledTimes(1);
    expect(doc().getByRole("alert").textContent).toBe("Build is running");
  });

  test("Start review posts the stage review in a build chat; a refusal shows; a review chat has no such button", async () => {
    const actions = fakeActions({ stage: () => Promise.resolve("11 tasks are not verified") });
    mount(sampleState, actions);
    await settle();
    fireEvent.click(stages().getByRole("button", { name: "Review" }));
    fireEvent.click(doc().getByRole("button", { name: "Start review" }));
    await settle();
    expect(actions.stage).toHaveBeenCalledWith("review");
    expect(screen.getByText("11 tasks are not verified")).toBeTruthy();
    cleanup();
    mount(withState({ chat: { ...sampleState.chat, stage: "review" } }));
    await settle();
    expect(doc().queryByRole("button", { name: "Start review" })).toBeNull();
  });

  test("a finding's place opens the file when it is a plan file", async () => {
    mount();
    await settle();
    fireEvent.click(stages().getByRole("button", { name: "Review" }));
    fireEvent.click(doc().getByRole("button", { name: "SPEC.md:12" }));
    await settle();
    expect(doc().getByText(/Search by recipe name and number/)).toBeTruthy();
    fireEvent.click(stages().getByRole("button", { name: "Review" }));
  });

  test("a finding's place that is not a plan file opens through the code route, as read-only text", async () => {
    const { actions } = mount();
    await settle();
    fireEvent.click(stages().getByRole("button", { name: "Review" }));
    fireEvent.click(doc().getByRole("button", { name: "api/src/services/RecipeSearchService.ts:41" }));
    await settle();
    expect(actions.loadCode).toHaveBeenCalledWith("api/src/services/RecipeSearchService.ts");
    expect(actions.loadFile).not.toHaveBeenCalled();
    expect(doc().queryByText(/Not a plan file/)).toBeNull();
    const pre = document.querySelector("main.doc pre.pre");
    expect(pre?.textContent).toContain("export function search");
    expect(doc().getByText("api/src/services/RecipeSearchService.ts")).toBeTruthy();
    // Read-only text: no editable field in the page.
    expect(document.querySelector("main.doc textarea, main.doc [contenteditable]")).toBeNull();
  });

  test("a code file that the engine cannot read shows the engine's refusal", async () => {
    const actions = fakeActions({ loadCode: () => Promise.reject(new Error("src/gone.ts: no such file")) });
    const review = sampleState.review;
    if (!review) throw new Error("the sample chat has a review");
    mount(withState({ review: { ...review, findings: [{ n: 9, sev: "low", reviewer: "reviewer-1", where: "src/gone.ts:3", text: "x", status: "open", dispute: null }] } }), actions);
    await settle();
    fireEvent.click(stages().getByRole("button", { name: "Review" }));
    fireEvent.click(doc().getByRole("button", { name: "src/gone.ts:3" }));
    await settle();
    expect(doc().getByText("src/gone.ts: no such file")).toBeTruthy();
  });

  test("a chat with no repo opens the admin agent's page beside the conversation, and a second click closes it", async () => {
    const admin = sampleState.agents.find((a) => a.id === "admin");
    expect(admin).toBeTruthy();
    mount(withState({ ...noRepoState(), agents: admin ? [admin] : [] }));
    await settle();
    expect(document.querySelector("main.doc")).toBeNull();
    fireEvent.click(topBar().getByRole("button", { name: /Admin/ }));
    expect(doc().getByRole("heading", { name: /Admin/ })).toBeTruthy();
    expect(doc().getByText("Prompt")).toBeTruthy();
    fireEvent.click(topBar().getByRole("button", { name: /Admin/ }));
    expect(document.querySelector("main.doc")).toBeNull();
  });

  test("Build map posts the repo when there is no map; the errors of the file show; a refusal shows", async () => {
    const actions = fakeActions({
      loadMap: () => Promise.resolve({ map: null, errors: ["map.json: box api has no layer"] }),
      buildMap: () => Promise.resolve("The map is being built"),
    });
    mount(sampleState, actions);
    await settle();
    fireEvent.click(stages().getByRole("button", { name: "Map" }));
    await settle();
    expect(doc().getByText("map.json: box api has no layer")).toBeTruthy();
    fireEvent.click(doc().getByRole("button", { name: "Build map" }));
    await settle();
    expect(actions.buildMap).toHaveBeenCalledWith("acme");
    expect(doc().getByRole("alert").textContent).toBe("The map is being built");
  });

  test("when Build map works, the map is read again", async () => {
    let built = false;
    const actions = fakeActions({
      loadMap: () => Promise.resolve(built ? { map: sampleMap, errors: [] } : { map: null, errors: [] }),
      buildMap: () => {
        built = true;
        return Promise.resolve(null);
      },
    });
    mount(sampleState, actions);
    fireEvent.click(stages().getByRole("button", { name: "Map" }));
    await settle();
    fireEvent.click(doc().getByRole("button", { name: "Build map" }));
    await settle();
    expect(doc().getByText("Cookbook app")).toBeTruthy();
    expect(doc().queryByRole("button", { name: "Build map" })).toBeNull();
  });
});

describe("the conversation", () => {
  test("it shows messages, an open question and the admin status; Send posts the text; the draft is kept", async () => {
    const actions = fakeActions();
    render(<App {...appProps(sampleState, actions, { draft: "half a thought" })} />);
    await settle();
    expect(chatPane().getByText("Include archived recipes in results?")).toBeTruthy();
    expect(chatPane().getByText("idle")).toBeTruthy();
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    expect(input.value).toBe("half a thought");
    fireEvent.change(input, { target: { value: "where is T022?" } });
    expect(actions.setDraft).toHaveBeenLastCalledWith("where is T022?");
    fireEvent.submit(input.closest("form") as HTMLFormElement);
    await settle();
    expect(actions.send).toHaveBeenCalledWith("where is T022?");
  });

  test("a message that was not sent shows Retry, and it posts the retry", async () => {
    const actions = fakeActions();
    const messages = [...sampleState.messages, { id: "m9", who: "you" as const, at: "15:20", stage: "build" as const, text: "again", state: "notSent" as const }];
    mount(withState({ messages }), actions);
    await settle();
    fireEvent.click(chatPane().getByRole("button", { name: "Retry" }));
    await settle();
    expect(actions.retry).toHaveBeenCalledWith("m9");
  });

  test("a queued note has Undo; its refusal shows beside it", async () => {
    const actions = fakeActions({ undo: () => Promise.resolve("Already read") });
    const notes = [...sampleState.notes, { n: 4, at: "2026-11-11 15:12", stage: "build" as const, to: "orchestrator" as const, said: "skip T033", note: "Skip T033.", status: "queued" as const, line: 18 }];
    const messages = [...sampleState.messages, { id: "m10", who: "admin" as const, at: "15:12", stage: "build" as const, text: "Noted.", note: 4 }];
    mount(withState({ notes, messages }), actions);
    await settle();
    fireEvent.click(chatPane().getByRole("button", { name: "Undo" }));
    await settle();
    expect(actions.undo).toHaveBeenCalledWith(4);
    expect(chatPane().getByText("Already read")).toBeTruthy();
  });

  test("Terminal shows when the admin agent needs the owner, and posts to the admin agent", async () => {
    const actions = fakeActions();
    const agents = sampleState.agents.map((a) => (a.id === "admin" ? { ...a, status: "needsYou" as const } : a));
    mount(withState({ agents }), actions);
    await settle();
    // The open question of worker-b has its own Terminal in the pane. The admin line is the one with the words.
    fireEvent.click(within(chatPane().getByText("Admin needs you").parentElement as HTMLElement).getByRole("button", { name: "Terminal" }));
    await settle();
    expect(actions.agent).toHaveBeenCalledWith("admin", "terminal");
  });
});

describe("the maps from the engine's shapes to the pages", () => {
  test("build: phases count verified tasks, and now holds the tasks that are in work or waiting", () => {
    const b = buildData(sampleState);
    expect(b.phases[2]).toEqual({ n: 2, title: "Screen", verified: 2, total: 5 });
    expect(b.now.map((n) => [n.task, n.state, n.agent])).toEqual([
      ["T022", "working", "worker-a"],
      ["T023", "checking", "worker-b"],
    ]);
    expect(b.agents.map((a) => a.id)).toEqual(["orchestrator", "worker-a", "worker-b", "reviewer-1", "card-runner"]);
    expect(b.agents.find((a) => a.id === "worker-a")?.promptVersion).toBe(1);
    expect(b.agents.find((a) => a.id === "reviewer-1")?.promptVersion).toBe(0);
    expect(b.needsYou).toEqual([{ kind: "question", text: "Include archived recipes in results?", agent: "worker-b", task: "T023" }]);

    const states = ["assigned", "working", "checking", "failed", "parked", "escalated", "queued", "blocked", "verified", "dropped"] as const;
    const tasks = states.map((s, i) => ({ ...sampleState.tasks!.phases[0]!.tasks[0]!, id: `X${i}`, state: s }));
    const custom = withState({ tasks: { phases: [{ n: 0, title: "P", tasks, checkpoint: null }], verified: 1, total: tasks.length } });
    expect(buildData(custom).now.map((n) => n.state)).toEqual(["assigned", "working", "checking", "failed", "parked", "escalated"]);
  });

  test("plan: the wireframes are links, and the file list holds plan files and no .html", () => {
    const p = planData(sampleState);
    expect(p.wireframes).toEqual([{ name: "search", link: "https://example.com/wireframes/search" }]);
    expect(p.files).toEqual(["ACCEPTANCE.md", "PLAN.md", "SPEC.md", "TASKS.md"]);
    expect(planData(noRepoState()).lines).toEqual([]);
  });

  test("review: the reviewers and the card runner are its agents", () => {
    const r = reviewData(sampleState);
    expect(r.agents.map((a) => a.id)).toEqual(["reviewer-1", "card-runner"]);
    expect(r.findings).toHaveLength(2);
    expect(reviewData(noRepoState())).toEqual({ findings: [], none: [], cards: [], fixes: [], needsYou: [], agents: [] });
  });

  test("prompts: a line that names a note carries its `said`; a line that names a missing note carries none", () => {
    const worker = sampleState.agents.find((a) => a.id === "worker-a");
    if (!worker) throw new Error("no worker");
    const v = promptVersions(worker, sampleState)[0];
    expect(v?.version).toBe(1);
    expect(v?.text).toContain("Implement T022 only");
    expect(v?.lines.filter((l) => l.said !== null)).toEqual([{ text: "R111 and R-111 return the same recipes (note 3).", said: "match recipe numbers without the dash too" }]);
    const lone = promptVersions({ ...worker, prompts: [{ ...worker.prompts[0]!, lines: [{ text: "x", note: 99 }] }] }, sampleState)[0];
    expect(lone?.lines).toEqual([{ text: "x", said: null }]);
  });

  test("usage: an expired window counts as 0, a time becomes epoch milliseconds, an unknown time stays null", () => {
    const now = Date.parse("2026-11-11T15:30:00.000Z");
    const u = usageData({ ...sampleUsage, tools: [{ tool: "claude", windows: [{ window: "5 hour", usedPct: 97, resetsAt: "2026-11-11T14:00:00.000Z", expired: true }, { window: "7 day", usedPct: 40, resetsAt: null, expired: false }], updatedAt: null, stale: false }] }, now);
    expect(u.tools[0]?.windows).toEqual([
      { name: "5 hour", usedPct: 0, resetsAt: Date.parse("2026-11-11T14:00:00.000Z") },
      { name: "7 day", usedPct: 40, resetsAt: null },
    ]);
    expect(u.threshold).toBe(90);
    expect(u.switchOn).toBe(true);
    expect(u.moves).toEqual([{ at: "15:02", agent: "worker-a", from: "claude", to: "codex" }]);
  });
});

describe("the plan files list", () => {
  test("it holds plan files only: wireframes/links.json is not one", () => {
    const entry = (path: string) => ({ path, kind: "plan" as const, size: 10, mtimeMs: 0, binary: false, tooLarge: false, html: false });
    const files = [entry("SPEC.md"), entry("PLAN.md"), entry("wireframes/links.json"), { ...entry("wireframes/search.html"), html: true }, entry("run/state.json")];
    expect(planData(withState({ files })).files).toEqual(["SPEC.md", "PLAN.md"]);
  });
});

describe("the map page", () => {
  test("it takes the width of the conversation, and the Chat tab brings the conversation back", async () => {
    mount();
    await settle();
    expect(document.querySelector("main.doc")?.getAttribute("data-wide")).toBe("false");
    expect(topBar().queryByRole("button", { name: "Chat" })).toBeNull();
    fireEvent.click(stages().getByRole("button", { name: "Map" }));
    await settle();
    expect(document.querySelector("main.doc")?.getAttribute("data-wide")).toBe("true");
    const tab = topBar().getByRole("button", { name: "Chat" });
    expect(tab.getAttribute("aria-pressed")).toBe("false");
    // The conversation stays mounted, hidden by the stylesheet, so its draft stays.
    expect(document.querySelector("section.chat")).toBeTruthy();
    fireEvent.click(tab);
    expect(document.querySelector("main.doc")?.getAttribute("data-wide")).toBe("false");
    expect(topBar().getByRole("button", { name: "Chat" }).getAttribute("aria-pressed")).toBe("true");
    fireEvent.click(stages().getByRole("button", { name: "Plan" }));
    expect(topBar().queryByRole("button", { name: "Chat" })).toBeNull();
  });
});

describe("usage windows", () => {
  test("the engine's window names read as the bars show them", () => {
    const u = usageData({ ...sampleUsage, tools: [{ tool: "claude", windows: [{ window: "five_hour", usedPct: 10, resetsAt: null, expired: false }, { window: "seven_day", usedPct: 5, resetsAt: null, expired: false }, { window: "opus_week", usedPct: 1, resetsAt: null, expired: false }], updatedAt: null, stale: false }] }, 0);
    expect(u.tools[0]?.windows.map((w) => w.name)).toEqual(["5 hour", "7 day", "opus week"]);
  });
});

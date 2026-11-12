/**
 * Needs-you entries lead somewhere, the tool and model control, the context line, and the count in the chat list.
 */
import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { ChatState, ChatSummary, NeedView, Question } from "../../engine/src/types.ts";
import { needText } from "../src/components/NeedEntry.tsx";
import { ChatPane, type ChatPaneProps } from "../src/chat/ChatPane.tsx";
import { App } from "../src/App.tsx";
import { AgentPage, type AgentPageProps } from "../src/pages/Agent.tsx";
import { BuildPage, type BuildPageProps } from "../src/pages/Build.tsx";
import { ReviewPage, type ReviewPageProps } from "../src/pages/Review.tsx";
import { sampleChats, sampleState } from "../src/sample.ts";
import { appProps, fakeActions, noRepoState, withState } from "./fake.ts";

afterEach(cleanup);

const noop = () => {};
const settle = () => act(async () => {});

const trust: NeedView = { kind: "trust", text: "Trust this folder?", agent: "worker-a", task: "T022" };
const permission: NeedView = { kind: "permission", text: "worker-b needs a permission", agent: "worker-b", task: "T023" };
const stopped: NeedView = { kind: "build", text: "Checkpoint failed 3 times", agent: null, task: null };

describe("needText", () => {
  test("a trust question and a permission read by the agent; the others keep the engine's text", () => {
    expect(needText(trust)).toBe("worker-a · trust question");
    expect(needText(permission)).toBe("worker-b · permission");
    expect(needText(stopped)).toBe("build · Checkpoint failed 3 times");
    expect(needText({ kind: "stalled", text: "worker-a stalled", agent: "worker-a" })).toBe("stalled · worker-a stalled");
  });

  test("a trust question with no agent keeps the engine's text", () => {
    expect(needText({ kind: "trust", text: "Trust this folder?", agent: null })).toBe("trust · Trust this folder?");
  });
});

function build(extra: Partial<BuildPageProps> = {}): BuildPageProps {
  return {
    status: "running",
    reason: null,
    halted: null,
    phases: [],
    now: [],
    outside: [],
    dropped: [],
    needsYou: [trust, permission, stopped],
    agents: [],
    onHalt: noop,
    onResume: noop,
    onAgent: noop,
    onTerminal: noop,
    onOpenTasks: noop,
    ...extra,
  };
}

describe("Needs you on the Build page", () => {
  test("a trust entry and a permission entry read by the agent", () => {
    render(<BuildPage {...build()} />);
    const region = within(screen.getByRole("region", { name: "Needs you" }));
    expect(region.getByText("worker-a · trust question")).toBeTruthy();
    expect(region.getByText("worker-b · permission")).toBeTruthy();
    expect(region.getByText("build · Checkpoint failed 3 times")).toBeTruthy();
  });

  test("an entry with an agent has Terminal; an entry with no agent has no button", () => {
    const onTerminal = mock((_id: string) => {});
    render(<BuildPage {...build({ onTerminal })} />);
    const items = within(screen.getByRole("region", { name: "Needs you" })).getAllByRole("listitem");
    expect(items).toHaveLength(3);
    fireEvent.click(within(items[0] as HTMLElement).getByRole("button", { name: "Terminal" }));
    fireEvent.click(within(items[1] as HTMLElement).getByRole("button", { name: "Terminal" }));
    expect(onTerminal.mock.calls).toEqual([["worker-a"], ["worker-b"]]);
    expect(within(items[2] as HTMLElement).queryAllByRole("button")).toHaveLength(0);
  });

  test("a click on an entry opens the page of its agent", () => {
    const onAgent = mock((_id: string) => {});
    render(<BuildPage {...build({ onAgent })} />);
    fireEvent.click(screen.getByText("worker-a · trust question"));
    expect(onAgent).toHaveBeenCalledWith("worker-a");
    fireEvent.click(screen.getByRole("button", { name: /worker-b · permission/ }));
    expect(onAgent).toHaveBeenLastCalledWith("worker-b");
  });
});

function review(extra: Partial<ReviewPageProps> = {}): ReviewPageProps {
  return { findings: [], none: [], cards: [], fixes: [], agents: [], needsYou: [trust, stopped], onTerminal: noop, onAgent: noop, onOpenFile: noop, onSendFixes: async () => null, ...extra };
}

describe("Needs you on the Review page", () => {
  test("the section is hidden when nothing waits", () => {
    render(<ReviewPage {...review({ needsYou: [] })} />);
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
  });

  test("an entry reads by the agent, has Terminal, and opens the agent's page on a click", () => {
    const onTerminal = mock((_id: string) => {});
    const onAgent = mock((_id: string) => {});
    render(<ReviewPage {...review({ onTerminal, onAgent })} />);
    const region = within(screen.getByRole("region", { name: "Needs you" }));
    expect(region.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(region.getByRole("button", { name: "Terminal" }));
    expect(onTerminal).toHaveBeenCalledWith("worker-a");
    fireEvent.click(region.getByText("worker-a · trust question"));
    expect(onAgent).toHaveBeenCalledWith("worker-a");
  });
});

function question(extra: Partial<Question> = {}): Question {
  return { n: 1, at: "15:09", agent: "worker-b", task: "T023", question: "Include archived recipes in results?", status: "open", line: 1, ...extra };
}

function pane(extra: Partial<ChatPaneProps> = {}) {
  const props: ChatPaneProps = {
    messages: [],
    notes: [],
    questions: [],
    needs: [],
    onAgent: noop,
    onAgentTerminal: noop,
    adminStatus: "idle",
    draft: "",
    onDraft: noop,
    onSend: async () => true,
    onRetry: noop,
    onUndo: async () => null,
    onTerminal: noop,
    ...extra,
  };
  return render(<ChatPane {...props} />);
}

describe("Needs you in the chat pane", () => {
  test("no list shows when nothing waits", () => {
    pane();
    expect(screen.queryByRole("list", { name: "Needs you" })).toBeNull();
  });

  test("an entry reads by the agent, has Terminal, and opens the agent's page on a click", () => {
    const onAgentTerminal = mock((_id: string) => {});
    const onAgent = mock((_id: string) => {});
    pane({ needs: [trust, permission], onAgentTerminal, onAgent });
    const list = within(screen.getByRole("list", { name: "Needs you" }));
    expect(list.getAllByRole("listitem")).toHaveLength(2);
    fireEvent.click(list.getAllByRole("button", { name: "Terminal" })[1] as HTMLElement);
    expect(onAgentTerminal).toHaveBeenCalledWith("worker-b");
    fireEvent.click(list.getByText("worker-a · trust question"));
    expect(onAgent).toHaveBeenCalledWith("worker-a");
  });

  test("an open question shows once, with Terminal and a link to the agent", () => {
    const onAgentTerminal = mock((_id: string) => {});
    const onAgent = mock((_id: string) => {});
    const need: NeedView = { kind: "question", text: "Include archived recipes in results?", agent: "worker-b", task: "T023" };
    const { container } = pane({ questions: [question()], needs: [need], onAgentTerminal, onAgent });
    expect(screen.getAllByText("Include archived recipes in results?")).toHaveLength(1);
    expect(screen.queryByRole("list", { name: "Needs you" })).toBeNull();
    const block = within(container.querySelector('[data-question="1"]') as HTMLElement);
    fireEvent.click(block.getByRole("button", { name: "Terminal" }));
    expect(onAgentTerminal).toHaveBeenCalledWith("worker-b");
    fireEvent.click(block.getByRole("button", { name: "worker-b · T023" }));
    expect(onAgent).toHaveBeenCalledWith("worker-b");
  });

  test("an admin entry replaces the plain Admin needs you line", () => {
    pane({ adminStatus: "needsYou", needs: [{ kind: "permission", text: "Admin needs a permission", agent: "admin", task: null }] });
    expect(screen.queryByText("Admin needs you")).toBeNull();
    expect(screen.getByText("admin · permission")).toBeTruthy();
    expect(screen.getAllByRole("button", { name: "Terminal" })).toHaveLength(1);
  });

  test("the plain Admin needs you line stays when no entry names the admin agent", () => {
    pane({ adminStatus: "needsYou", needs: [] });
    expect(screen.getByText("Admin needs you")).toBeTruthy();
  });
});

function agentPage(extra: Partial<AgentPageProps> = {}, agent: Partial<AgentPageProps["agent"]> = {}) {
  const props: AgentPageProps = {
    agent: { name: "Worker A", role: "worker", tool: "codex", model: "gpt-5.5", status: "stalled", task: "T022", tmux: "sst-recipes-worker-a", ...agent },
    prompts: [],
    onTerminal: noop,
    onPause: noop,
    onResume: noop,
    onRestart: noop,
    onModel: async () => null,
    ...extra,
  };
  return render(<AgentPage {...props} />);
}

const apply = () => screen.getByRole("button", { name: "Apply" }) as HTMLButtonElement;

describe("the tool and model control", () => {
  test("it shows the tool and the model of the agent; Apply is off until something changed", () => {
    agentPage();
    expect((screen.getByRole("combobox", { name: "Tool" }) as HTMLSelectElement).value).toBe("codex");
    expect(Array.from((screen.getByRole("combobox", { name: "Tool" }) as HTMLSelectElement).options).map((o) => o.textContent)).toEqual(["Claude Code", "Codex"]);
    expect((screen.getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("gpt-5.5");
    expect(apply().disabled).toBe(true);
  });

  test("a change to the tool or to the model turns Apply on; going back turns it off", () => {
    agentPage();
    fireEvent.change(screen.getByRole("combobox", { name: "Tool" }), { target: { value: "claude" } });
    expect(apply().disabled).toBe(false);
    fireEvent.change(screen.getByRole("combobox", { name: "Tool" }), { target: { value: "codex" } });
    expect(apply().disabled).toBe(true);
    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "gpt-6" } });
    expect(apply().disabled).toBe(false);
    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "gpt-5.5" } });
    expect(apply().disabled).toBe(true);
  });

  test("Apply sends the tool and the model, and the control goes quiet when the engine took them", async () => {
    const onModel = mock(async (_tool: string, _model: string) => null);
    agentPage({ onModel });
    fireEvent.change(screen.getByRole("combobox", { name: "Tool" }), { target: { value: "claude" } });
    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: " opus " } });
    await act(async () => {
      fireEvent.click(apply());
    });
    expect(onModel.mock.calls).toEqual([["claude", "opus"]]);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a refusal shows as it is and the edit stays", async () => {
    agentPage({ onModel: async () => "The agent is working" });
    fireEvent.change(screen.getByRole("textbox", { name: "Model" }), { target: { value: "gpt-6" } });
    await act(async () => {
      fireEvent.click(apply());
    });
    expect(screen.getByRole("alert").textContent).toBe("The agent is working");
    expect((screen.getByRole("textbox", { name: "Model" }) as HTMLInputElement).value).toBe("gpt-6");
    expect(apply().disabled).toBe(false);
  });

  test("Apply sits in the row of Restart", () => {
    agentPage();
    const restart = screen.getByRole("button", { name: "Restart" });
    expect(apply().parentElement).toBe(restart.parentElement);
  });
});

describe("the context line", () => {
  const ctx = () => Array.from(document.querySelectorAll("dl.props dt")).filter((e) => e.textContent === "Context");

  test("a number shows as Context n%", () => {
    agentPage({}, { contextPct: 42.4 });
    expect(ctx()).toHaveLength(1);
    expect(ctx()[0]?.nextElementSibling?.textContent).toBe("42%");
  });

  test("null and a missing value show nothing", () => {
    agentPage({}, { contextPct: null });
    expect(ctx()).toHaveLength(0);
    cleanup();
    agentPage();
    expect(ctx()).toHaveLength(0);
    cleanup();
    agentPage({}, { contextPct: 0 });
    expect(ctx()).toHaveLength(1);
  });
});

const side = () => within(document.querySelector("aside.side") as HTMLElement);
const doc = () => within(document.querySelector("main.doc") as HTMLElement);

describe("the app", () => {
  test("a needs-you entry of the Build page opens the agent page, and its Terminal posts to the agent", async () => {
    const actions = fakeActions();
    const needs: NeedView[] = [{ kind: "trust", text: "Trust this folder?", agent: "worker-a", task: "T022" }];
    render(<App {...appProps(withState({ needs }), actions)} />);
    await settle();
    const region = within(screen.getByRole("region", { name: "Needs you" }));
    fireEvent.click(region.getByRole("button", { name: "Terminal" }));
    await settle();
    expect(actions.agent).toHaveBeenLastCalledWith("worker-a", "terminal");
    fireEvent.click(region.getByText("worker-a · trust question"));
    expect(doc().getByRole("heading", { name: "Worker A" })).toBeTruthy();
  });

  test("the chat pane's entry reaches the terminal in one click", async () => {
    const actions = fakeActions();
    const needs: NeedView[] = [{ kind: "permission", text: "worker-a needs a permission", agent: "worker-a", task: "T022" }];
    render(<App {...appProps(withState({ needs }), actions)} />);
    await settle();
    const pane = within(document.querySelector("section.chat") as HTMLElement);
    fireEvent.click(within(pane.getByRole("list", { name: "Needs you" })).getByRole("button", { name: "Terminal" }));
    await settle();
    expect(actions.agent).toHaveBeenLastCalledWith("worker-a", "terminal");
  });

  test("Apply on the agent page calls agentModel with the agent, the tool and the model", async () => {
    const actions = fakeActions();
    render(<App {...appProps(sampleState, actions)} />);
    await settle();
    fireEvent.click(within(document.querySelector("header.top") as HTMLElement).getByRole("button", { name: "Worker A" }));
    fireEvent.change(doc().getByRole("textbox", { name: "Model" }), { target: { value: "gpt-6" } });
    await act(async () => {
      fireEvent.click(doc().getByRole("button", { name: "Apply" }));
    });
    expect(actions.agentModel).toHaveBeenCalledWith("worker-a", "codex", "gpt-6");
  });

  test("the agent page shows Context n% from the engine", async () => {
    const agents = sampleState.agents.map((a) => (a.id === "worker-a" ? { ...a, contextPct: 63 } : a));
    render(<App {...appProps(withState({ agents }))} />);
    await settle();
    fireEvent.click(within(document.querySelector("header.top") as HTMLElement).getByRole("button", { name: "Worker A" }));
    const dt = Array.from(document.querySelectorAll("dl.props dt")).find((e) => e.textContent === "Context");
    expect(dt?.nextElementSibling?.textContent).toBe("63%");
  });
});

describe("the count in the chat list", () => {
  const chats = (over: Partial<ChatSummary>[] = []): ChatSummary[] => sampleChats.map((c) => ({ ...c, ...(over.find((o) => o.id === c.id) ?? {}) }));

  test("the count is a button, and a chat with no needs has none", async () => {
    render(<App {...appProps(sampleState)} />);
    await settle();
    expect(side().getAllByRole("button", { name: "Needs you" })).toHaveLength(2);
    const counts = Array.from(document.querySelectorAll("aside.side button.cnt")).map((b) => [b.getAttribute("data-needs"), b.textContent]);
    expect(counts).toEqual([
      ["recipe-search", "1"],
      ["login-page", "2"],
    ]);
  });

  test("a click on the count selects the chat and does not take the click of the chat row", async () => {
    const actions = fakeActions();
    render(<App {...appProps(sampleState, actions)} />);
    await settle();
    fireEvent.click(document.querySelector('button.cnt[data-needs="login-page"]') as HTMLElement);
    expect(actions.selectChat).toHaveBeenCalledTimes(1);
    expect(actions.selectChat).toHaveBeenCalledWith("login-page");
  });

  test("the open chat opens on its Build tab from any other tab", async () => {
    render(<App {...appProps(sampleState)} />);
    await settle();
    fireEvent.click(within(document.querySelector('nav[aria-label="Stages"]') as HTMLElement).getByRole("button", { name: "Plan" }));
    expect(doc().getByRole("heading", { name: "Recipe search" })).toBeTruthy();
    fireEvent.click(document.querySelector('button.cnt[data-needs="recipe-search"]') as HTMLElement);
    await settle();
    expect(doc().getByRole("heading", { name: "Build" })).toBeTruthy();
  });

  test("a chat that opens later opens on its Build tab, not on its own stage", async () => {
    const actions = fakeActions();
    const plan: ChatState = withState({ chat: { ...sampleState.chat, id: "login-page", title: "Login page", stage: "plan" } });
    const view = render(<App {...appProps(sampleState, actions)} />);
    await settle();
    fireEvent.click(document.querySelector('button.cnt[data-needs="login-page"]') as HTMLElement);
    await settle();
    // The old chat stays on screen until the engine sends the new one.
    expect(doc().getByRole("heading", { name: "Build" })).toBeTruthy();
    view.rerender(<App {...appProps(plan, actions)} />);
    await settle();
    expect(doc().getByRole("heading", { name: "Build" })).toBeTruthy();
    expect(document.querySelector('nav[aria-label="Stages"] [aria-current="true"]')?.textContent).toBe("Build");
  });

  test("the request is used once: a later open of the chat shows its own stage", async () => {
    const actions = fakeActions();
    const plan: ChatState = withState({ chat: { ...sampleState.chat, id: "login-page", title: "Login page", stage: "plan" } });
    const view = render(<App {...appProps(sampleState, actions)} />);
    await settle();
    fireEvent.click(document.querySelector('button.cnt[data-needs="login-page"]') as HTMLElement);
    view.rerender(<App {...appProps(plan, actions)} />);
    await settle();
    // Settings and back: the chat mounts again.
    fireEvent.click(side().getByRole("button", { name: "Settings" }));
    await settle();
    fireEvent.click(document.querySelector('[data-chat="login-page"]') as HTMLElement);
    await settle();
    expect(document.querySelector('nav[aria-label="Stages"] [aria-current="true"]')?.textContent).toBe("Plan");
  });

  test("a chat with no repo opens on its conversation", async () => {
    const actions = fakeActions();
    const list = chats([{ id: "release-notes", needsYou: 1 }]);
    render(<App {...appProps(noRepoState(), actions, { chats: list })} />);
    await settle();
    fireEvent.click(document.querySelector('button.cnt[data-needs="release-notes"]') as HTMLElement);
    await settle();
    expect(actions.selectChat).toHaveBeenCalledWith("release-notes");
    expect(document.querySelector("section.chat")).not.toBeNull();
    expect(document.querySelector("main.doc")).toBeNull();
  });
});

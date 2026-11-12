import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import type { MessageView, Note, Question } from "../../engine/src/types.ts";
import { ChatPane, type ChatPaneProps } from "../src/chat/ChatPane.tsx";
import { AgentPage, type AgentPageProps, type PromptVersionView } from "../src/pages/Agent.tsx";

afterEach(cleanup);

function msg(extra: Partial<MessageView> & { id: string }): MessageView {
  return { who: "you", at: "15:00", stage: "build", text: "hello", ...extra };
}

function note(extra: Partial<Note> & { n: number }): Note {
  return { at: "2026-11-11 15:05", stage: "build", to: "orchestrator", said: "no dash in recipe numbers", note: "Match recipe numbers with or without the dash.", status: "queued", line: 1, ...extra };
}

function question(extra: Partial<Question> = {}): Question {
  return { n: 1, at: "15:09", agent: "Worker B", task: "T023", question: "Include archived recipes in results?", status: "open", line: 1, ...extra };
}

function pane(extra: Partial<ChatPaneProps> = {}) {
  const props: ChatPaneProps = {
    messages: [],
    notes: [],
    questions: [],
    needs: [],
    onAgent: () => {},
    onAgentTerminal: () => {},
    adminStatus: "idle",
    draft: "",
    onDraft: () => {},
    onSend: async () => true,
    onRetry: () => {},
    onUndo: async () => null,
    onTerminal: () => {},
    ...extra,
  };
  return render(<ChatPane {...props} />);
}

function buttonNames(root: Element): string[] {
  return Array.from(root.querySelectorAll("button")).map((b) => b.getAttribute("aria-label") ?? b.textContent ?? "");
}

describe("messages", () => {
  test("a message shows its state as a word", () => {
    const { container } = pane({
      messages: [
        msg({ id: "q", state: "queued", text: "first" }),
        msg({ id: "s", state: "sent", text: "second" }),
        msg({ id: "a", state: "answered", text: "third" }),
        msg({ id: "n", state: "notSent", text: "fourth" }),
        msg({ id: "i", state: "interrupted", text: "fifth" }),
      ],
    });
    const word = (id: string) => container.querySelector(`[data-message="${id}"] .st`)?.textContent ?? null;
    expect(word("q")).toBe("Queued");
    expect(word("s")).toBeNull();
    expect(word("a")).toBeNull();
    expect(word("n")).toBe("Not sent");
    expect(word("i")).toBe("Interrupted");
  });

  test("notSent and interrupted show Retry, and Retry calls onRetry with the message id", () => {
    const onRetry = mock((_id: string) => {});
    const { container } = pane({
      onRetry,
      messages: [msg({ id: "q", state: "queued" }), msg({ id: "n", state: "notSent" }), msg({ id: "i", state: "interrupted" })],
    });
    expect(within(container.querySelector('[data-message="q"]') as HTMLElement).queryByText("Retry")).toBeNull();
    fireEvent.click(within(container.querySelector('[data-message="n"]') as HTMLElement).getByText("Retry"));
    fireEvent.click(within(container.querySelector('[data-message="i"]') as HTMLElement).getByText("Retry"));
    expect(onRetry.mock.calls).toEqual([["n"], ["i"]]);
  });

  test("a turn from the terminal is marked from terminal", () => {
    const { container } = pane({ messages: [msg({ id: "t", who: "admin", fromTerminal: true, text: "ran it" }), msg({ id: "p", who: "admin", text: "plain" })] });
    expect(container.querySelector('[data-message="t"]')?.textContent).toContain("from terminal");
    expect(container.querySelector('[data-message="p"]')?.textContent).not.toContain("from terminal");
  });

  test("a turn with no reply text shows Done and the changed files", () => {
    const { container } = pane({ messages: [msg({ id: "d", who: "admin", text: "", files: ["PLAN.md", "TASKS.md"] })] });
    const el = container.querySelector('[data-message="d"]');
    expect(el?.textContent).toContain("Done");
    expect(el?.textContent).toContain("PLAN.md");
    expect(el?.textContent).toContain("TASKS.md");
  });

  test("a turn with reply text does not show Done", () => {
    const { container } = pane({ messages: [msg({ id: "r", who: "admin", text: "T022 is verified.", files: ["progress.md"] })] });
    expect(container.querySelector('[data-message="r"]')?.textContent).not.toContain("Done");
    expect(container.textContent).toContain("progress.md");
  });

  test("a system line shows as a plain line", () => {
    const { container } = pane({ messages: [msg({ id: "sys", who: "system", text: "Admin restarted" })] });
    const line = container.querySelector(".sys");
    expect(line?.textContent).toContain("Admin restarted");
    expect(line?.querySelector("button")).toBeNull();
  });
});

describe("permission", () => {
  test("Admin needs you shows with a Terminal button when the admin status is needsYou", () => {
    const onTerminal = mock(() => {});
    pane({ adminStatus: "needsYou", onTerminal });
    screen.getByText("Admin needs you");
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  test("the line is absent for any other status", () => {
    for (const s of ["working", "idle", "stalled", "stopped"] as const) {
      pane({ adminStatus: s });
      expect(screen.queryByText("Admin needs you")).toBeNull();
      expect(screen.queryByRole("button", { name: "Terminal" })).toBeNull();
      cleanup();
    }
  });
});

describe("notes", () => {
  test("a note shows the owner's words, its target and its status", () => {
    const { container } = pane({
      messages: [msg({ id: "m", who: "admin", text: "Noted.", note: 3 })],
      notes: [note({ n: 3, said: "no dash in recipe numbers", to: "orchestrator", status: "read", readAt: "15:06" })],
    });
    const el = container.querySelector('[data-note="3"]');
    expect(el?.textContent).toContain("no dash in recipe numbers");
    expect(el?.textContent).toContain("Orchestrator");
    expect(el?.textContent).toContain("Match recipe numbers with or without the dash.");
    expect(el?.textContent).toContain("Read 15:06");
  });

  test("each status has its word", () => {
    const { container } = pane({
      messages: [1, 2, 3, 4].map((n) => msg({ id: `m${n}`, who: "admin", text: "x", note: n })),
      notes: [note({ n: 1, status: "queued" }), note({ n: 2, status: "held" }), note({ n: 3, status: "read" }), note({ n: 4, status: "undone" })],
    });
    const status = (n: number) => container.querySelector(`[data-note="${n}"] .ns`)?.textContent ?? "";
    expect(status(1)).toContain("Queued");
    expect(status(2)).toContain("Held");
    expect(status(3)).toContain("Read");
    expect(status(4)).toContain("Undone");
  });

  test("Undo shows only while the note is queued or held", () => {
    const { container } = pane({
      messages: [1, 2, 3, 4].map((n) => msg({ id: `m${n}`, who: "admin", text: "x", note: n })),
      notes: [note({ n: 1, status: "queued" }), note({ n: 2, status: "held" }), note({ n: 3, status: "read" }), note({ n: 4, status: "undone" })],
    });
    const hasUndo = (n: number) => within(container.querySelector(`[data-note="${n}"]`) as HTMLElement).queryByText("Undo") !== null;
    expect([1, 2, 3, 4].map(hasUndo)).toEqual([true, true, false, false]);
  });

  test("Undo calls onUndo with the note number and shows nothing more when it returns null", async () => {
    const onUndo = mock(async (_n: number): Promise<string | null> => null);
    const { container } = pane({ onUndo, messages: [msg({ id: "m", who: "admin", text: "x", note: 7 })], notes: [note({ n: 7 })] });
    await act(async () => {
      fireEvent.click(screen.getByText("Undo"));
    });
    expect(onUndo).toHaveBeenCalledWith(7);
    expect(container.querySelector('[data-note="7"] .bad')).toBeNull();
  });

  test("a refusal from onUndo shows as a label on that note only", async () => {
    const onUndo = mock(async (_n: number): Promise<string | null> => "Being read");
    const { container } = pane({
      onUndo,
      messages: [msg({ id: "a", who: "admin", text: "x", note: 7 }), msg({ id: "b", who: "admin", text: "y", note: 8 })],
      notes: [note({ n: 7 }), note({ n: 8 })],
    });
    const first = container.querySelector('[data-note="7"]') as HTMLElement;
    await act(async () => {
      fireEvent.click(within(first).getByText("Undo"));
    });
    expect(first.textContent).toContain("Being read");
    expect(container.querySelector('[data-note="8"]')?.textContent).not.toContain("Being read");
  });

  test("a refusal label such as Already read shows as returned", async () => {
    const onUndo = async () => "Already read";
    const { container } = pane({ onUndo, messages: [msg({ id: "a", who: "admin", text: "x", note: 7 })], notes: [note({ n: 7 })] });
    await act(async () => {
      fireEvent.click(screen.getByText("Undo"));
    });
    expect(container.querySelector('[data-note="7"]')?.textContent).toContain("Already read");
  });
});

describe("open questions", () => {
  test("a question shows who asked, for which task, and the question", () => {
    const { container } = pane({ questions: [question()] });
    const el = container.querySelector('[data-question="1"]');
    expect(el?.textContent).toContain("Worker B");
    expect(el?.textContent).toContain("T023");
    expect(el?.textContent).toContain("Include archived recipes in results?");
  });

  test("a question has no answer buttons, only the agent link and Terminal: the owner types in the one input", () => {
    const { container } = pane({ questions: [question()] });
    const el = container.querySelector('[data-question="1"]') as HTMLElement;
    expect(buttonNames(el)).toEqual(["Worker B · T023", "Terminal"]);
    expect(container.querySelectorAll("input").length).toBe(1);
  });

  test("an answered question does not show", () => {
    const { container } = pane({ questions: [question({ status: "answered", answer: "yes" })] });
    expect(container.querySelector('[data-question="1"]')).toBeNull();
  });

  test("the pane has no yes or no buttons", () => {
    const { container } = pane({ questions: [question()], messages: [msg({ id: "m", state: "notSent" })], adminStatus: "needsYou" });
    expect(buttonNames(container).sort()).toEqual(["Retry", "Send", "Terminal", "Terminal", "Worker B · T023"]);
  });
});

describe("input", () => {
  test("it starts with the draft and reports each change", () => {
    const onDraft = mock((_t: string) => {});
    pane({ draft: "half a thought", onDraft });
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    expect(input.value).toBe("half a thought");
    fireEvent.change(input, { target: { value: "half a thought, more" } });
    expect(onDraft).toHaveBeenLastCalledWith("half a thought, more");
  });

  test("it clears when onSend resolves true", async () => {
    const onSend = mock(async (_t: string) => true);
    const onDraft = mock((_t: string) => {});
    const { container } = pane({ onSend, onDraft });
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "where is T022?" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });
    expect(onSend).toHaveBeenCalledWith("where is T022?");
    expect(input.value).toBe("");
    expect(onDraft).toHaveBeenLastCalledWith("");
    expect(screen.queryByText("Not sent")).toBeNull();
  });

  test("it keeps the text and shows Not sent when onSend resolves false", async () => {
    const { container } = pane({ onSend: async () => false });
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keep me" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });
    expect(input.value).toBe("keep me");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Not sent");
  });

  test("it keeps the text when onSend rejects", async () => {
    const { container } = pane({ onSend: async () => Promise.reject(new Error("down")) });
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "keep me" } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });
    expect(input.value).toBe("keep me");
    expect(container.querySelector('[role="status"]')?.textContent).toBe("Not sent");
  });

  test("it does not send an empty message", async () => {
    const onSend = mock(async (_t: string) => true);
    const { container } = pane({ onSend });
    fireEvent.change(screen.getByLabelText("Message"), { target: { value: "   " } });
    await act(async () => {
      fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    });
    expect(onSend).not.toHaveBeenCalled();
  });

  test("text typed while the send runs stays", async () => {
    let finish: (ok: boolean) => void = () => {};
    const onSend = () => new Promise<boolean>((r) => (finish = r));
    const { container } = pane({ onSend });
    const input = screen.getByLabelText("Message") as HTMLInputElement;
    fireEvent.change(input, { target: { value: "first" } });
    fireEvent.submit(container.querySelector("form") as HTMLFormElement);
    fireEvent.change(input, { target: { value: "first and then" } });
    await act(async () => finish(true));
    expect(input.value).toBe("first and then");
  });
});

function prompt(extra: Partial<PromptVersionView> & { version: number }): PromptVersionView {
  return {
    at: "15:00",
    text: "Read PLAN.md.\nRun one phase at a time.",
    lines: [
      { text: "Read PLAN.md.", said: null },
      { text: "Run one phase at a time.", said: null },
    ],
    ...extra,
  };
}

function agentPage(extra: Partial<AgentPageProps> = {}, agent: Partial<AgentPageProps["agent"]> = {}) {
  const props: AgentPageProps = {
    agent: { name: "Worker A", role: "worker", tool: "codex", model: "gpt-5.5", status: "working", task: "T022", tmux: "sst-recipes-worker-a", ...agent },
    prompts: [prompt({ version: 1 })],
    onTerminal: () => {},
    onPause: () => {},
    onResume: () => {},
    onRestart: () => {},
    onModel: async () => null,
    ...extra,
  };
  return render(<AgentPage {...props} />);
}

describe("agent page", () => {
  test("it shows status, task, tool, model and the tmux session as a property list", () => {
    const { container } = agentPage();
    const dl = container.querySelector("dl.props") as HTMLElement;
    const text = dl.textContent ?? "";
    expect(text).toContain("working");
    expect(text).toContain("T022");
    expect(text).toContain("Codex");
    expect(text).toContain("gpt-5.5");
    expect(text).toContain("sst-recipes-worker-a");
  });

  test("it leaves out the task row for an agent with no task", () => {
    const { container } = agentPage({}, { task: null });
    expect(container.querySelector("dl.props")?.textContent).not.toContain("Task");
  });

  test("it shows the exact prompt text of the latest version first", () => {
    const { container } = agentPage({ prompts: [prompt({ version: 1, text: "old", lines: [{ text: "old", said: null }] }), prompt({ version: 2, at: "15:06" })] });
    const pre = container.querySelector(".ap-prompt") as HTMLElement;
    expect(pre.textContent).toBe("Read PLAN.md.\nRun one phase at a time.");
  });

  test("the version picker switches the prompt", () => {
    const { container } = agentPage({ prompts: [prompt({ version: 1, at: "15:00", text: "old", lines: [{ text: "old", said: null }] }), prompt({ version: 2, at: "15:06" })] });
    fireEvent.click(screen.getByRole("button", { name: "v1 · 15:00" }));
    expect(container.querySelector(".ap-prompt")?.textContent).toBe("old");
    expect(screen.getByRole("button", { name: "v1 · 15:00" }).getAttribute("aria-current")).toBe("true");
    fireEvent.click(screen.getByRole("button", { name: "v2 · 15:06" }));
    expect(container.querySelector(".ap-prompt")?.textContent).toContain("Run one phase at a time.");
  });

  test("with one version there is no picker", () => {
    agentPage();
    expect(screen.queryByRole("button", { name: /^v1/ })).toBeNull();
  });

  test("a prompt line that came from a note shows the owner's words next to it", () => {
    const { container } = agentPage({
      prompts: [
        prompt({
          version: 1,
          text: "Implement T022.\nMatch recipe numbers without the dash.",
          lines: [
            { text: "Implement T022.", said: null },
            { text: "Match recipe numbers without the dash.", said: "no dash in recipe numbers" },
          ],
        }),
      ],
    });
    const lines = container.querySelectorAll(".ap-line");
    expect(lines.length).toBe(2);
    expect(lines[0]?.textContent).not.toContain("no dash in recipe numbers");
    expect(lines[1]?.textContent).toContain("Match recipe numbers without the dash.");
    expect(lines[1]?.textContent).toContain("no dash in recipe numbers");
  });

  test("it shows the prompt text when the version has no lines", () => {
    const { container } = agentPage({ prompts: [prompt({ version: 1, text: "Whole text", lines: [] })] });
    expect(container.querySelector(".ap-prompt")?.textContent).toBe("Whole text");
  });

  test("it shows no prompt block for an agent with no versions", () => {
    const { container } = agentPage({ prompts: [] });
    expect(container.querySelector(".ap-prompt")).toBeNull();
  });

  test("Terminal always shows and calls onTerminal", () => {
    const onTerminal = mock(() => {});
    for (const s of ["working", "paused", "stalled", "stopped", "idle", "needsYou", "halted", "starting"] as const) {
      agentPage({ onTerminal }, { status: s });
      expect(screen.getByRole("button", { name: "Terminal" })).toBeTruthy();
      cleanup();
    }
    agentPage({ onTerminal });
    fireEvent.click(screen.getByRole("button", { name: "Terminal" }));
    expect(onTerminal).toHaveBeenCalledTimes(1);
  });

  test("Pause shows when working, Resume when paused, Restart when stalled or stopped", () => {
    const shown = (status: AgentPageProps["agent"]["status"]) => {
      agentPage({}, { status });
      const names = Array.from(document.querySelectorAll("button"))
        .map((b) => b.textContent ?? "")
        .filter((t) => ["Terminal", "Pause", "Resume", "Restart"].includes(t));
      cleanup();
      return names;
    };
    expect(shown("working")).toEqual(["Terminal", "Pause"]);
    expect(shown("paused")).toEqual(["Terminal", "Resume"]);
    expect(shown("stalled")).toEqual(["Terminal", "Restart"]);
    expect(shown("stopped")).toEqual(["Terminal", "Restart"]);
    expect(shown("idle")).toEqual(["Terminal"]);
    expect(shown("needsYou")).toEqual(["Terminal"]);
    expect(shown("halted")).toEqual(["Terminal"]);
  });

  test("Pause, Resume and Restart call their callbacks", () => {
    const onPause = mock(() => {});
    const onResume = mock(() => {});
    const onRestart = mock(() => {});
    agentPage({ onPause, onResume, onRestart }, { status: "working" });
    fireEvent.click(screen.getByRole("button", { name: "Pause" }));
    cleanup();
    agentPage({ onPause, onResume, onRestart }, { status: "paused" });
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    cleanup();
    agentPage({ onPause, onResume, onRestart }, { status: "stalled" });
    fireEvent.click(screen.getByRole("button", { name: "Restart" }));
    expect([onPause.mock.calls.length, onResume.mock.calls.length, onRestart.mock.calls.length]).toEqual([1, 1, 1]);
  });
});

describe("the header", () => {
  test("it shows the admin agent's status when the chat has an admin agent", () => {
    const { container } = pane({ adminStatus: "working" });
    expect(container.querySelector(".ch")?.textContent).toContain("Admin");
    expect(container.querySelector(".ch")?.textContent).toContain("working");
  });

  test("it shows nothing when the chat has no admin agent", () => {
    const { container } = pane({ adminStatus: null });
    expect(container.querySelector(".ch")).toBeNull();
    expect(container.textContent).not.toContain("stopped");
    // The conversation and the input stay.
    expect(screen.getByRole("textbox", { name: "Message" })).toBeTruthy();
  });
});

describe("a note that no message carries", () => {
  test("it shows in the pane with its target and status, and Undo while it is queued", () => {
    const { container } = pane({ messages: [msg({ id: "m", who: "you", text: "x" })], notes: [note({ n: 5, said: "add a doc", to: "orchestrator", status: "queued" })] });
    const block = container.querySelector('[data-loose-note="5"]');
    expect(block?.textContent).toContain("Queued");
    expect(block?.textContent).toContain("add a doc");
    expect(within(block as HTMLElement).getByRole("button", { name: "Undo" })).toBeTruthy();
  });

  test("a note a message carries shows once", () => {
    const { container } = pane({ messages: [msg({ id: "m", who: "admin", text: "Noted.", note: 3 })], notes: [note({ n: 3, status: "read", readAt: "15:06" })] });
    expect(container.querySelectorAll('[data-note="3"]').length).toBe(1);
    expect(container.querySelector("[data-loose-note]")).toBeNull();
  });
});

describe("a message's state", () => {
  test("each message carries its state, so a test can read it, and only queued, notSent and interrupted show a word", () => {
    const { container } = pane({ messages: [msg({ id: "a", who: "you", text: "one", state: "answered" }), msg({ id: "b", who: "you", text: "two", state: "queued" })] });
    expect(container.querySelector('[data-message="a"]')?.getAttribute("data-state")).toBe("answered");
    expect(container.querySelector('[data-message="b"]')?.getAttribute("data-state")).toBe("queued");
    expect(container.querySelector('[data-message="a"] .st')).toBeNull();
    expect(container.querySelector('[data-message="b"] .st')?.textContent).toBe("Queued");
  });
});

describe("the agent page with no prompt", () => {
  test("it has no Prompt heading", () => {
    render(<AgentPage agent={{ role: "admin", tool: "claude", model: "opus", status: "idle", task: null, tmux: "sst-x-admin" }} prompts={[]} onTerminal={() => {}} onPause={() => {}} onResume={() => {}} onRestart={() => {}} onModel={async () => null} />);
    expect(screen.queryByRole("heading", { name: "Prompt" })).toBeNull();
    expect(document.querySelector("dl.props")?.textContent).toContain("Claude Code");
  });
});

describe("the prompt text is exact", () => {
  test("blank lines and indents stay, and the text on the page is the text of the file", () => {
    const text = "# Worker\n\nRead PLAN.md.\n\n  - one\n  - two\n";
    const { container } = agentPage({ prompts: [prompt({ version: 1, text, lines: [{ text: "# Worker", said: null }, { text: "Read PLAN.md.", said: null }] })] });
    expect(container.querySelector(".ap-prompt")?.textContent).toBe(text);
  });
});

describe("two prompts of one version", () => {
  test("a worker has one prompt file per task, each at v1: the tabs name the task and each opens its own text", () => {
    const { container } = agentPage({
      prompts: [
        prompt({ version: 1, file: "run/prompts/worker-a-T001-v1.md", text: "first task", lines: [] }),
        prompt({ version: 1, file: "run/prompts/worker-a-T002-v1.md", text: "second task", lines: [] }),
        prompt({ version: 1, file: "run/prompts/worker-a-T003-v1.md", text: "third task", lines: [] }),
      ],
    });
    expect(container.querySelector(".ap-prompt")?.textContent).toBe("third task");
    expect(screen.getAllByRole("button", { name: /^T00\d v1/ }).map((b) => b.textContent)).toEqual(["T001 v1 · 15:00", "T002 v1 · 15:00", "T003 v1 · 15:00"]);
    fireEvent.click(screen.getByRole("button", { name: "T002 v1 · 15:00" }));
    expect(container.querySelector(".ap-prompt")?.textContent).toBe("second task");
    expect(screen.getByRole("button", { name: "T002 v1 · 15:00" }).getAttribute("aria-current")).toBe("true");
    expect(screen.getByRole("button", { name: "T003 v1 · 15:00" }).getAttribute("aria-current")).toBe("false");
  });
});

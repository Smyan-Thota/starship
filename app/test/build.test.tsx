import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { BuildPage, type BuildPageProps } from "../src/pages/Build.tsx";

afterEach(cleanup);

function props(extra: Partial<BuildPageProps> = {}): BuildPageProps {
  return {
    status: "running",
    reason: null,
    halted: null,
    phases: [
      { n: 1, title: "Index and service", verified: 4, total: 4 },
      { n: 2, title: "Results screen", verified: 1, total: 5 },
    ],
    now: [
      { task: "T022", text: "Empty and no-match states", agent: "Worker A", state: "working" },
      { task: "T023", text: "Typecheck of the screen", agent: "Worker B", state: "checking" },
    ],
    outside: [],
    dropped: [],
    needsYou: [],
    agents: [
      { id: "worker-a", role: "worker", tool: "codex", model: "gpt-5", status: "working", task: "T022", promptVersion: 3 },
      { id: "orchestrator", role: "orchestrator", tool: "claude", model: "opus", status: "idle", task: null, promptVersion: 2 },
    ],
    onHalt: () => {},
    onResume: () => {},
    onAgent: () => {},
    onTerminal: () => {},
    onOpenTasks: () => {},
    ...extra,
  };
}

describe("BuildPage", () => {
  test("phase table has phase, verified and total", () => {
    render(<BuildPage {...props()} />);
    const table = screen.getByRole("table");
    const heads = within(table).getAllByRole("columnheader").map((h) => h.textContent);
    expect(heads).toEqual(["Phase", "Verified", "Total"]);
    const rows = within(table).getAllByRole("row");
    expect(rows).toHaveLength(3);
    expect(rows[1]?.textContent).toContain("Index and service");
    expect(rows[1]?.textContent).toContain("4");
    expect(rows[2]?.textContent).toContain("Results screen");
    expect(within(rows[2] as HTMLElement).getAllByRole("cell").map((c) => c.textContent)).toEqual(["2 · Results screen", "1", "5"]);
  });

  test("Now lists one row per running or waiting task with agent and state", () => {
    render(<BuildPage {...props()} />);
    const now = screen.getByRole("region", { name: "Now" });
    const rows = within(now).getAllByRole("listitem");
    expect(rows).toHaveLength(2);
    expect(rows[0]?.textContent).toContain("T022");
    expect(rows[0]?.textContent).toContain("Empty and no-match states");
    expect(rows[0]?.textContent).toContain("Worker A");
    expect(rows[0]?.textContent).toContain("working");
    expect(rows[1]?.textContent).toContain("checking");
  });

  test("a task with no agent shows no agent name", () => {
    render(<BuildPage {...props({ now: [{ task: "T030", text: "Wait for typecheck", agent: null, state: "parked" }] })} />);
    const now = screen.getByRole("region", { name: "Now" });
    expect(within(now).getByRole("listitem").textContent).toBe("T030Wait for typecheckparked");
  });

  test("Now says Nothing when no task runs", () => {
    render(<BuildPage {...props({ now: [] })} />);
    expect(within(screen.getByRole("region", { name: "Now" })).getByText("Nothing")).toBeTruthy();
  });

  test("Needs you, Outside the task and Dropped are hidden when empty", () => {
    render(<BuildPage {...props()} />);
    expect(screen.queryByRole("region", { name: "Needs you" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Outside the task" })).toBeNull();
    expect(screen.queryByRole("region", { name: "Dropped" })).toBeNull();
  });

  test("Needs you, Outside the task and Dropped show their rows", () => {
    render(
      <BuildPage
        {...props({
          needsYou: [
            { kind: "question", text: "Include archived recipes?", agent: "Worker B", task: "T023" },
            { kind: "build stopped", text: "Checkpoint failed 3 times", agent: null, task: null },
          ],
          outside: ["app/src/stray.ts", "README.md"],
          dropped: [{ task: "T019", text: "Saved searches", reason: "Out of scope" }],
        })}
      />,
    );
    const needs = screen.getByRole("region", { name: "Needs you" });
    const items = within(needs).getAllByRole("listitem");
    expect(items[0]?.textContent).toContain("question");
    expect(items[0]?.textContent).toContain("Include archived recipes?");
    expect(items[0]?.textContent).toContain("Worker B");
    expect(items[0]?.textContent).toContain("T023");
    expect(items[1]?.textContent).toContain("Checkpoint failed 3 times");
    const outside = screen.getByRole("region", { name: "Outside the task" });
    expect(within(outside).getAllByRole("listitem").map((i) => i.textContent)).toEqual(["app/src/stray.ts", "README.md"]);
    const dropped = screen.getByRole("region", { name: "Dropped" });
    const d = within(dropped).getByRole("listitem").textContent ?? "";
    expect(d).toContain("T019");
    expect(d).toContain("Saved searches");
    expect(d).toContain("Out of scope");
  });

  test("shows Halted with the time when halted, and nothing when not", () => {
    const { rerender } = render(<BuildPage {...props()} />);
    expect(screen.queryByText(/Halted/)).toBeNull();
    rerender(<BuildPage {...props({ halted: "15:42" })} />);
    expect(screen.getByText("Halted 15:42")).toBeTruthy();
  });

  test("shows the status, and the reason when the build is stopped", () => {
    const { rerender } = render(<BuildPage {...props({ status: "notStarted" })} />);
    expect(screen.getByText("Not started")).toBeTruthy();
    rerender(<BuildPage {...props({ status: "done" })} />);
    expect(screen.getByText("Done")).toBeTruthy();
    rerender(<BuildPage {...props({ status: "stopped", reason: { kind: "tasks", text: "TASKS.md:14 cannot be read" } })} />);
    expect(screen.getByText("Stopped")).toBeTruthy();
    expect(screen.getByText("TASKS.md:14 cannot be read")).toBeTruthy();
  });

  test("one row per agent with role, tool, model, status, task and prompt version", () => {
    render(<BuildPage {...props()} />);
    const list = screen.getByRole("region", { name: "Agents" });
    const rows = list.querySelectorAll("[data-agent]");
    expect(rows).toHaveLength(2);
    const a = rows[0]?.textContent ?? "";
    for (const part of ["worker", "codex", "gpt-5", "working", "T022", "v3"]) expect(a).toContain(part);
    const b = rows[1]?.textContent ?? "";
    expect(b).toContain("orchestrator");
    expect(b).toContain("v2");
  });

  test("a click on the row calls onAgent, and Terminal calls onTerminal only", () => {
    const onAgent = mock((_id: string) => {});
    const onTerminal = mock((_id: string) => {});
    render(<BuildPage {...props({ onAgent, onTerminal })} />);
    const row = document.querySelector('[data-agent="worker-a"]') as HTMLElement;
    fireEvent.click(within(row).getByText("gpt-5"));
    expect(onAgent).toHaveBeenCalledWith("worker-a");
    expect(onTerminal).not.toHaveBeenCalled();
    onAgent.mockClear();
    const other = document.querySelector('[data-agent="orchestrator"]') as HTMLElement;
    fireEvent.click(within(other).getByRole("button", { name: "Terminal" }));
    expect(onTerminal).toHaveBeenCalledWith("orchestrator");
    expect(onAgent).not.toHaveBeenCalled();
  });

  test("Halt shows while the chat is not halted, and calls onHalt", () => {
    const onHalt = mock(() => {});
    render(<BuildPage {...props({ onHalt })} />);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Halt" }));
    expect(onHalt).toHaveBeenCalledTimes(1);
  });

  test("Resume shows when the chat is halted, in place of Halt", () => {
    const onResume = mock(() => {});
    render(<BuildPage {...props({ halted: "15:42", onResume })} />);
    expect(screen.queryByRole("button", { name: "Halt" })).toBeNull();
    fireEvent.click(screen.getByRole("button", { name: "Resume" }));
    expect(onResume).toHaveBeenCalledTimes(1);
  });

  test("Resume shows when the build is stopped on a checkpoint, not on another reason", () => {
    const { rerender } = render(<BuildPage {...props({ status: "stopped", reason: { kind: "checkpoint", text: "Phase 2 checkpoint failed 3 times" } })} />);
    expect(screen.getByRole("button", { name: "Resume" })).toBeTruthy();
    rerender(<BuildPage {...props({ status: "stopped", reason: { kind: "folder", text: "Feature folder is missing" } })} />);
    expect(screen.queryByRole("button", { name: "Resume" })).toBeNull();
    expect(screen.getByRole("button", { name: "Halt" })).toBeTruthy();
  });

  test("a Tasks control calls onOpenTasks", () => {
    const onOpenTasks = mock(() => {});
    render(<BuildPage {...props({ onOpenTasks })} />);
    fireEvent.click(screen.getByRole("button", { name: "Tasks" }));
    expect(onOpenTasks).toHaveBeenCalledTimes(1);
  });
});

describe("BuildPage with no agent", () => {
  test("there is no Agents heading and no Agents region", () => {
    render(<BuildPage {...props({ agents: [] })} />);
    expect(screen.queryByRole("region", { name: "Agents" })).toBeNull();
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
  });
});

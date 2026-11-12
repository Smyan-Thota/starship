import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import { PlanPage, type PlanPageProps } from "../src/pages/Plan.tsx";

afterEach(cleanup);

function props(extra: Partial<PlanPageProps> = {}): PlanPageProps {
  return {
    title: "Recipe search",
    lines: [
      { label: "Problem", value: "Cooks cannot find a recipe by number", file: "SPEC.md", heading: "Problem" },
      { label: "Scope", value: "3 items in, 2 out", file: "PLAN.md", heading: "In scope" },
      { label: "Tasks", value: "20 in 4 phases", file: "TASKS.md", heading: null },
    ],
    problems: [],
    wireframes: [
      { name: "Search screen", link: "https://claude.ai/artifact/abc" },
      { name: "Empty state", link: null },
    ],
    files: ["SPEC.md", "PLAN.md", "TASKS.md"],
    onOpenFile: () => {},
    onOpenWireframe: () => {},
    onStartBuild: async () => null,
    ...extra,
  };
}

describe("PlanPage", () => {
  test("shows the chat title and each TL;DR line as a label and a value", () => {
    render(<PlanPage {...props()} />);
    expect(screen.getByRole("heading", { level: 1 }).textContent).toBe("Recipe search");
    const row = screen.getByRole("button", { name: /Tasks.*20 in 4 phases/ });
    expect(row.textContent).toContain("Tasks");
    expect(row.textContent).toContain("20 in 4 phases");
  });

  test("a TL;DR line opens its file at its heading", () => {
    const onOpenFile = mock((_file: string, _heading: string | null) => {});
    render(<PlanPage {...props({ onOpenFile })} />);
    fireEvent.click(screen.getByRole("button", { name: /Scope.*3 items in/ }));
    expect(onOpenFile).toHaveBeenCalledWith("PLAN.md", "In scope");
    fireEvent.click(screen.getByRole("button", { name: /Tasks.*20 in 4 phases/ }));
    expect(onOpenFile).toHaveBeenLastCalledWith("TASKS.md", null);
  });

  test("lists the plan files, and a click opens the file with no heading", () => {
    const onOpenFile = mock((_file: string, _heading: string | null) => {});
    render(<PlanPage {...props({ onOpenFile })} />);
    fireEvent.click(screen.getByRole("button", { name: "SPEC.md" }));
    expect(onOpenFile).toHaveBeenCalledWith("SPEC.md", null);
  });

  test("lists wireframes by name, opens one on a click, and renders nothing inline", () => {
    const onOpenWireframe = mock((_name: string) => {});
    const { container } = render(<PlanPage {...props({ onOpenWireframe })} />);
    fireEvent.click(screen.getByRole("button", { name: "Search screen" }));
    expect(onOpenWireframe).toHaveBeenCalledWith("Search screen");
    fireEvent.click(screen.getByRole("button", { name: "Empty state" }));
    expect(onOpenWireframe).toHaveBeenLastCalledWith("Empty state");
    expect(container.querySelector("iframe, object, embed, img")).toBeNull();
  });

  test("shows no wireframe list when there is none", () => {
    render(<PlanPage {...props({ wireframes: [] })} />);
    expect(screen.queryByRole("heading", { name: "Wireframes" })).toBeNull();
  });

  test("Start build calls onStartBuild once, and a null answer shows no refusal", async () => {
    const onStartBuild = mock(async () => null as string | null);
    render(<PlanPage {...props({ onStartBuild })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start build" }));
    });
    expect(onStartBuild).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a refusal text from the engine shows as is", async () => {
    const text = "Plan is not valid: PLAN.md has no Rollout section";
    render(<PlanPage {...props({ onStartBuild: async () => text })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start build" }));
    });
    expect(screen.getByRole("alert").textContent).toBe(text);
  });

  test("a rejected start shows the error message", async () => {
    render(<PlanPage {...props({ onStartBuild: async () => Promise.reject(new Error("Engine offline")) })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start build" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("Engine offline");
  });

  test("no problems: no problem list", () => {
    render(<PlanPage {...props()} />);
    expect(screen.queryByRole("list", { name: "Problems" })).toBeNull();
  });

  test("problems list above the button with file, line and text, and a click opens the file", () => {
    const onOpenFile = mock((_file: string, _heading: string | null) => {});
    render(
      <PlanPage
        {...props({
          onOpenFile,
          problems: [
            { file: "PLAN.md", line: 41, text: "No section for rollout" },
            { file: "ACCEPTANCE.md", line: null, text: "File is missing" },
          ],
        })}
      />,
    );
    const list = screen.getByRole("list", { name: "Problems" });
    expect(list.textContent).toContain("PLAN.md:41");
    expect(list.textContent).toContain("No section for rollout");
    expect(list.textContent).toContain("ACCEPTANCE.md");
    expect(list.textContent).not.toContain("ACCEPTANCE.md:");
    const start = screen.getByRole("button", { name: "Start build" });
    expect(list.compareDocumentPosition(start) & Node.DOCUMENT_POSITION_FOLLOWING).toBeTruthy();
    fireEvent.click(screen.getByRole("button", { name: /PLAN\.md:41/ }));
    expect(onOpenFile).toHaveBeenCalledWith("PLAN.md", null);
  });

  test("Start build stays enabled when there are problems, so the engine gives the refusal", async () => {
    const onStartBuild = mock(async () => "Plan is not valid");
    render(<PlanPage {...props({ onStartBuild, problems: [{ file: "PLAN.md", line: 1, text: "x" }] })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Start build" }));
    });
    expect(onStartBuild).toHaveBeenCalledTimes(1);
    expect(screen.getByRole("alert").textContent).toBe("Plan is not valid");
  });
});

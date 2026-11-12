import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen } from "@testing-library/react";
import type { ChatState, FileBody } from "../../engine/src/types.ts";
import { App } from "../src/App.tsx";
import { ChatPane } from "../src/chat/ChatPane.tsx";
import { FileView } from "../src/pages/FileView.tsx";
import { Files } from "../src/pages/Files.tsx";
import { Markdown, renderMarkdown } from "../src/pages/Markdown.tsx";
import { Tasks } from "../src/pages/Tasks.tsx";
import { sampleLoadFile, sampleState } from "../src/sample.ts";
import { appProps, info, noRepoState } from "./fake.ts";

afterEach(cleanup);

const noop = () => {};

/** Sentences of more than 14 words in text the window wrote, outside Markdown content. */
function longSentences(root: Element): string[] {
  const out: string[] = [];
  const walk = (el: Element) => {
    if (el.classList.contains("md")) return;
    const own = Array.from(el.childNodes).some((n) => n.nodeType === 3 && (n.textContent ?? "").trim() !== "");
    if (own) {
      for (const s of (el.textContent ?? "").split(/[.!?](?:\s|$)/)) {
        const words = s.trim().split(/\s+/).filter((w) => /[A-Za-z]/.test(w));
        if (words.length > 14) out.push(s.trim());
      }
    }
    for (const c of Array.from(el.children)) walk(c);
  };
  walk(root);
  return out;
}

function clickTab(nav: "Stages" | "Documents", label: string) {
  const tab = Array.from(document.querySelectorAll(`nav[aria-label="${nav}"] button`)).find((b) => b.textContent === label);
  if (!tab) throw new Error(`No tab ${label}`);
  fireEvent.click(tab);
}

describe("file view", () => {
  test("C8: a binary file shows its name, kind and size, and no content", async () => {
    const body: FileBody = { info: info("run/logs/shot.png", { binary: true, size: 20480 }), text: null, open: false };
    const loadFile = mock(() => Promise.resolve(body));
    const { container, findByTestId } = render(<FileView path="run/logs/shot.png" loadFile={loadFile} onOpenInBrowser={noop} />);
    const facts = await findByTestId("file-facts");
    expect(facts.textContent).toContain("run/logs/shot.png");
    expect(facts.textContent).toContain("binary");
    expect(facts.textContent).toContain("20.0 KB");
    expect(container.querySelector(".md")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
    expect(screen.queryByText("Raw")).toBeNull();
  });

  test("C8: a file over 1 MB shows its size, and no content", async () => {
    const body: FileBody = { info: info("run/logs/check.log", { tooLarge: true, size: 2_500_000 }), text: null, open: false };
    const loadFile = mock(() => Promise.resolve(body));
    const { container, findByTestId } = render(<FileView path="run/logs/check.log" loadFile={loadFile} onOpenInBrowser={noop} />);
    const facts = await findByTestId("file-facts");
    expect(facts.textContent).toContain("run/logs/check.log");
    expect(facts.textContent).toContain("over 1 MB");
    expect(facts.textContent).toContain("2.4 MB");
    expect(container.querySelector(".md")).toBeNull();
    expect(container.querySelector("pre")).toBeNull();
  });

  test("C12: an .html file is never rendered; it asks to open in the browser", async () => {
    const loadFile = mock((path: string) => Promise.resolve<FileBody>({ info: info(path), text: "<h1>Wire</h1>", open: true }));
    const onOpenInBrowser = mock((_path: string) => {});
    const { container } = render(<FileView path="wireframes/search.html" loadFile={loadFile} onOpenInBrowser={onOpenInBrowser} />);
    await act(async () => {});
    expect(loadFile).not.toHaveBeenCalled();
    expect(container.querySelector("h1")).toBeNull();
    expect(container.querySelector("iframe")).toBeNull();
    const open = screen.getByRole("button", { name: "Open ↗" });
    fireEvent.click(open);
    expect(onOpenInBrowser).toHaveBeenCalledWith("wireframes/search.html");

    // From the file list, an .html row opens in the browser and is never loaded.
    cleanup();
    const onOpenFile = mock((_path: string) => {});
    const onOpen2 = mock((_path: string) => {});
    const list = render(<Files state={sampleState} onOpenFile={onOpenFile} onOpenInBrowser={onOpen2} />);
    const row = list.container.querySelector('[data-path="wireframes/search.html"]');
    if (!row) throw new Error("no .html row");
    fireEvent.click(row);
    expect(onOpen2).toHaveBeenCalledWith("wireframes/search.html");
    expect(onOpenFile).not.toHaveBeenCalled();

    // A body the engine marks `open` shows only the Open control, whatever its name.
    cleanup();
    const body: FileBody = { info: info("wireframes/page"), text: "<p>x</p>", open: true };
    const r3 = render(<FileView path="wireframes/page" loadFile={() => Promise.resolve(body)} onOpenInBrowser={noop} />);
    await r3.findByRole("button", { name: "Open ↗" });
    expect(r3.container.querySelector("p")?.textContent).toBe("Open ↗");
  });

  test("a Markdown file has a Rendered and Raw toggle", async () => {
    const { container, findByRole } = render(<FileView path="SPEC.md" loadFile={sampleLoadFile} onOpenInBrowser={noop} />);
    const raw = await findByRole("button", { name: "Raw" });
    expect(container.querySelector(".md h1")?.textContent).toContain("Recipe search");
    fireEvent.click(raw);
    expect(container.querySelector(".md")).toBeNull();
    expect(container.querySelector("pre")?.textContent).toContain("# SPEC");
    screen.getByRole("button", { name: "Rendered" });
  });
});

describe("markdown", () => {
  test("C9: Markdown with a script tag renders with no script", () => {
    const src = [
      "# Title",
      "",
      "<script>window.hacked = true</script>",
      "",
      '<img src="x.png" onerror="window.hacked = true">',
      "",
      '<a href="#" onclick="window.hacked = true">click</a>',
      "",
      "[link](javascript:alert(1))",
      "",
      '<div onmouseover="alert(1)">hover</div>',
      "",
      "- [x] done",
      "- [ ] open",
    ].join("\n");
    const { container } = render(<Markdown text={src} />);
    expect(container.querySelectorAll("script").length).toBe(0);
    for (const el of Array.from(container.querySelectorAll("*"))) {
      for (const a of Array.from(el.attributes)) expect(a.name.startsWith("on")).toBe(false);
      expect(el.getAttribute("onerror")).toBeNull();
      expect(el.getAttribute("onclick")).toBeNull();
    }
    for (const a of Array.from(container.querySelectorAll("a"))) expect((a.getAttribute("href") ?? "").toLowerCase()).not.toContain("javascript:");
    expect(container.querySelector("img")).not.toBeNull();
    expect(container.querySelector("h1")?.textContent).toBe("Title");
    expect((globalThis as Record<string, unknown>).hacked).toBeUndefined();

    // Task-list boxes are marks, not inputs.
    expect(container.querySelectorAll("input").length).toBe(0);
    expect(container.querySelectorAll(".box").length).toBe(2);
    expect(container.querySelectorAll(".box.on").length).toBe(1);

    const html = renderMarkdown("<script>x()</script><img src=x onerror=alert(1)>");
    expect(html).not.toContain("<script");
    expect(html).not.toContain("onerror");
  });
});

describe("tasks", () => {
  test("the Tasks page shows 9 of 20 and T022 working on worker-a", () => {
    const { container } = render(<Tasks state={sampleState} />);
    expect(container.textContent).toContain("9 / 20");
    expect(container.querySelectorAll("[data-task]").length).toBe(20);
    expect(container.querySelectorAll(".box.on").length).toBe(9);
    const t022 = container.querySelector('[data-task="T022"]');
    expect(t022?.querySelector(".s")?.textContent).toBe("worker-a · working");
    expect(container.querySelector('[data-task="T023"] .s')?.textContent).toBe("worker-b · checking");
    expect(container.querySelector('[data-task="T031"] .s')?.textContent).toBe("needs you");
    expect(container.querySelectorAll(".ph").length).toBe(5);
  });

  test("a tasksError shows its file, line and reason, and no task list", () => {
    const state: ChatState = { ...sampleState, tasks: null, tasksError: { file: "TASKS.md", line: 14, reason: "no verify command" } };
    const { container, getByTestId } = render(<Tasks state={state} />);
    const err = getByTestId("tasks-error");
    expect(err.textContent).toContain("TASKS.md");
    expect(err.textContent).toContain("14");
    expect(err.textContent).toContain("no verify command");
    expect(container.querySelectorAll("[data-task]").length).toBe(0);
  });
});

describe("a chat with no repo", () => {
  test("every page renders for a chat that has no repo", async () => {
    const state = noRepoState();
    expect(() => render(<Tasks state={state} />)).not.toThrow();
    cleanup();
    expect(() => render(<Files state={state} onOpenFile={noop} onOpenInBrowser={noop} />)).not.toThrow();
    cleanup();
    expect(() =>
      render(<ChatPane messages={[]} notes={[]} questions={[]} needs={[]} onAgent={noop} onAgentTerminal={noop} adminStatus="stopped" draft="" onDraft={noop} onSend={async () => true} onRetry={noop} onUndo={async () => null} onTerminal={noop} />),
    ).not.toThrow();
    cleanup();
    const app = render(<App {...appProps(state)} />);
    await act(async () => {});
    expect(app.container.querySelector(".top .ttl")?.textContent).toBe("Release notes");
    expect(app.container.querySelector('nav[aria-label="Stages"]')).toBeNull();
    expect(app.container.querySelector('nav[aria-label="Documents"]')).toBeNull();
    cleanup();
    expect(() => render(<App {...appProps(null)} />)).not.toThrow();
  });
});

describe("copy", () => {
  test("no rendered page contains a sentence of more than 14 words outside Markdown content", async () => {
    const { container } = render(<App {...appProps(sampleState)} />);
    const pages: string[] = [];
    const check = async (name: string) => {
      await act(async () => {});
      const long = longSentences(container);
      if (long.length) pages.push(`${name}: ${long.join(" | ")}`);
    };
    await check("Build");
    for (const stage of ["Map", "Plan", "Review", "Build"]) {
      clickTab("Stages", stage);
      await check(stage);
    }
    for (const page of ["Tasks", "Files"]) {
      clickTab("Documents", page);
      await check(page);
    }
    fireEvent.click(screen.getByText("Settings"));
    await check("Settings");
    fireEvent.click(screen.getByText(/New chat/));
    await check("New chat");
    const binary: FileBody = { info: info("run/x.bin", { binary: true }), text: null, open: false };
    cleanup();
    const fv = render(<FileView path="run/x.bin" loadFile={() => Promise.resolve(binary)} onOpenInBrowser={noop} />);
    await act(async () => {});
    const long = longSentences(fv.container);
    if (long.length) pages.push(`file facts: ${long.join(" | ")}`);
    expect(pages).toEqual([]);
  });
});

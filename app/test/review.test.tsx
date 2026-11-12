import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { act, cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { ReviewPage, type ReviewPageProps } from "../src/pages/Review.tsx";

afterEach(cleanup);

const noop = () => {};

function props(extra: Partial<ReviewPageProps> = {}): ReviewPageProps {
  return {
    findings: [
      { n: 1, sev: "high", reviewer: "Reviewer 1", where: "SearchBox.tsx:41", text: "A request on every keystroke", status: "accepted", dispute: null },
      { n: 2, sev: "medium", reviewer: "Reviewer 2", where: "migrations/recipes_trgm_index:3", text: "Index migration locks the table", status: "disputed", dispute: { reviewer: "Reviewer 1", why: "4,000 rows, the lock is under 1 second" } },
      { n: 3, sev: "low", reviewer: "Reviewer 1", where: "Results.tsx:67", text: "Copy differs from Acceptance", status: "open", dispute: null },
      { n: 4, sev: "low", reviewer: "Reviewer 2", where: "Row.tsx:9", text: "Unused import", status: "rejected", dispute: null },
    ],
    none: [],
    cards: [
      { id: "C1", title: "Search by number", criteria: ["The list shows one row", "The row links to the recipe"], result: "pass", note: "" },
      { id: "C2", title: "Empty result", criteria: ["The page says no recipes match"], result: "fail", note: "Page says No recipes found" },
      { id: "C3", title: "Outage", criteria: [], result: "unclear", note: "the test server is down" },
      { id: "C4", title: "Paging", criteria: [], result: null, note: "" },
    ],
    fixes: [
      { n: 1, text: "Wait 250 ms between requests", from: "F1" },
      { n: 2, text: "Match numbers without the dash", from: "Note 2" },
    ],
    agents: [
      { id: "r1", role: "Reviewer 1", tool: "codex", model: "gpt", status: "done" },
      { id: "r2", role: "Reviewer 2", tool: "claude", model: "sonnet", status: "working" },
      { id: "cards", role: "Card runner", tool: "codex", model: "luna", status: "idle" },
    ],
    needsYou: [],
    onTerminal: noop,
    onAgent: noop,
    onOpenFile: noop,
    onSendFixes: async () => null,
    ...extra,
  };
}

describe("ReviewPage findings", () => {
  test("group by status, disputed first, empty groups left out", () => {
    render(<ReviewPage {...props()} />);
    const heads = Array.from(document.querySelectorAll("[data-group]")).map((e) => e.getAttribute("data-group"));
    expect(heads).toEqual(["disputed", "open", "accepted", "rejected"]);
    cleanup();
    // props() always holds four findings, so index 0 exists.
    render(<ReviewPage {...props({ findings: [props().findings[0]!] })} />);
    expect(Array.from(document.querySelectorAll("[data-group]")).map((e) => e.getAttribute("data-group"))).toEqual(["accepted"]);
  });

  test("a disputed finding shows both sides", () => {
    render(<ReviewPage {...props()} />);
    const f = document.querySelector('[data-finding="2"]') as HTMLElement;
    expect(f.textContent).toContain("Index migration locks the table");
    expect(f.textContent).toContain("Reviewer 2");
    expect(f.textContent).toContain("Reviewer 1: 4,000 rows, the lock is under 1 second");
  });

  test("severity shows as a label", () => {
    render(<ReviewPage {...props()} />);
    const f = document.querySelector('[data-finding="1"]') as HTMLElement;
    expect(within(f).getByText("high")).toBeTruthy();
  });

  test("where is a link that opens the file", () => {
    const onOpenFile = mock((_w: string) => {});
    render(<ReviewPage {...props({ onOpenFile })} />);
    fireEvent.click(screen.getByRole("button", { name: "SearchBox.tsx:41" }));
    expect(onOpenFile).toHaveBeenCalledWith("SearchBox.tsx:41");
  });

  test("a reviewer with nothing shows no findings", () => {
    render(<ReviewPage {...props({ none: ["Reviewer 2"] })} />);
    expect(screen.getByText("Reviewer 2: no findings")).toBeTruthy();
  });

  test("no finding buttons that answer yes or no", () => {
    render(<ReviewPage {...props()} />);
    const names = screen.getAllByRole("button").map((b) => b.textContent);
    for (const bad of ["Accept", "Reject", "Yes", "No"]) expect(names).not.toContain(bad);
  });
});

describe("ReviewPage story cards", () => {
  test("each card shows its result and note", () => {
    render(<ReviewPage {...props()} />);
    const get = (id: string) => (document.querySelector(`[data-card="${id}"]`) as HTMLElement).textContent ?? "";
    expect(get("C1")).toContain("pass");
    expect(get("C2")).toContain("fail");
    expect(get("C2")).toContain("Page says No recipes found");
    expect(get("C3")).toContain("unclear");
    expect(get("C3")).toContain("the test server is down");
    expect(get("C4")).toContain("not run");
    expect(get("C1")).toContain("The row links to the recipe");
  });
});

describe("ReviewPage fixes", () => {
  test("each fix shows where it comes from", () => {
    render(<ReviewPage {...props()} />);
    const x1 = document.querySelector('[data-fix="1"]') as HTMLElement;
    expect(x1.textContent).toContain("Wait 250 ms between requests");
    expect(x1.textContent).toContain("F1");
    expect((document.querySelector('[data-fix="2"]') as HTMLElement).textContent).toContain("Note 2");
  });

  test("Send fixes calls the callback and shows no error when sent", async () => {
    const onSendFixes = mock(async () => null as string | null);
    render(<ReviewPage {...props({ onSendFixes })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send fixes" }));
    });
    expect(onSendFixes).toHaveBeenCalledTimes(1);
    expect(screen.queryByRole("alert")).toBeNull();
  });

  test("a refusal shows as is", async () => {
    render(<ReviewPage {...props({ onSendFixes: async () => "A finding is disputed" })} />);
    await act(async () => {
      fireEvent.click(screen.getByRole("button", { name: "Send fixes" }));
    });
    expect(screen.getByRole("alert").textContent).toBe("A finding is disputed");
  });

  test("Send fixes is off with an empty list and no disputed finding", () => {
    render(<ReviewPage {...props({ fixes: [], findings: [] })} />);
    expect((screen.getByRole("button", { name: "Send fixes" }) as HTMLButtonElement).disabled).toBe(true);
  });

  test("Send fixes stays on while a finding is disputed, so the engine's refusal shows", async () => {
    const onSendFixes = mock(async () => "A finding is disputed" as string | null);
    render(<ReviewPage {...props({ fixes: [], onSendFixes })} />);
    const button = screen.getByRole("button", { name: "Send fixes" }) as HTMLButtonElement;
    expect(button.disabled).toBe(false);
    await act(async () => {
      fireEvent.click(button);
    });
    expect(screen.getByRole("alert").textContent).toBe("A finding is disputed");
  });
});

describe("ReviewPage agents", () => {
  test("each agent has a status and a Terminal button", () => {
    const onTerminal = mock((_id: string) => {});
    const onAgent = mock((_id: string) => {});
    render(<ReviewPage {...props({ onTerminal, onAgent })} />);
    const row = document.querySelector('[data-agent="cards"]') as HTMLElement;
    expect(row.textContent).toContain("Card runner");
    expect(row.textContent).toContain("idle");
    expect(screen.getAllByRole("button", { name: "Terminal" }).length).toBe(3);
    fireEvent.click(within(row).getByRole("button", { name: "Terminal" }));
    expect(onTerminal).toHaveBeenCalledWith("cards");
    fireEvent.click(within(row).getByRole("button", { name: "Card runner" }));
    expect(onAgent).toHaveBeenCalledWith("cards");
  });
});

describe("ReviewPage with no agent", () => {
  test("there is no Agents heading", () => {
    render(<ReviewPage {...props({ agents: [] })} />);
    expect(screen.queryByRole("heading", { name: "Agents" })).toBeNull();
    expect(screen.getByRole("heading", { name: "Findings" })).toBeTruthy();
  });
});

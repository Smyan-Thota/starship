import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen } from "@testing-library/react";
import { usageData } from "../src/adapters.ts";
import { UsageBars, type UsageBarsProps } from "../src/Usage.tsx";

afterEach(cleanup);

const NOW = 1_000_000_000_000;
const H = 3_600_000;

function props(extra: Partial<UsageBarsProps> = {}): UsageBarsProps {
  return {
    tools: [
      {
        tool: "claude",
        windows: [
          { name: "5 hour", usedPct: 40, resetsAt: NOW + 2 * H + 10 * 60_000 },
          { name: "7 day", usedPct: 93, resetsAt: NOW + 50 * H },
        ],
        contextPct: null,
      },
      { tool: "codex", windows: [{ name: "5 hour", usedPct: null, resetsAt: null }], contextPct: 30 },
    ],
    threshold: 90,
    switchOn: true,
    now: NOW,
    moves: [],
    onSwitch: () => {},
    onThreshold: () => {},
    ...extra,
  };
}

const bar = (tool: string, name: string) => document.querySelector(`[data-bar="${tool}|${name}"]`) as HTMLElement;

describe("UsageBars", () => {
  test("one bar per window per tool, with tool, window, percent and reset", () => {
    render(<UsageBars {...props()} />);
    expect(document.querySelectorAll("[data-bar]").length).toBe(3);
    const b = bar("claude", "5 hour");
    expect(b.textContent).toContain("Claude");
    expect(b.textContent).toContain("5 hour");
    expect(b.textContent).toContain("40%");
    expect(b.textContent).toContain("2 h 10 min");
    expect((b.querySelector("i.fill") as HTMLElement).style.width).toBe("40%");
  });

  test("a window past its reset time shows 0", () => {
    render(<UsageBars {...props({ tools: [{ tool: "claude", windows: [{ name: "5 hour", usedPct: 97, resetsAt: NOW - 1000 }], contextPct: null }] })} />);
    const b = bar("claude", "5 hour");
    expect(b.textContent).toContain("0%");
    expect(b.textContent).not.toContain("97");
    expect((b.querySelector("i.fill") as HTMLElement).style.width).toBe("0%");
  });

  test("an unknown number shows unknown and no fill", () => {
    render(<UsageBars {...props()} />);
    const b = bar("codex", "5 hour");
    expect(b.textContent).toContain("unknown");
    expect(b.querySelector("i.fill")).toBeNull();
  });

  test("a mark shows the threshold on each bar", () => {
    render(<UsageBars {...props({ threshold: 75 })} />);
    const marks = document.querySelectorAll("[data-bar] .mark");
    expect(marks.length).toBe(3);
    expect((marks[0] as HTMLElement).style.left).toBe("75%");
  });

  test("a bar at or over the threshold has the hot class", () => {
    render(<UsageBars {...props()} />);
    expect(bar("claude", "7 day").querySelector("i.fill")?.classList.contains("hot")).toBe(true);
    expect(bar("claude", "5 hour").querySelector("i.fill")?.classList.contains("hot")).toBe(false);
    cleanup();
    render(<UsageBars {...props({ threshold: 40 })} />);
    expect(bar("claude", "5 hour").querySelector("i.fill")?.classList.contains("hot")).toBe(true);
  });

  test("the switch setting calls onSwitch", () => {
    const onSwitch = mock((_on: boolean) => {});
    render(<UsageBars {...props({ onSwitch })} />);
    const box = screen.getByRole("checkbox", { name: "Switch" }) as HTMLInputElement;
    expect(box.checked).toBe(true);
    fireEvent.click(box);
    expect(onSwitch).toHaveBeenCalledWith(false);
  });

  test("the threshold is a number field from 50 to 100", () => {
    const onThreshold = mock((_p: number) => {});
    render(<UsageBars {...props({ onThreshold })} />);
    const f = screen.getByRole("spinbutton", { name: "Threshold %" }) as HTMLInputElement;
    expect(f.min).toBe("50");
    expect(f.max).toBe("100");
    expect(f.value).toBe("90");
    fireEvent.change(f, { target: { value: "80" } });
    expect(onThreshold).toHaveBeenCalledWith(80);
    fireEvent.change(f, { target: { value: "20" } });
    expect(onThreshold).toHaveBeenCalledTimes(1);
    expect(screen.getByText("50–100")).toBeTruthy();
  });

  test("moves are plain data lines", () => {
    render(<UsageBars {...props({ moves: [{ at: "15:42", agent: "worker-b", from: "claude", to: "codex" }] })} />);
    expect(screen.getByText("15:42 worker-b claude → codex")).toBeTruthy();
  });
});

describe("UsageBars context", () => {
  test("a context row shows only when the number is known", () => {
    render(<UsageBars {...props()} />);
    expect(document.querySelector('[data-context="claude"]')).toBeNull();
    expect(document.querySelector('[data-context="codex"]')?.textContent).toContain("30%");
    expect(document.body.textContent).not.toContain("context unknown");
    expect(document.body.textContent?.match(/context/g)?.length).toBe(1);
  });

  test("the usage of the engine has no context number, so no tool shows a context row", () => {
    const u = usageData({ tools: [{ tool: "claude", windows: [{ window: "5 hour", usedPct: 12, resetsAt: null, expired: false }], updatedAt: null, stale: false }], moves: [], switchOn: true, thresholdPct: 90 }, NOW);
    render(<UsageBars {...u} onSwitch={() => {}} onThreshold={() => {}} />);
    expect(document.querySelector("[data-context]")).toBeNull();
    expect(document.querySelectorAll("[data-bar]").length).toBe(1);
  });
});

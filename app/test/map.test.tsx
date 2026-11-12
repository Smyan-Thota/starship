import "./setup.ts";
import { afterEach, describe, expect, mock, test } from "bun:test";
import { cleanup, fireEvent, render, screen, within } from "@testing-library/react";
import { layout } from "../src/map/layout.ts";
import { MapPage } from "../src/map/MapPage.tsx";
import type { MapFile } from "../src/map/types.ts";

afterEach(cleanup);

/** Two layers, four boxes, one pipe of each kind, the overview and one flow with three steps. */
function smallMap(order: string[] = ["over", "f1"]): MapFile {
  return {
    name: "demo",
    layers: [
      ["Top layer", "where people work"],
      ["Bottom layer", "servers and stores"],
    ],
    boxes: [
      { id: "a", layer: 0, row: 0, left: 0.04, right: 0.96, name: "Alpha App", what: "The screen people use.", dir: "demo/app", chips: ["Search", "~shared/lib", "Settings"] },
      { id: "b", layer: 1, row: 1, left: 0.04, right: 0.45, name: "Beta API", what: "Answers the app.", dir: "demo/api", chips: ["handler"] },
      { id: "c", layer: 1, row: 1, left: 0.55, right: 0.96, name: "Gamma DB", what: "Keeps the records.", dir: "demo/db", chips: ["#Table", "#Index"], store: true },
      { id: "d", layer: 1, row: 2, left: 0.04, right: 0.96, name: "Delta Worker", what: "Runs the jobs.", dir: "demo/worker", chips: ["job"], tag: "we build" },
    ],
    pipes: [
      { id: "a-b", from: "a", to: "b", kind: "call", label: "ask the api", route: { x: 0.2 } },
      { id: "b-c", from: "b", to: "c", kind: "lookup", label: "read rows", route: { across: true } },
      { id: "c-d", from: "c", to: "d", kind: "event", label: "row changed", route: { x: 0.7, toX: 0.6 } },
    ],
    flows: {
      over: { name: "Overview" },
      f1: {
        name: "This flow",
        story: "Someone searches and sees the matches.",
        paths: [{ n: 1, name: "Search", who: "person", trigger: "Someone types a word", entry: "query · searchThing", after: "Nothing is saved." }],
        steps: [
          { n: "1.1", pipe: "a-b", label: "search('x')", text: "The app sends the query.", where: "Beta API · handler" },
          { n: "1.2", pipe: "b-c", dir: "both", label: "match rows", text: "One query matches the rows.", where: "Gamma DB · Table" },
          { n: "1.3", pipe: "a-b", dir: "rev", label: "3 results", text: "The list shows the matches.", where: "Alpha App · Search" },
        ],
        lit: { a: ["Search"], b: ["handler"], c: ["Table"] },
        marks: { "a|Search": "changed" },
      },
    },
    order,
  };
}

const noop = () => {};

describe("layout", () => {
  test("no two boxes overlap, and every box stays inside the map", () => {
    for (const width of [1000, 1400, 2000]) {
      const l = layout(smallMap(), { width });
      expect(l.boxes.length).toBe(4);
      for (const a of l.boxes) {
        expect(a.x).toBeGreaterThanOrEqual(0);
        expect(a.x + a.w).toBeLessThanOrEqual(width);
        expect(a.y + a.h).toBeLessThanOrEqual(l.height);
        for (const b of l.boxes) {
          if (a.id >= b.id) continue;
          const apart = a.x + a.w <= b.x || b.x + b.w <= a.x || a.y + a.h <= b.y || b.y + b.h <= a.y;
          expect(apart).toBe(true);
        }
      }
    }
  });

  test("measured heights replace the estimate, and rows stay in order", () => {
    const map = smallMap();
    const l = layout(map, { width: 1200, heights: { a: 300, b: 80, c: 120, d: 60 } });
    const by = Object.fromEntries(l.boxes.map((b) => [b.id, b] as const));
    expect(by.a?.h).toBe(300);
    expect(by.b?.h).toBe(120);
    expect(by.c?.h).toBe(120);
    expect((by.a?.y ?? 0) + 300).toBeLessThan(by.b?.y ?? 0);
    expect((by.b?.y ?? 0) + 120).toBeLessThan(by.d?.y ?? 0);
  });

  test("a band holds the boxes of its layer, and the bands do not overlap", () => {
    const l = layout(smallMap(), { width: 1200 });
    expect(l.bands.map((b) => b.layer)).toEqual([0, 1]);
    const [top, bottom] = l.bands;
    expect(top && bottom && top.y + top.h <= bottom.y).toBe(true);
    for (const b of l.boxes) {
      const band = l.bands.find((x) => x.layer === (b.id === "a" ? 0 : 1));
      expect(band && b.y >= band.y && b.y + b.h <= band.y + band.h).toBe(true);
    }
  });

  test("each pipe gets a path from its source box to its target box", () => {
    const l = layout(smallMap(), { width: 1200 });
    expect(l.pipes.map((p) => p.id)).toEqual(["a-b", "b-c", "c-d"]);
    const by = Object.fromEntries(l.boxes.map((b) => [b.id, b] as const));
    const ab = l.pipes.find((p) => p.id === "a-b");
    const a = by.a;
    const b = by.b;
    expect(ab?.points[0]?.[1]).toBe((a?.y ?? 0) + (a?.h ?? 0));
    expect(ab?.points.at(-1)?.[1]).toBe(b?.y);
    const bc = l.pipes.find((p) => p.id === "b-c");
    expect(bc?.points.length).toBe(2);
    expect(bc?.points[0]?.[1]).toBe(bc?.points[1]?.[1]);
    const cd = l.pipes.find((p) => p.id === "c-d");
    expect(cd?.points.length).toBe(4);
  });

  test("the steps of a flow make room between the rows", () => {
    const map = smallMap();
    const flat = layout(map, { width: 1200 });
    const busy = layout(map, { width: 1200, flow: map.flows.f1 });
    expect(busy.height).toBeGreaterThan(flat.height);
  });
});

describe("MapPage", () => {
  test("every box name and every chip shows", () => {
    render(<MapPage map={smallMap()} flow="over" onFlow={noop} />);
    for (const name of ["Alpha App", "Beta API", "Gamma DB", "Delta Worker"]) expect(screen.getByText(name)).toBeTruthy();
    for (const chip of ["Search", "shared/lib", "Settings", "handler", "Table", "Index", "job"]) expect(screen.getByText(chip)).toBeTruthy();
    expect(screen.getByText("The screen people use.")).toBeTruthy();
    expect(screen.getByText("demo/worker")).toBeTruthy();
    expect(screen.getByText("we build")).toBeTruthy();
  });

  test("a shared package and a store look different from a plain chip", () => {
    const { container } = render(<MapPage map={smallMap()} flow="over" onFlow={noop} />);
    expect(screen.getByText("shared/lib").className).toContain("shared");
    expect(screen.getByText("Search").className).not.toContain("shared");
    expect(within(screen.getByText("Table")).queryByText("~")).toBeNull();
    expect(container.querySelector(".map-chip.store svg")).toBeTruthy();
  });

  test("layers show as bands with their name and note", () => {
    render(<MapPage map={smallMap()} flow="over" onFlow={noop} />);
    expect(screen.getByText("Top layer")).toBeTruthy();
    expect(screen.getByText("where people work")).toBeTruthy();
    expect(screen.getByText("Bottom layer")).toBeTruthy();
  });

  test("one SVG path per pipe, with a class for its kind", () => {
    const { container } = render(<MapPage map={smallMap()} flow="over" onFlow={noop} />);
    const paths = [...container.querySelectorAll("svg.map-pipes path.pipe")];
    expect(paths.length).toBe(3);
    expect(paths.map((p) => p.getAttribute("class"))).toEqual(["pipe pipe-call", "pipe pipe-lookup", "pipe pipe-event"]);
    expect(paths.map((p) => p.getAttribute("data-pipe"))).toEqual(["a-b", "b-c", "c-d"]);
    for (const p of paths) expect(p.getAttribute("d")).toMatch(/^M[\d.]+,[\d.]+L/);
  });

  test("each pipe shows its label in the overview, and no pill", () => {
    const { container } = render(<MapPage map={smallMap()} flow="over" onFlow={noop} />);
    for (const label of ["ask the api", "read rows", "row changed"]) expect(screen.getByText(label)).toBeTruthy();
    expect(container.querySelectorAll(".map-num").length).toBe(0);
    expect(container.querySelector(".map-steps")).toBeNull();
    expect(container.querySelector(".map-paths")).toBeNull();
    expect(container.querySelectorAll(".map-chip.dim").length).toBe(0);
    expect(container.querySelectorAll(".map-box.dim").length).toBe(0);
  });

  test("the tabs follow map.order and mark the open flow", () => {
    const { rerender } = render(<MapPage map={smallMap(["over", "f1"])} flow="over" onFlow={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["Overview", "This flow"]);
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(screen.getByRole("tab", { name: "This flow" }).getAttribute("aria-selected")).toBe("false");
    rerender(<MapPage map={smallMap(["f1", "over"])} flow="f1" onFlow={noop} />);
    expect(screen.getAllByRole("tab").map((t) => t.textContent)).toEqual(["This flow", "Overview"]);
    expect(screen.getByRole("tab", { name: "This flow" }).getAttribute("aria-selected")).toBe("true");
  });

  test("choosing a flow calls onFlow with its id", () => {
    const onFlow = mock((_id: string) => {});
    render(<MapPage map={smallMap()} flow="over" onFlow={onFlow} />);
    fireEvent.click(screen.getByRole("tab", { name: "This flow" }));
    expect(onFlow).toHaveBeenCalledTimes(1);
    expect(onFlow.mock.calls[0]?.[0]).toBe("f1");
  });

  test("a flow with steps shows its pills and its step table", () => {
    const { container } = render(<MapPage map={smallMap()} flow="f1" onFlow={noop} />);
    const pills = [...container.querySelectorAll(".map-stage .map-pill .map-num")].map((n) => n.textContent);
    expect(pills.sort()).toEqual(["1.1", "1.2", "1.3"]);
    const table = container.querySelector(".map-steps") as HTMLElement;
    expect(table).toBeTruthy();
    const rows = table.querySelectorAll(".map-step");
    expect(rows.length).toBe(3);
    const first = within(rows[0] as HTMLElement);
    expect(first.getByText("1.1")).toBeTruthy();
    expect(first.getByText("search('x')")).toBeTruthy();
    expect(first.getByText("The app sends the query.")).toBeTruthy();
    expect(first.getByText("Beta API · handler")).toBeTruthy();
    expect(first.getByText("Alpha App → Beta API")).toBeTruthy();
    expect(within(rows[1] as HTMLElement).getByText("Beta API ⇄ Gamma DB")).toBeTruthy();
    expect(within(rows[2] as HTMLElement).getByText("Beta API → Alpha App")).toBeTruthy();
  });

  test("a flow shows its story and its path cards", () => {
    render(<MapPage map={smallMap()} flow="f1" onFlow={noop} />);
    expect(screen.getByText("Someone searches and sees the matches.")).toBeTruthy();
    expect(screen.getByText("Search", { selector: ".map-path .map-path-name" })).toBeTruthy();
    expect(screen.getByText("Someone types a word")).toBeTruthy();
    expect(screen.getByText("query · searchThing")).toBeTruthy();
    expect(screen.getByText("Nothing is saved.")).toBeTruthy();
  });

  test("lit chips are highlighted, the others are dimmed, and a mark shows as a word", () => {
    const { container } = render(<MapPage map={smallMap()} flow="f1" onFlow={noop} />);
    const chip = (name: string) => [...container.querySelectorAll(".map-chip")].find((c) => c.firstChild?.textContent === name || c.textContent?.startsWith(name)) as HTMLElement;
    expect(chip("Search").className).toContain("lit");
    expect(chip("handler").className).toContain("lit");
    expect(chip("Table").className).toContain("lit");
    expect(chip("Settings").className).toContain("dim");
    expect(chip("Index").className).toContain("dim");
    expect(chip("job").className).toContain("dim");
    expect(within(chip("Search")).getByText("changed")).toBeTruthy();
    // The box that no step and no lit chip touches is dimmed.
    expect((container.querySelector('[data-box="d"]') as HTMLElement).className).toContain("dim");
    expect((container.querySelector('[data-box="a"]') as HTMLElement).className).not.toContain("dim");
  });

  test("pipes without a step are dimmed in a flow, and direction shows as arrowheads", () => {
    const { container } = render(<MapPage map={smallMap()} flow="f1" onFlow={noop} />);
    const path = (id: string) => container.querySelector(`path.pipe[data-pipe="${id}"]`) as Element;
    expect(path("c-d").getAttribute("class")).toContain("off");
    expect(path("a-b").getAttribute("class")).toContain("on");
    // a-b has a forward step and a reverse step: both ends have an arrowhead.
    expect(path("a-b").getAttribute("marker-end")).toBeTruthy();
    expect(path("a-b").getAttribute("marker-start")).toBeTruthy();
    // b-c is "both".
    expect(path("b-c").getAttribute("marker-start")).toBeTruthy();
    expect(path("b-c").getAttribute("marker-end")).toBeTruthy();
  });

  test("the key explains the three line kinds", () => {
    const { container } = render(<MapPage map={smallMap()} flow="over" onFlow={noop} />);
    const key = within(container.querySelector(".map-key") as HTMLElement);
    for (const word of ["Key", "Call", "Lookup", "Event"]) expect(key.getByText(word)).toBeTruthy();
    expect(container.querySelectorAll(".map-key path.ln-call, .map-key path.ln-lookup, .map-key path.ln-event").length).toBe(3);
  });

  test("an unknown flow falls back to the first tab", () => {
    const { container } = render(<MapPage map={smallMap()} flow="missing" onFlow={noop} />);
    expect(screen.getByRole("tab", { name: "Overview" }).getAttribute("aria-selected")).toBe("true");
    expect(container.querySelector(".map-steps")).toBeNull();
  });
});

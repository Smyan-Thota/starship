/** The layout math of the map page. Pure: no DOM. */
import type { MapBox, MapFile, MapFlow, MapPipe } from "./types.ts";

/** Space left and right of the boxes. The margin pipes run in it. */
export const PAD = 52;
/** The height of one pill, and the step between two stacked pills. */
export const SLOT = 24;
const TOP_GAP = 14;
const BOTTOM_PAD = 36;
const MIN_BOX = 48;

export interface LayoutSize {
  /** The width of the map in pixels. */
  width: number;
  /** The measured height of each box by id. A box without one gets an estimate. */
  heights?: Record<string, number>;
  /** The open flow. Its steps make room for their pills between the rows. */
  flow?: MapFlow;
}

export interface PlacedBox {
  id: string;
  x: number;
  y: number;
  w: number;
  h: number;
  /** The index of the box's line, from the top. */
  row: number;
}

export interface PlacedBand {
  layer: number;
  name: string;
  note: string;
  y: number;
  h: number;
}

export interface Anchor {
  x: number;
  y: number;
  /** 1: the pills stack downward from y. -1: upward. */
  dir: 1 | -1;
  align: "l" | "r" | "c";
}

export interface PlacedPipe {
  id: string;
  points: [number, number][];
  /** The SVG path data. */
  d: string;
  anchor: Anchor;
}

export interface MapLayout {
  width: number;
  height: number;
  boxes: PlacedBox[];
  bands: PlacedBand[];
  pipes: PlacedPipe[];
}

/** How the inside of a box splits: name and text on the left, chips on the right. */
export function boxShape(box: Pick<MapBox, "left" | "right">): "nar" | "half" | "wide" {
  const f = box.right - box.left;
  return f < 0.3 ? "nar" : f < 0.6 ? "half" : "wide";
}

const SHAPE_COLUMN = { nar: 1, half: 0.46, wide: 0.36 } as const;

/** A guess of a box's height, for the first paint. The page replaces it with the measured height. */
export function estimateHeight(box: MapBox, boxWidth: number): number {
  const shape = boxShape(box);
  const frac = SHAPE_COLUMN[shape];
  const leftW = Math.max(40, boxWidth * frac - 24);
  const whatLines = Math.max(1, Math.ceil((box.what.length * 6.4) / leftW));
  const left = 10 + 22 + 3 + whatLines * 17.5 + 8 + (box.dir ? 15 : 0) + 10;
  if (box.chips.length === 0) return Math.max(MIN_BOX, left);
  const rightW = Math.max(40, shape === "nar" ? boxWidth - 24 : boxWidth * (1 - frac) - 24);
  let lines = 1;
  let used = 0;
  for (const chip of box.chips) {
    const w = chip.length * 6.6 + 14;
    if (used > 0 && used + w + 5 > rightW) {
      lines++;
      used = 0;
    }
    used += w + 5;
  }
  const right = 20 + lines * 21 + (lines - 1) * 5;
  return Math.max(MIN_BOX, shape === "nar" ? left + right : Math.max(left, right));
}

/** The space above each row. Index 0 is the top of the map. A gap grows with the pills that sit in it. */
function gapsFor(map: MapFile, rowOf: Map<string, number>, rows: number, flow: MapFlow | undefined): number[] {
  const need: number[] = Array.from({ length: rows }, () => 1);
  const count: Record<string, number> = {};
  for (const s of flow?.steps ?? []) count[s.pipe] = (count[s.pipe] ?? 0) + 1;
  for (const p of map.pipes) {
    if (p.route.across) continue;
    const ra = rowOf.get(p.from);
    const rb = rowOf.get(p.to);
    if (ra === undefined || rb === undefined) continue;
    const gap = rb > ra ? ra + 1 : ra;
    let c = flow?.steps ? (count[p.id] ?? 0) : 1;
    if (c && p.route.side && rb > ra) c += p.route.lane ?? 1;
    if (gap < rows) need[gap] = Math.max(need[gap] ?? 1, c);
  }
  return need.map((c, i) => (i === 0 ? TOP_GAP : 56 + SLOT * c));
}

const pt = (n: number) => n.toFixed(1);

function pathData(points: [number, number][]): string {
  return `M${points.map(([x, y]) => `${pt(x)},${pt(y)}`).join("L")}`;
}

function placePipe(p: MapPipe, a: PlacedBox, b: PlacedBox, width: number): PlacedPipe {
  const X = (f: number) => PAD + f * (width - 2 * PAD);
  const am = a.y + a.h / 2;
  const bm = b.y + b.h / 2;
  const down = b.y > a.y;
  const r = p.route;
  let points: [number, number][];
  let anchor: Anchor;
  if (r.side) {
    const left = r.side === "L";
    const lane = r.lane ?? 1;
    const gx = left ? PAD - 14 - (lane - 1) * 16 : width - PAD + 14 + (lane - 1) * 16;
    // The lanes enter the target one below the other, so two pipes do not share the last stretch.
    const room = Math.max(0, b.h / 2 - 8);
    const dy = Math.max(-room, Math.min(room, (lane - 1) * 28 - 14));
    const yb = bm + dy;
    points = [
      [left ? a.x : a.x + a.w, am],
      [gx, am],
      [gx, yb],
      [left ? b.x : b.x + b.w, yb],
    ];
    anchor = { x: left ? a.x + 4 : a.x + a.w - 4, y: down ? a.y + a.h + 8 + SLOT * lane : a.y - 29, dir: down ? 1 : -1, align: left ? "l" : "r" };
  } else if (r.across) {
    const ltr = a.x < b.x;
    const x1 = ltr ? a.x + a.w : a.x;
    const x2 = ltr ? b.x : b.x + b.w;
    points = [
      [x1, am],
      [x2, am],
    ];
    anchor = { x: (x1 + x2) / 2, y: am - 27, dir: -1, align: "c" };
  } else {
    // Without an x the line runs through the middle of the part where the two boxes face each other.
    const lo = Math.max(a.x, b.x);
    const hi = Math.min(a.x + a.w, b.x + b.w);
    const x = r.x !== undefined ? X(r.x) : lo < hi ? (lo + hi) / 2 : a.x + a.w / 2;
    const tx = r.toX !== undefined ? X(r.toX) : x;
    if (down) {
      points =
        tx === x
          ? [
              [x, a.y + a.h],
              [x, b.y],
            ]
          : [
              [x, a.y + a.h],
              [x, b.y - 22],
              [tx, b.y - 22],
              [tx, b.y],
            ];
      anchor = { x: x + 8, y: a.y + a.h + 8, dir: 1, align: "l" };
    } else {
      points =
        tx === x
          ? [
              [x, a.y],
              [x, b.y + b.h],
            ]
          : [
              [x, a.y],
              [x, b.y + b.h + 22],
              [tx, b.y + b.h + 22],
              [tx, b.y + b.h],
            ];
      anchor = { x: x + 8, y: a.y - 29, dir: -1, align: "l" };
    }
  }
  return { id: p.id, points, d: pathData(points), anchor };
}

/** Where every box, band and pipe goes, for a map of this width. */
export function layout(map: MapFile, size: LayoutSize): MapLayout {
  const { width } = size;
  const inner = width - 2 * PAD;
  const rowNumbers = [...new Set(map.boxes.map((b) => b.row))].sort((a, b) => a - b);
  const rowIndex = new Map(rowNumbers.map((r, i) => [r, i] as const));
  const rowOf = new Map(map.boxes.map((b) => [b.id, rowIndex.get(b.row) ?? 0] as const));
  const gaps = gapsFor(map, rowOf, rowNumbers.length, size.flow);

  const placed: PlacedBox[] = [];
  let y = 0;
  rowNumbers.forEach((rowNumber, ri) => {
    const inRow = map.boxes.filter((b) => b.row === rowNumber);
    // The boxes of one row are as tall as the tallest of them.
    const h = Math.max(MIN_BOX, ...inRow.map((b) => size.heights?.[b.id] ?? estimateHeight(b, (b.right - b.left) * inner)));
    y += gaps[ri] ?? 0;
    for (const b of inRow) placed.push({ id: b.id, x: PAD + b.left * inner, y, w: (b.right - b.left) * inner, h, row: ri });
    y += h;
  });
  const height = y + BOTTOM_PAD;

  const byId = new Map(placed.map((b) => [b.id, b] as const));
  const bands: PlacedBand[] = [];
  map.layers.forEach(([name, note], layer) => {
    const mine = map.boxes.filter((b) => b.layer === layer).flatMap((b) => byId.get(b.id) ?? []);
    if (mine.length === 0) return;
    const top = Math.min(...mine.map((b) => b.y)) - 12;
    const bottom = Math.max(...mine.map((b) => b.y + b.h)) + 30;
    bands.push({ layer, name, note, y: top, h: bottom - top });
  });

  const pipes: PlacedPipe[] = [];
  for (const p of map.pipes) {
    const a = byId.get(p.from);
    const b = byId.get(p.to);
    if (a && b) pipes.push(placePipe(p, a, b, width));
  }
  return { width, height, boxes: placed, bands, pipes };
}

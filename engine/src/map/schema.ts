/**
 * The map file: layers, boxes, pipes and flows. See PLAN.md, "Map format".
 *
 * `validateMap` lists every problem as one plain line. An empty list means the map is valid.
 * `readMapFile` reads and checks a file, and never throws for a bad one.
 */
import { readFileSync } from "node:fs";

export interface MapFile {
  name: string;
  layers: [name: string, note: string][];
  boxes: MapBox[];
  pipes: MapPipe[];
  flows: Record<string, MapFlow>;
  order: string[];
  /** `low` when the map came from folders and a README, not from a code index. */
  detail?: "low";
}

export interface MapBox {
  id: string;
  layer: number;
  row: number;
  left: number;
  right: number;
  name: string;
  what: string;
  dir: string;
  chips: string[];
  store?: boolean;
  off?: boolean;
  tag?: string;
}

export interface MapPipe {
  id: string;
  from: string;
  to: string;
  kind: "call" | "lookup" | "event";
  label: string;
  route: { x?: number; toX?: number; side?: "L" | "R"; lane?: number; across?: boolean };
}

export interface MapFlow {
  name: string;
  story?: string;
  paths?: MapPath[];
  steps?: MapStep[];
  lit?: Record<string, string[]>;
  marks?: Record<string, string>;
}

export interface MapPath {
  n: number;
  name: string;
  who: "person" | "clock" | "auto";
  trigger: string;
  entry: string;
  after: string;
}

export interface MapStep {
  n: string;
  pipe: string;
  dir?: "rev" | "both";
  label: string;
  text: string;
  where: string;
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";
const isNum = (v: unknown): v is number => typeof v === "number" && Number.isFinite(v);
const isTextList = (v: unknown): v is string[] => Array.isArray(v) && v.every(isText);

type Boxes = ReadonlyMap<string, string[]>;

/** Box id to its chips, for the boxes that have an id and a list of chips. */
export function chipIndex(boxes: unknown): Boxes {
  const out = new Map<string, string[]>();
  if (!Array.isArray(boxes)) return out;
  for (const b of boxes) if (isRecord(b) && isText(b.id) && isTextList(b.chips)) out.set(b.id, b.chips);
  return out;
}

/** Box id to chips for a typed map. */
const indexOf = (map: Pick<MapFile, "boxes">): Boxes => chipIndex(map.boxes);

/** Problems with a `lit` table. Each line starts with `lit`. A line is not prefixed with the flow. */
export function litProblems(boxes: Boxes, lit: Record<string, string[]>): string[] {
  const out: string[] = [];
  for (const [box, chips] of Object.entries(lit)) {
    const have = boxes.get(box);
    if (!have) {
      out.push(`lit names the box "${box}", which does not exist`);
      continue;
    }
    for (const c of chips) if (!have.includes(c)) out.push(`lit chip "${c}" is not on box ${box}`);
  }
  return out;
}

/** Problems with a `marks` table. */
export function markProblems(boxes: Boxes, marks: Record<string, string>): string[] {
  const out: string[] = [];
  for (const key of Object.keys(marks)) {
    const at = key.indexOf("|");
    if (at < 1) {
      out.push(`mark "${key}" is not <box>|<chip>`);
      continue;
    }
    const box = key.slice(0, at);
    const chip = key.slice(at + 1);
    const have = boxes.get(box);
    if (!have || !have.includes(chip)) out.push(`mark "${key}" does not name a chip of a box`);
  }
  return out;
}

/** Problems with a list of steps: each step's pipe must be a pipe id. */
export function stepProblems(pipeIds: ReadonlySet<string>, steps: MapStep[]): string[] {
  const out: string[] = [];
  for (const s of steps) if (!pipeIds.has(s.pipe)) out.push(`step ${s.n} names the pipe "${s.pipe}", which does not exist`);
  return out;
}

function checkRoute(label: string, r: unknown, out: string[]): void {
  if (!isRecord(r)) {
    out.push(`${label}: route must be an object`);
    return;
  }
  for (const k of ["x", "toX", "lane"] as const) if (r[k] !== undefined && !isNum(r[k])) out.push(`${label}: route ${k} must be a number`);
  if (r.side !== undefined && r.side !== "L" && r.side !== "R") out.push(`${label}: route side must be L or R`);
  if (r.across !== undefined && typeof r.across !== "boolean") out.push(`${label}: route across must be true or false`);
}

function checkBox(b: unknown, i: number, layerCount: number, out: string[]): string | null {
  if (!isRecord(b)) {
    out.push(`box ${i}: must be an object`);
    return null;
  }
  const id = isText(b.id) && b.id !== "" ? b.id : null;
  if (id === null) out.push(`box ${i}: id must be a text`);
  const L = id === null ? `box ${i}` : `box ${id}`;
  for (const k of ["name", "what", "dir"] as const) if (!isText(b[k])) out.push(`${L}: ${k} must be a text`);
  if (!isTextList(b.chips)) out.push(`${L}: chips must be a list of text`);
  if (!isNum(b.row)) out.push(`${L}: row must be a number`);
  for (const k of ["store", "off"] as const) if (b[k] !== undefined && typeof b[k] !== "boolean") out.push(`${L}: ${k} must be true or false`);
  if (b.tag !== undefined && !isText(b.tag)) out.push(`${L}: tag must be a text`);
  if (!isNum(b.layer)) out.push(`${L}: layer must be a number`);
  else if (!Number.isInteger(b.layer) || b.layer < 0 || b.layer >= layerCount) out.push(`${L}: layer ${b.layer} is not an index of layers`);
  let edges = true;
  for (const k of ["left", "right"] as const) {
    const v = b[k];
    if (!isNum(v)) {
      out.push(`${L}: ${k} must be a number`);
      edges = false;
    } else if (v < 0 || v > 1) {
      out.push(`${L}: ${k} must be from 0 to 1`);
      edges = false;
    }
  }
  if (edges && isNum(b.left) && isNum(b.right) && b.left >= b.right) out.push(`${L}: left must be below right`);
  return id;
}

function checkFlow(key: string, f: unknown, boxes: Boxes, pipeIds: ReadonlySet<string>, out: string[]): void {
  const L = `flow ${key}`;
  if (!isRecord(f)) {
    out.push(`${L}: must be an object`);
    return;
  }
  if (!isText(f.name)) out.push(`${L}: name must be a text`);
  if (f.story !== undefined && !isText(f.story)) out.push(`${L}: story must be a text`);
  if (f.paths !== undefined) {
    if (!Array.isArray(f.paths)) out.push(`${L}: paths must be a list`);
    else
      f.paths.forEach((p: unknown, i: number) => {
        if (!isRecord(p)) {
          out.push(`${L}: path ${i} must be an object`);
          return;
        }
        const P = `${L}: path ${isNum(p.n) ? p.n : i}`;
        if (!isNum(p.n)) out.push(`${P}: n must be a number`);
        for (const k of ["name", "trigger", "entry", "after"] as const) if (!isText(p[k])) out.push(`${P}: ${k} must be a text`);
        if (p.who !== "person" && p.who !== "clock" && p.who !== "auto") out.push(`${P}: who must be person, clock or auto`);
      });
  }
  if (f.steps !== undefined) {
    if (!Array.isArray(f.steps)) out.push(`${L}: steps must be a list`);
    else
      f.steps.forEach((s: unknown, i: number) => {
        if (!isRecord(s)) {
          out.push(`${L}: step ${i} must be an object`);
          return;
        }
        const S = `${L}: step ${isText(s.n) ? s.n : i}`;
        for (const k of ["n", "pipe", "label", "text", "where"] as const) if (!isText(s[k])) out.push(`${S}: ${k} must be a text`);
        if (s.dir !== undefined && s.dir !== "rev" && s.dir !== "both") out.push(`${S}: dir must be rev or both`);
        if (isText(s.pipe) && !pipeIds.has(s.pipe)) out.push(`${L}: ${stepProblems(pipeIds, [{ n: isText(s.n) ? s.n : String(i), pipe: s.pipe, label: "", text: "", where: "" }])[0]}`);
      });
  }
  if (f.lit !== undefined) {
    if (!isRecord(f.lit) || !Object.values(f.lit).every(isTextList)) out.push(`${L}: lit must map a box id to a list of chips`);
    else for (const p of litProblems(boxes, f.lit as Record<string, string[]>)) out.push(`${L}: ${p}`);
  }
  if (f.marks !== undefined) {
    if (!isRecord(f.marks) || !Object.values(f.marks).every(isText)) out.push(`${L}: marks must map "<box>|<chip>" to a text`);
    else for (const p of markProblems(boxes, f.marks as Record<string, string>)) out.push(`${L}: ${p}`);
  }
}

/** Every problem in a map, one plain line each. An empty list means the map is valid. */
export function validateMap(value: unknown): string[] {
  const out: string[] = [];
  if (!isRecord(value)) return ["the map must be an object"];
  const m = value;
  if (!isText(m.name) || m.name === "") out.push("name must be a text");
  if (m.detail !== undefined && m.detail !== "low") out.push('detail must be "low" when it is present');

  let layerCount = 0;
  if (!Array.isArray(m.layers)) out.push("layers must be a list");
  else {
    layerCount = m.layers.length;
    m.layers.forEach((l: unknown, i: number) => {
      if (!Array.isArray(l) || l.length !== 2 || !isText(l[0]) || !isText(l[1])) out.push(`layer ${i}: must be [name, note], both text`);
    });
  }

  const boxIds = new Set<string>();
  if (!Array.isArray(m.boxes)) out.push("boxes must be a list");
  else
    m.boxes.forEach((b: unknown, i: number) => {
      const id = checkBox(b, i, layerCount, out);
      if (id === null) return;
      if (boxIds.has(id)) out.push(`duplicate box id "${id}"`);
      boxIds.add(id);
    });

  const pipeIds = new Set<string>();
  if (!Array.isArray(m.pipes)) out.push("pipes must be a list");
  else
    m.pipes.forEach((p: unknown, i: number) => {
      if (!isRecord(p)) {
        out.push(`pipe ${i}: must be an object`);
        return;
      }
      const id = isText(p.id) && p.id !== "" ? p.id : null;
      if (id === null) out.push(`pipe ${i}: id must be a text`);
      const L = id === null ? `pipe ${i}` : `pipe ${id}`;
      if (id !== null) {
        if (pipeIds.has(id)) out.push(`duplicate pipe id "${id}"`);
        pipeIds.add(id);
      }
      if (!isText(p.label)) out.push(`${L}: label must be a text`);
      if (p.kind !== "call" && p.kind !== "lookup" && p.kind !== "event") out.push(`${L}: kind must be call, lookup or event`);
      for (const k of ["from", "to"] as const) {
        const v = p[k];
        if (!isText(v)) out.push(`${L}: ${k} must be a text`);
        else if (!boxIds.has(v)) out.push(`${L}: ${k} names the box "${v}", which does not exist`);
      }
      checkRoute(L, p.route, out);
    });

  const boxes = indexOf({ boxes: Array.isArray(m.boxes) ? (m.boxes as MapBox[]) : [] });
  let flowKeys: string[] = [];
  if (!isRecord(m.flows)) out.push("flows must be an object");
  else {
    flowKeys = Object.keys(m.flows);
    if (!flowKeys.includes("over")) out.push('flow "over" is missing');
    for (const k of flowKeys) checkFlow(k, m.flows[k], boxes, pipeIds, out);
  }

  if (!isTextList(m.order)) out.push("order must be a list of text");
  else if (isRecord(m.flows)) for (const k of m.order) if (!flowKeys.includes(k)) out.push(`order names "${k}", which is not a flow`);
  return out;
}

/** Keys that appear twice in one object of the flows table. JSON.parse keeps only the last, so the text is scanned. */
export function duplicateFlowKeys(text: string): string[] {
  const dups: string[] = [];
  type Frame = { kind: "obj" | "arr"; path: string; keys: Set<string>; last: string };
  const stack: Frame[] = [];
  let i = 0;
  const n = text.length;
  while (i < n) {
    const c = text[i] as string;
    if (c === '"') {
      let j = i + 1;
      let s = "";
      while (j < n && text[j] !== '"') {
        if (text[j] === "\\") {
          s += text.slice(j, j + 2);
          j += 2;
        } else s += text.charAt(j++);
      }
      i = j + 1;
      let k = i;
      while (k < n && /\s/.test(text[k] as string)) k++;
      const top = stack[stack.length - 1];
      if (text[k] === ":" && top && top.kind === "obj") {
        if (top.path === "flows") {
          if (top.keys.has(s)) dups.push(s);
          top.keys.add(s);
        }
        top.last = s;
      }
      continue;
    }
    if (c === "{" || c === "[") {
      const top = stack[stack.length - 1];
      const path = top === undefined ? "" : top.kind === "obj" ? (top.path === "" ? top.last : `${top.path}/${top.last}`) : `${top.path}/[]`;
      stack.push({ kind: c === "{" ? "obj" : "arr", path: top === undefined ? "" : path, keys: new Set(), last: "" });
    } else if (c === "}" || c === "]") stack.pop();
    i++;
  }
  return dups;
}

/** Reads a map file and checks it. A bad file gives `map: null` and the errors. It never throws. */
export function readMapFile(path: string): { map: MapFile | null; errors: string[] } {
  let text: string;
  try {
    text = readFileSync(path, "utf8");
  } catch (e) {
    return { map: null, errors: [`cannot read ${path}: ${e instanceof Error ? e.message : String(e)}`] };
  }
  let value: unknown;
  try {
    value = JSON.parse(text);
  } catch {
    return { map: null, errors: [`${path} is not valid JSON`] };
  }
  const errors = validateMap(value);
  for (const k of duplicateFlowKeys(text)) errors.push(`duplicate flow key "${k}"`);
  if (errors.length > 0) return { map: null, errors };
  // validateMap proved the shape.
  return { map: value as MapFile, errors: [] };
}

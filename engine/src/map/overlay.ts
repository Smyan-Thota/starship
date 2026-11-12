/**
 * The plan overlay: `<featureFolder>/run/map-overlay.json`. It adds one flow, "This plan", to the repo's map.
 * An entry that names a box, a chip or a pipe that does not exist is an error, and that entry is left out.
 */
import { existsSync, readFileSync } from "node:fs";
import { join } from "node:path";
import { type MapFile, type MapFlow, type MapStep, chipIndex } from "./schema.ts";

export interface MapOverlay {
  name?: string;
  story?: string;
  lit: Record<string, string[]>;
  marks?: Record<string, string>;
  steps?: MapStep[];
}

const isRecord = (v: unknown): v is Record<string, unknown> => typeof v === "object" && v !== null && !Array.isArray(v);
const isText = (v: unknown): v is string => typeof v === "string";

export function overlayShape(v: unknown): string[] {
  if (!isRecord(v)) return ["the overlay must be an object"];
  const out: string[] = [];
  if (v.name !== undefined && !isText(v.name)) out.push("name must be a text");
  if (v.story !== undefined && !isText(v.story)) out.push("story must be a text");
  if (!isRecord(v.lit) || !Object.values(v.lit).every((c) => Array.isArray(c) && c.every(isText))) out.push("lit must map a box id to a list of chips");
  if (v.marks !== undefined && (!isRecord(v.marks) || !Object.values(v.marks).every(isText))) out.push('marks must map "<box>|<chip>" to a text');
  if (v.steps !== undefined) {
    if (!Array.isArray(v.steps)) out.push("steps must be a list");
    else
      v.steps.forEach((s: unknown, i: number) => {
        if (!isRecord(s)) out.push(`step ${i}: must be an object`);
        else {
          for (const k of ["n", "pipe", "label", "text", "where"]) if (!isText(s[k])) out.push(`step ${i}: ${k} must be a text`);
          if (s.dir !== undefined && s.dir !== "rev" && s.dir !== "both") out.push(`step ${i}: dir must be rev or both`);
        }
      });
  }
  return out;
}

/** Reads `run/map-overlay.json`. No file gives `null` and no error. */
export function readOverlay(featureFolder: string): { overlay: MapOverlay | null; errors: string[] } {
  const file = join(featureFolder, "run", "map-overlay.json");
  if (!existsSync(file)) return { overlay: null, errors: [] };
  let value: unknown;
  try {
    value = JSON.parse(readFileSync(file, "utf8"));
  } catch (e) {
    return { overlay: null, errors: [e instanceof SyntaxError ? `${file} is not valid JSON` : `cannot read ${file}`] };
  }
  const errors = overlayShape(value);
  if (errors.length > 0) return { overlay: null, errors };
  // overlayShape proved the shape.
  return { overlay: value as MapOverlay, errors: [] };
}

/** A copy of the map with the flow `plan`, named "This plan", first in `order`. Bad entries are errors and are left out. */
export function applyOverlay(map: MapFile, overlay: MapOverlay): { map: MapFile; errors: string[] } {
  const errors: string[] = [];
  const copy = structuredClone(map);
  const boxes = chipIndex(copy.boxes);
  const pipeIds = new Set(copy.pipes.map((p) => p.id));

  const lit: Record<string, string[]> = {};
  for (const [box, chips] of Object.entries(overlay.lit)) {
    const have = boxes.get(box);
    if (!have) {
      errors.push(`lit names the box "${box}", which does not exist`);
      continue;
    }
    const keep = chips.filter((c) => {
      if (have.includes(c)) return true;
      errors.push(`lit chip "${c}" is not on box ${box}`);
      return false;
    });
    if (keep.length > 0) lit[box] = keep;
  }

  let marks: Record<string, string> | undefined;
  if (overlay.marks !== undefined) {
    marks = {};
    for (const [key, word] of Object.entries(overlay.marks)) {
      const at = key.indexOf("|");
      if (at < 1) {
        errors.push(`mark "${key}" is not <box>|<chip>`);
        continue;
      }
      if (!boxes.get(key.slice(0, at))?.includes(key.slice(at + 1))) {
        errors.push(`mark "${key}" does not name a chip of a box`);
        continue;
      }
      marks[key] = word;
    }
  }

  let steps: MapStep[] | undefined;
  if (overlay.steps !== undefined) {
    steps = overlay.steps.filter((s) => {
      if (pipeIds.has(s.pipe)) return true;
      errors.push(`step ${s.n} names the pipe "${s.pipe}", which does not exist`);
      return false;
    });
  }

  const plan: MapFlow = { name: overlay.name ?? "This plan" };
  if (overlay.story !== undefined) plan.story = overlay.story;
  if (steps !== undefined) plan.steps = steps;
  plan.lit = lit;
  if (marks !== undefined) plan.marks = marks;
  copy.flows.plan = plan;
  copy.order = ["plan", ...copy.order.filter((k) => k !== "plan")];
  return { map: copy, errors };
}

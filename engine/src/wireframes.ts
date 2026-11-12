/**
 * Wireframes (edge C12): `wireframes/<name>.html` in a feature folder, and `wireframes/links.json`,
 * which maps a name to the URL of its published page.
 *
 * The window never renders a wireframe. It opens the file in the browser. So this module returns
 * names and paths, never the HTML text.
 */
import { existsSync, readFileSync, readdirSync } from "node:fs";
import { join } from "node:path";
import { writeRunFile } from "./folder/write.ts";

export interface Wireframe {
  name: string;
  /** Relative to the feature folder: `wireframes/<name>.html`. */
  file: string;
  link: string | null;
}

const DIR = "wireframes";
const LINKS = "links.json";

type Links = { ok: true; links: Record<string, string> } | { ok: false; problem: string };

function parseLinks(text: string): Links {
  let data: unknown;
  try {
    data = JSON.parse(text);
  } catch {
    return { ok: false, problem: `${DIR}/${LINKS} is not valid JSON` };
  }
  if (typeof data !== "object" || data === null || Array.isArray(data)) {
    return { ok: false, problem: `${DIR}/${LINKS} must be an object of names and URLs` };
  }
  const links: Record<string, string> = {};
  for (const [k, v] of Object.entries(data)) {
    if (typeof v !== "string") return { ok: false, problem: `${DIR}/${LINKS}: the value for "${k}" is not a string` };
    links[k] = v;
  }
  return { ok: true, links };
}

function readLinks(featureFolder: string): Links {
  const file = join(featureFolder, DIR, LINKS);
  if (!existsSync(file)) return { ok: true, links: {} };
  try {
    return parseLinks(readFileSync(file, "utf8"));
  } catch {
    return { ok: false, problem: `${DIR}/${LINKS} cannot be read` };
  }
}

function names(featureFolder: string): string[] {
  try {
    return readdirSync(join(featureFolder, DIR))
      .filter((n) => n.endsWith(".html") && n.length > ".html".length)
      .map((n) => n.slice(0, -".html".length))
      .sort();
  } catch {
    return [];
  }
}

/** One entry per `wireframes/<name>.html`. A broken links.json means no links; see `wireframeProblems`. */
export function listWireframes(featureFolder: string): Wireframe[] {
  const l = readLinks(featureFolder);
  const links = l.ok ? l.links : {};
  return names(featureFolder).map((name) => ({
    name,
    file: `${DIR}/${name}.html`,
    link: Object.hasOwn(links, name) ? (links[name] ?? null) : null,
  }));
}

/** The problem lines of the wireframes folder: at most one, about links.json. */
export function wireframeProblems(featureFolder: string): string[] {
  const l = readLinks(featureFolder);
  return l.ok ? [] : [l.problem];
}

function isWebUrl(url: string): boolean {
  if (!/^https?:\/\//i.test(url) || /\s/.test(url)) return false;
  try {
    const u = new URL(url);
    return (u.protocol === "http:" || u.protocol === "https:") && u.hostname !== "";
  } catch {
    return false;
  }
}

/**
 * Saves the URL of a wireframe's published page. Only for a wireframe that exists, and only an
 * http or https URL. links.json is read again at the moment of the write, and the write is atomic.
 * A links.json that is broken is refused and left as it is.
 */
export function setWireframeLink(featureFolder: string, name: string, url: string): void {
  if (!name || name.includes("/") || name.includes("\\") || name.startsWith(".")) throw new Error(`bad wireframe name: ${name}`);
  if (!names(featureFolder).includes(name)) throw new Error(`no wireframe named ${name}`);
  if (!isWebUrl(url)) throw new Error("a wireframe link must be an http:// or https:// URL");
  writeRunFile(join(featureFolder, DIR, LINKS), (text) => {
    let links: Record<string, string> = {};
    if (text.trim() !== "") {
      const l = parseLinks(text);
      if (!l.ok) throw new Error(l.problem);
      links = l.links;
    }
    links[name] = url;
    return `${JSON.stringify(links, null, 2)}\n`;
  });
}

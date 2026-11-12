/**
 * Opening a file or a link in the browser. The window never renders an .html file; the engine runs `open`.
 */
import { existsSync, statSync } from "node:fs";
import { isAbsolute } from "node:path";
import { readFileSafe, resolveInside } from "./folder/folder.ts";
import type { FileBody } from "./types.ts";

/** Runs one command. Tests pass a fake that records the call. */
export type Runner = (cmd: string[]) => void;

export class OpenRefused extends Error {
  constructor(
    public target: string,
    reason: string,
  ) {
    super(`${target}: ${reason}`);
    this.name = "OpenRefused";
  }
}

export const spawnRunner: Runner = (cmd) => {
  Bun.spawn(cmd, { stdin: "ignore", stdout: "ignore", stderr: "ignore" });
};

const SCHEME = /^[A-Za-z][A-Za-z0-9+.-]*:/;

/** Opens an http: or https: address, or an absolute path to a file that exists. Anything else is refused. */
export function openTarget(target: string, run: Runner = spawnRunner): string[] {
  if (typeof target !== "string" || !target || /[\0\r\n]/.test(target)) throw new OpenRefused(String(target), "not an address or a path");
  if (SCHEME.test(target)) {
    let url: URL;
    try {
      url = new URL(target);
    } catch {
      throw new OpenRefused(target, "not a valid address");
    }
    if (url.protocol !== "http:" && url.protocol !== "https:") throw new OpenRefused(target, `the scheme ${url.protocol} is not allowed`);
    const cmd = ["open", url.href];
    run(cmd);
    return cmd;
  }
  if (!isAbsolute(target)) throw new OpenRefused(target, "a path must be absolute");
  if (!existsSync(target) || !statSync(target).isFile()) throw new OpenRefused(target, "no such file");
  const cmd = ["open", target];
  run(cmd);
  return cmd;
}

/** Opens a file of the feature folder. A path that leaves the folder is refused with PathRefused. */
export function openFolderFile(root: string, rel: string, run: Runner = spawnRunner): string[] {
  return openTarget(resolveInside(root, rel), run);
}

/** One file for the window. An .html file never comes back as text: the window opens it in the browser. */
export function fileBody(root: string, rel: string): FileBody {
  const { info, text } = readFileSafe(root, rel);
  if (info.html) return { info, text: null, open: true };
  return { info, text, open: false };
}

import { mkdtempSync, realpathSync, rmSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

/** A fresh temp folder. The caller removes it with `drop`. */
export function tempDir(prefix = "starship-test-"): string {
  return realpathSync(mkdtempSync(join(tmpdir(), prefix)));
}

export function drop(dir: string): void {
  rmSync(dir, { recursive: true, force: true });
}

/** Points STARSHIP_HOME at a temp folder for one test, and gives a function that restores it. */
export function tempHome(): { dir: string; restore: () => void } {
  const before = process.env.STARSHIP_HOME;
  const dir = tempDir("starship-home-");
  process.env.STARSHIP_HOME = dir;
  return {
    dir,
    restore: () => {
      if (before === undefined) delete process.env.STARSHIP_HOME;
      else process.env.STARSHIP_HOME = before;
      drop(dir);
    },
  };
}

export const repoRoot = join(import.meta.dir, "..", "..");
export const fixture = (...parts: string[]) => join(repoRoot, "fixtures", ...parts);

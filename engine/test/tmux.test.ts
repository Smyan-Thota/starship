import { afterAll, describe, expect, test } from "bun:test";
import { readFileSync } from "node:fs";
import { join } from "node:path";
import {
  TmuxError,
  attachCommand,
  capture,
  escape,
  hasSession,
  kill,
  list,
  newSession,
  paste,
  shellQuote,
} from "../src/agents/tmux.ts";
import { drop, tempDir } from "./helpers.ts";

const made: string[] = [];
const dirs: string[] = [];

function rand(): string {
  return Math.random().toString(36).slice(2, 10);
}

/** A session name that this file owns. Teardown kills it. */
function name(tag = ""): string {
  const n = `sst-${rand()}${tag}`;
  made.push(n);
  return n;
}

function dir(): string {
  const d = tempDir("starship-tmux-");
  dirs.push(d);
  return d;
}

async function waitFor(check: () => boolean, ms = 5000): Promise<void> {
  const end = Date.now() + ms;
  while (Date.now() < end) {
    if (check()) return;
    await Bun.sleep(40);
  }
}

/** Runs a shell snippet in a new session. The snippet gets its arguments as $1, $2, ... */
function run(n: string, script: string, args: string[] = [], extra: Partial<Parameters<typeof newSession>[0]> = {}) {
  newSession({ name: n, cwd: dir(), command: ["sh", "-c", script, "sh", ...args], ...extra });
}

afterAll(() => {
  for (const n of made) kill(n);
  const left = made.filter((n) => hasSession(n));
  for (const d of dirs) drop(d);
  expect(left).toEqual([]);
});

describe("shellQuote", () => {
  test("plain words stay readable", () => {
    expect(shellQuote("abc")).toBe("abc");
    expect(shellQuote("a-b_c.d/e:f=1")).toBe("a-b_c.d/e:f=1");
  });

  test("spaces, quotes and shell characters are quoted", () => {
    expect(shellQuote("a b")).toBe("'a b'");
    expect(shellQuote("it's")).toBe("'it'\\''s'");
    expect(shellQuote("")).toBe("''");
    expect(shellQuote("$(rm -rf x)")).toBe("'$(rm -rf x)'");
  });

  test("a shell reads back exactly the text that went in", () => {
    const tricky = ["a b", "it's", "", '"dq"', "$HOME", "`x`", "a;b|c&d", "line1\nline2", "back\\slash", "*", "-n", "é☃"];
    for (const s of tricky) {
      const out = Bun.spawnSync(["sh", "-c", `printf %s ${shellQuote(s)}`]);
      expect(out.stdout.toString()).toBe(s);
    }
  });
});

describe("sessions", () => {
  test("a session starts, is found, listed and killed", async () => {
    const n = name();
    run(n, "sleep 30");
    expect(hasSession(n)).toBe(true);
    expect(list("sst-")).toContain(n);
    kill(n);
    expect(hasSession(n)).toBe(false);
    expect(list("sst-")).not.toContain(n);
  });

  test("kill on a missing session does not throw", () => {
    const n = name();
    expect(() => kill(n)).not.toThrow();
    run(n, "sleep 30");
    kill(n);
    expect(() => kill(n)).not.toThrow();
  });

  test("a name is matched exactly, never as a prefix", () => {
    const base = name();
    const longer = `${base}x`;
    made.push(longer);
    run(longer, "sleep 30");
    expect(hasSession(base)).toBe(false);
    expect(() => kill(base)).not.toThrow();
    expect(hasSession(longer)).toBe(true);
  });

  test("list returns only the names with the prefix", () => {
    const prefix = `sst-${rand()}-`;
    const a = `${prefix}a`;
    const b = `${prefix}b`;
    made.push(a, b);
    run(a, "sleep 30");
    run(b, "sleep 30");
    const other = name();
    run(other, "sleep 30");
    expect(list(prefix).sort()).toEqual([a, b]);
    expect(list(`${prefix}zzz`)).toEqual([]);
  });

  test("the session runs in cwd with env, at 200 by 50", async () => {
    const n = name();
    const cwd = dir();
    newSession({
      name: n,
      cwd,
      command: ["sh", "-c", 'pwd; echo "FOO=$FOO"; stty size; sleep 30'],
      env: { FOO: "bar baz" },
    });
    await waitFor(() => capture(n).includes("50 200"));
    const screen = capture(n);
    expect(screen).toContain(cwd);
    expect(screen).toContain("FOO=bar baz");
    expect(screen).toContain("50 200");
  });

  test("width and height can be set", async () => {
    const n = name();
    run(n, "stty size; sleep 30", [], { width: 120, height: 30 });
    await waitFor(() => capture(n).includes("30 120"));
    expect(capture(n)).toContain("30 120");
  });

  test("argv items reach the program unchanged", async () => {
    const n = name();
    const arg = `it's a $HOME "q" ; \`x\` *`;
    run(n, 'printf "[%s]\\n" "$1"; sleep 30', [arg]);
    await waitFor(() => capture(n).includes("]"));
    expect(capture(n)).toContain(`[${arg}]`);
  });

  test("a failed start throws a TmuxError", () => {
    const n = name();
    expect(() => newSession({ name: n, cwd: "/no/such/folder/anywhere", command: ["sleep", "1"] })).toThrow(TmuxError);
  });

  test("a second session with the same name throws a TmuxError that carries tmux's words", () => {
    const n = name();
    run(n, "sleep 30");
    try {
      run(n, "sleep 30");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TmuxError);
      expect((e as TmuxError).stderr).toContain("duplicate session");
    }
  });
});

describe("paste", () => {
  test("a line arrives whole, then Enter submits it", async () => {
    const n = name();
    run(n, 'read -r line; echo "GOT:$line"; sleep 30');
    const text = `a; b $HOME 'q' "d" -x \`t\` *`;
    paste(n, text);
    await waitFor(() => capture(n).includes("GOT:"));
    expect(capture(n)).toContain(`GOT:${text}`);
  });

  test("text that starts with a dash is not read as a flag", async () => {
    const n = name();
    run(n, 'read -r line; echo "GOT:$line"; sleep 30');
    paste(n, "-p -x");
    await waitFor(() => capture(n).includes("GOT:"));
    expect(capture(n)).toContain("GOT:-p -x");
  });

  test("a program that asked for bracketed paste gets the markers", async () => {
    const n = name();
    run(n, "printf '\\033[?2004h'; stty raw -echo; dd bs=1 count=15 2>/dev/null | od -An -c; sleep 30");
    await Bun.sleep(300);
    paste(n, "hi");
    await waitFor(() => capture(n).includes("~"));
    const screen = capture(n).replace(/\s+/g, " ");
    // ESC [ 2 0 0 ~ h i ESC [ 2 0 1 ~ then a carriage return
    expect(screen).toContain("033 [ 2 0 0 ~ h i 033 [ 2 0 1 ~ \\r");
  });

  test("a newline or carriage return is refused and nothing is sent", async () => {
    const n = name();
    run(n, "cat");
    expect(() => paste(n, "a\nb")).toThrow(TmuxError);
    expect(() => paste(n, "a\rb")).toThrow(TmuxError);
    await Bun.sleep(150);
    expect(capture(n).trim()).toBe("");
  });

  test("a missing session throws a TmuxError with tmux's stderr and leaves no buffer", () => {
    const before = Bun.spawnSync(["tmux", "list-buffers", "-F", "#{buffer_name}"]).stdout.toString();
    try {
      paste("sst-does-not-exist", "hello");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TmuxError);
      expect((e as TmuxError).stderr).toContain("sst-does-not-exist");
    }
    const after = Bun.spawnSync(["tmux", "list-buffers", "-F", "#{buffer_name}"]).stdout.toString();
    expect(after).toBe(before);
  });
});

describe("escape and capture", () => {
  test("escape sends one ESC byte", async () => {
    const n = name();
    run(n, "stty raw -echo; dd bs=1 count=1 2>/dev/null | od -An -tx1; sleep 30");
    await Bun.sleep(300);
    escape(n);
    await waitFor(() => capture(n).includes("1b"));
    expect(capture(n)).toContain("1b");
  });

  test("escape on a missing session throws a TmuxError", () => {
    expect(() => escape("sst-does-not-exist")).toThrow(TmuxError);
  });

  test("capture returns the last lines of history, 200 by default", async () => {
    const n = name();
    run(n, "i=1; while [ $i -le 300 ]; do echo \"row $i.\"; i=$((i+1)); done; sleep 30");
    await waitFor(() => capture(n).includes("row 300."));
    const def = capture(n);
    expect(def).toContain("row 300.");
    expect(def).toContain("row 100.");
    expect(def).not.toContain("row 10.");
    const small = capture(n, 5);
    expect(small).toContain("row 300.");
    expect(small).not.toContain("row 100.");
    expect(capture(n, 1000)).toContain("row 1.");
  });

  test("capture on a missing session throws a TmuxError", () => {
    try {
      capture("sst-does-not-exist");
      throw new Error("should have thrown");
    } catch (e) {
      expect(e).toBeInstanceOf(TmuxError);
      expect((e as TmuxError).stderr).toContain("sst-does-not-exist");
      expect((e as TmuxError).message).toContain("sst-does-not-exist");
    }
  });
});

describe("attach", () => {
  test("attachCommand is the argv a terminal runs", () => {
    expect(attachCommand("ss-recipes-worker-a")).toEqual(["tmux", "attach", "-t", "ss-recipes-worker-a"]);
  });
});

describe("keys", () => {
  const source = readFileSync(join(import.meta.dir, "..", "src", "agents", "tmux.ts"), "utf8");

  test("every send-keys call site sends only Enter or Escape", () => {
    const mentions = source.match(/send-keys/g) ?? [];
    const sites = [...source.matchAll(/\[\s*"send-keys"\s*,\s*"-t"\s*,\s*[^,\]]+,\s*"([^"]*)"\s*\]/g)];
    // each mention is a call site of exactly this shape: no extra flag, no key list, no text
    expect(sites.length).toBe(mentions.length);
    expect(sites.length).toBeGreaterThanOrEqual(2);
    for (const s of sites) expect(["Enter", "Escape"]).toContain(String(s[1]));
    expect(new Set(sites.map((s) => s[1]))).toEqual(new Set(["Enter", "Escape"]));
  });

  test("the file never sends keys any other way", () => {
    expect(source).not.toMatch(/send-keys["']?\s*,\s*["']-l/);
    expect(source).not.toMatch(/send-prefix|respawn|pipe-pane/);
  });
});

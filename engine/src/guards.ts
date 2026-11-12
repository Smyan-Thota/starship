/**
 * Role guards: what an agent may not do, decided before each tool use.
 *
 * `decide` is a pure function. A hook (`starship hook pre-tool-use`) feeds it the tool call and prints the answer:
 * Claude Code takes `claudeHookOutput`, Codex takes the reason on stderr with exit code 2.
 *
 *   worker                          writes inside its worktree, but not in the feature folder (C7).
 *   admin                           writes plan files and decision records, never code (B11), and not TASKS.md once the build runs.
 *   orchestrator, reviewer, cardRunner   write nothing.
 *   every agent                     is refused a heavy command (D10), a commit and a push. `starship ...` always runs.
 *
 * The guard reads the command text. It does not run anything and it does not follow symlinks.
 * It is a net for honest mistakes, not a sandbox against an agent that tries to hide a write.
 */
import { homedir } from "node:os";
import { basename, dirname, join, resolve, sep } from "node:path";
import type { Role } from "./types.ts";

export interface GuardInput {
  role: Role;
  /** The tool's name: Bash, Write, Edit, NotebookEdit, shell, apply_patch, or anything else. */
  tool: string;
  /** The tool's input as the hook got it. */
  input: unknown;
  /** The directory the agent works in. A relative path is read against it. */
  cwd: string;
  worktree: string | null;
  featureFolder: string | null;
  adrDir: string | null;
  buildStarted: boolean;
  /** A shell command that holds one of these words is heavy. */
  heavyPatterns: string[];
}

export type Decision = { allow: true } | { allow: false; reason: string };

/** The JSON a Claude Code PreToolUse hook prints. An empty string means allow. */
export function claudeHookOutput(d: Decision): string {
  if (d.allow) return "";
  return JSON.stringify({
    hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: d.reason },
  });
}

const PLAN_FILES = new Set(["spec.md", "plan.md", "tasks.md", "acceptance.md", "prompts.md"]);
/** A tool that only reads. Its `path` or `file_path` is not a write target. */
const READ_TOOLS = new Set([
  "read", "grep", "glob", "ls", "view", "search", "websearch", "webfetch", "todowrite", "task", "agent",
  "askuserquestion", "notebookread", "list_dir", "read_file", "exitplanmode", "enterplanmode", "bashoutput",
  "killshell", "skill", "toolsearch", "taskoutput", "sendmessage", "lsp", "monitor",
]);
const GIT_READ = new Set(["status", "diff", "log", "show", "blame", "ls-files", "rev-parse"]);
/** A subcommand that makes a commit, though it is not named `commit`. */
const COMMITTERS = new Set(["commit", "commit-tree", "cherry-pick", "revert", "am", "merge", "rebase"]);
const SHELLS = new Set(["bash", "sh", "zsh", "dash", "ksh"]);
const INTERPRETERS = new Set(["python", "python2", "python3", "node", "nodejs", "bun", "deno", "ruby", "perl", "php", "osascript", "lua"]);
/** A command that changes files. Under xargs its targets come from stdin, so they are unknown. */
const WRITERS = new Set(["rm", "rmdir", "unlink", "mkdir", "touch", "truncate", "chmod", "chown", "chgrp", "mv", "cp", "install", "rsync", "ln", "tee", "dd"]);
/** A command whose words are never matched against the heavy patterns. */
const NO_HEAVY = new Set([
  ...WRITERS, "git", "cat", "grep", "egrep", "fgrep", "rg", "ag", "ls", "echo", "printf", "head", "tail", "wc", "find",
  "less", "more", "man", "which", "type", "whereis", "stat", "file", "tree", "diff", "sort", "uniq", "cut", "tr", "sed",
  "awk", "basename", "dirname", "realpath", "pwd", "test", "[", "true", "false", "sleep", "date", "open",
]);
const PREFIX = new Set(["{", "!", "if", "then", "else", "elif", "do", "while", "until", "time", "coproc"]);
/** Wrappers that run the next command. The list holds the flags that take a value. */
const WRAPPERS: Record<string, string[]> = {
  sudo: ["-u", "-g", "-h", "-p", "-C", "-D", "-R", "-T"],
  doas: ["-u"],
  nohup: [],
  command: [],
  builtin: [],
  exec: ["-a"],
  nice: ["-n"],
  ionice: ["-c", "-n", "-p"],
  stdbuf: ["-i", "-o", "-e"],
  setsid: [],
  env: ["-u", "-C", "-S"],
  timeout: ["-k", "-s"],
  xargs: ["-I", "-n", "-P", "-L", "-d", "-E", "-s", "-a", "-J"],
};

/** A path the guard cannot work out, such as one that holds `$HOME`. It is outside every folder. */
const UNKNOWN = "\0unknown";
const NULLISH = new Set(["/dev/null", "/dev/stdout", "/dev/stderr", "/dev/tty"]);

interface Word {
  text: string;
  /** The word held a `$` that the shell would expand. */
  hasVar: boolean;
}

interface Segment {
  words: Word[];
  /** Targets of `>`, `>>` and `&>`. */
  outs: Word[];
}

interface Facts {
  /** Absolute paths that the call writes. */
  targets: string[];
  /** Directories of commands that write somewhere under their directory: a git write, an inline script, patch, wget. */
  cwdWrites: string[];
  commit: boolean;
  push: boolean;
  /** The first heavy pattern that matched. */
  heavy: string | null;
}

interface Ctx {
  facts: Facts;
  cwd: string;
  heavyPatterns: string[];
  depth: number;
}

// ---------------------------------------------------------------- paths

function absPath(text: string, hasVar: boolean, cwd: string): string {
  if (hasVar || text.includes("`")) return UNKNOWN;
  let t = text;
  if (t === "~" || t.startsWith("~/")) t = join(homedir(), t.slice(1));
  else if (t.startsWith("~")) return UNKNOWN;
  if (t.startsWith("/")) return resolve(t);
  if (cwd === UNKNOWN) return UNKNOWN;
  return resolve(cwd, t);
}

function inside(root: string, p: string): boolean {
  if (p === UNKNOWN) return false;
  const r = root.endsWith(sep) ? root : root + sep;
  return p === root || p.startsWith(r);
}

// ---------------------------------------------------------------- shell reading

/** Cuts out heredoc bodies. A body that holds a Codex patch is returned so that its files count as writes. */
function stripHeredocs(src: string): { code: string; bodies: string[] } {
  const bodies: string[] = [];
  let code = src;
  let pos = 0;
  const re = /<<(?!<)(-?)\s*(['"]?)([A-Za-z_][\w-]*)\2/g;
  for (;;) {
    re.lastIndex = pos;
    const m = re.exec(code);
    if (!m) break;
    const tag = m[3] ?? "";
    const dash = m[1] === "-";
    const after = m.index + m[0].length;
    const nl = code.indexOf("\n", after);
    const lines = nl < 0 ? [] : code.slice(nl + 1).split("\n");
    let k = 0;
    const body: string[] = [];
    while (k < lines.length) {
      const ln = lines[k] ?? "";
      if ((dash ? ln.replace(/^\t+/, "") : ln) === tag) break;
      body.push(ln);
      k++;
    }
    if (nl < 0 || k >= lines.length) {
      // No terminator: it was not a heredoc. Leave the text alone and look further on.
      pos = after;
      continue;
    }
    bodies.push(body.join("\n"));
    code = code.slice(0, m.index) + code.slice(after, nl + 1) + lines.slice(k + 1).join("\n");
    pos = m.index;
  }
  return { code, bodies };
}

/** Splits a shell command into simple commands. `$(...)` and backticks become commands of their own. */
function tokenize(src: string): { segments: Segment[]; nested: string[] } {
  const segments: Segment[] = [];
  const nested: string[] = [];
  let words: Word[] = [];
  let outs: Word[] = [];
  let cur = "";
  let inWord = false;
  let hasVar = false;
  let pending: "out" | "in" | null = null;

  const flush = () => {
    if (!inWord) return;
    const w: Word = { text: cur, hasVar };
    if (pending === "out") outs.push(w);
    else if (pending === null) words.push(w);
    pending = null;
    cur = "";
    inWord = false;
    hasVar = false;
  };
  const end = () => {
    flush();
    pending = null;
    if (words.length || outs.length) segments.push({ words, outs });
    words = [];
    outs = [];
  };
  /** A number right before `>` or `<` is a file descriptor, not a word. */
  const dropFd = () => {
    if (inWord && !hasVar && /^\d+$/.test(cur)) {
      cur = "";
      inWord = false;
    } else flush();
  };

  let i = 0;
  while (i < src.length) {
    const c = src.charAt(i);
    if (c === "\\") {
      const n = src.charAt(i + 1);
      if (n !== "\n") {
        cur += n;
        inWord = true;
      }
      i += 2;
    } else if (c === "'") {
      const j = src.indexOf("'", i + 1);
      const stop = j < 0 ? src.length : j;
      cur += src.slice(i + 1, stop);
      inWord = true;
      i = stop + 1;
    } else if (c === '"') {
      let j = i + 1;
      let body = "";
      while (j < src.length && src.charAt(j) !== '"') {
        const d = src.charAt(j);
        const n = src.charAt(j + 1);
        if (d === "\\" && (n === '"' || n === "\\" || n === "$" || n === "`")) {
          body += n;
          j += 2;
          continue;
        }
        if (d === "$") hasVar = true;
        body += d;
        j++;
      }
      for (const m of src.slice(i + 1, j).matchAll(/\$\(([^()]*)\)|`([^`]*)`/g)) nested.push(m[1] ?? m[2] ?? "");
      cur += body;
      inWord = true;
      i = j + 1;
    } else if (c === " " || c === "\t" || c === "\r") {
      flush();
      i++;
    } else if (c === "\n" || c === ";" || c === "|" || c === "(" || c === ")" || c === "`") {
      end();
      i++;
    } else if (c === "&") {
      if (src.charAt(i + 1) !== ">") end();
      i++;
    } else if (c === "#" && !inWord) {
      while (i < src.length && src.charAt(i) !== "\n") i++;
    } else if (c === ">") {
      dropFd();
      let j = i + 1;
      const n = src.charAt(j);
      if (n === ">" || n === "|") j++;
      else if (n === "&") {
        if (/[0-9-]/.test(src.charAt(j + 1))) {
          // 2>&1 or >&-: a copy of a descriptor, not a file.
          j += 2;
          while (/\d/.test(src.charAt(j))) j++;
          i = j;
          continue;
        }
        j++;
      }
      pending = "out";
      i = j;
    } else if (c === "<") {
      dropFd();
      let j = i + 1;
      while (src.charAt(j) === "<") j++;
      pending = "in";
      i = j;
    } else {
      if (c === "$") hasVar = true;
      cur += c;
      inWord = true;
      i++;
    }
  }
  end();
  return { segments, nested };
}

// ---------------------------------------------------------------- facts

function addTarget(ctx: Ctx, w: Word): void {
  if (NULLISH.has(w.text) || w.text.startsWith("/dev/fd/")) return;
  ctx.facts.targets.push(absPath(w.text, w.hasVar, ctx.cwd));
}

function addPath(ctx: Ctx, p: string): void {
  ctx.facts.targets.push(absPath(p, false, ctx.cwd));
}

/** The files of a Codex apply_patch text or a unified diff. */
function addPatch(ctx: Ctx, text: string): void {
  const codex = text.includes("*** Begin Patch");
  for (const line of text.split("\n")) {
    const m = /^\*\*\* (?:Add|Update|Delete) File: (.+)$/.exec(line) ?? /^\*\*\* Move to: (.+)$/.exec(line);
    if (m?.[1]) addPath(ctx, m[1].trim());
    if (codex) continue;
    const u = /^(?:\+\+\+|---) (?:[ab]\/)?(\S+)/.exec(line);
    if (u?.[1] && u[1] !== "/dev/null") addPath(ctx, u[1]);
    const g = /^diff --git a\/(\S+) b\/(\S+)/.exec(line);
    if (g?.[1] && g[2]) {
      addPath(ctx, g[1]);
      addPath(ctx, g[2]);
    }
  }
}

function positional(args: Word[], values: string[] = [], flag: RegExp = /^-./): Word[] {
  const out: Word[] = [];
  let rest = false;
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    if (!w) continue;
    if (!rest && w.text === "--") {
      rest = true;
      continue;
    }
    if (!rest && flag.test(w.text)) {
      if (values.includes(w.text)) k++;
      continue;
    }
    if (w.text !== "") out.push(w);
  }
  return out;
}

/** The values of an option, given as `-t X`, `--name X` or `--name=X`. */
function optValues(args: Word[], names: string[]): Word[] {
  const out: Word[] = [];
  for (let k = 0; k < args.length; k++) {
    const w = args[k];
    if (!w) continue;
    for (const n of names) {
      if (w.text === n) {
        const v = args[k + 1];
        if (v) out.push(v);
      } else if (n.startsWith("--") && w.text.startsWith(`${n}=`)) {
        out.push({ text: w.text.slice(n.length + 1), hasVar: w.hasVar });
      }
    }
  }
  return out;
}

const hasFlag = (args: Word[], re: RegExp) => args.some((w) => re.test(w.text));

function matchesHeavy(words: Word[], patterns: string[]): string | null {
  const line = words.map((w) => w.text).join(" ");
  for (const p of patterns) {
    if (!p) continue;
    const esc = p.replace(/[.*+?^${}()|[\]\\]/g, "\\$&");
    if (new RegExp(`(?<![A-Za-z0-9_])${esc}(?![A-Za-z0-9_])`).test(line)) return p;
  }
  return null;
}

function analyzeCommand(src: string, ctx: Ctx): void {
  if (ctx.depth > 8) {
    ctx.facts.targets.push(UNKNOWN);
    return;
  }
  const { code, bodies } = stripHeredocs(src);
  for (const b of bodies) if (b.includes("*** Begin Patch")) addPatch(ctx, b);
  const { segments, nested } = tokenize(code);
  for (const seg of segments) analyzeSegment(seg, ctx);
  for (const n of nested) nest(ctx, () => analyzeCommand(n, ctx));
}

/** Runs `f` in a subshell: a `cd` inside it does not leak out. */
function nest(ctx: Ctx, f: () => void): void {
  const cwd = ctx.cwd;
  ctx.depth++;
  f();
  ctx.depth--;
  ctx.cwd = cwd;
}

function analyzeSegment(seg: Segment, ctx: Ctx): void {
  for (const o of seg.outs) addTarget(ctx, o);
  analyzeWords(seg.words, ctx, false);
}

function analyzeWords(input: Word[], ctx: Ctx, dynamicIn: boolean): void {
  let words = input;
  let dynamic = dynamicIn;
  for (let guard = 0; guard < 10; guard++) {
    const first = words[0];
    if (!first) return;
    if (/^[A-Za-z_][A-Za-z0-9_]*=/.test(first.text) || PREFIX.has(first.text)) {
      words = words.slice(1);
      continue;
    }
    const name = basename(first.text);
    const rest = words.slice(1);
    const flagValues = Object.hasOwn(WRAPPERS, name) ? WRAPPERS[name] : undefined;
    if (flagValues) {
      if (name === "command" && hasFlag(rest, /^-[vV]$/)) return;
      let k = 0;
      while (k < rest.length && (rest[k]?.text ?? "").startsWith("-") && rest[k]?.text !== "--") {
        k += flagValues.includes(rest[k]?.text ?? "") ? 2 : 1;
      }
      if (rest[k]?.text === "--") k++;
      if (name === "timeout") k++;
      if (name === "xargs") dynamic = true;
      words = rest.slice(k);
      continue;
    }
    if (name === "starship") return;
    analyzeSimple(name, rest, ctx, dynamic);
    return;
  }
}

function analyzeSimple(name: string, args: Word[], ctx: Ctx, dynamic: boolean): void {
  const f = ctx.facts;
  const target = (w: Word) => addTarget(ctx, w);

  if (SHELLS.has(name)) {
    const k = args.findIndex((w) => /^-[A-Za-z]*c[A-Za-z]*$/.test(w.text));
    const script = k < 0 ? undefined : args.slice(k + 1).find((w) => !w.text.startsWith("-"));
    if (script) nest(ctx, () => analyzeCommand(script.text, ctx));
    return;
  }
  if (name === "eval") {
    nest(ctx, () => analyzeCommand(args.map((w) => w.text).join(" "), ctx));
    return;
  }
  if (name === "cd" || name === "pushd") {
    const a = positional(args)[0];
    if (!a) ctx.cwd = homedir();
    else ctx.cwd = a.text === "-" ? UNKNOWN : absPath(a.text, a.hasVar, ctx.cwd);
    return;
  }
  if (name === "apply_patch" || name === "applypatch") {
    for (const w of args) if (w.text.includes("*** Begin Patch")) addPatch(ctx, w.text);
    return;
  }

  if (!NO_HEAVY.has(name)) {
    const hit = matchesHeavy([{ text: name, hasVar: false }, ...args], ctx.heavyPatterns);
    if (hit !== null && f.heavy === null) f.heavy = hit;
  }
  if (dynamic && (WRITERS.has(name) || (name === "sed" && hasFlag(args, /^(-[A-Za-z]*i[A-Za-z.]*|--in-place.*)$/)))) f.targets.push(UNKNOWN);

  switch (name) {
    case "git":
      analyzeGit(args, ctx);
      return;
    case "rm": case "rmdir": case "unlink": case "mkdir": case "touch": case "truncate": {
      const values = name === "truncate" ? ["-s", "--size", "-r", "--reference"] : name === "touch" ? ["-d", "-t", "-r", "-A"] : name === "mkdir" ? ["-m"] : [];
      for (const w of positional(args, values)) target(w);
      return;
    }
    case "chmod": case "chown": case "chgrp": {
      // The first word that is not a flag is the mode or the owner. `-x` is a mode, so only known flags are skipped.
      for (const w of positional(args, [], /^(-[RfvchHLP]+|--.*)$/).slice(1)) target(w);
      return;
    }
    case "mv": {
      for (const w of positional(args, ["-t", "--target-directory", "-S", "--suffix"])) target(w);
      for (const w of optValues(args, ["-t", "--target-directory"])) target(w);
      return;
    }
    case "cp": case "install": case "rsync": case "ln": {
      const t = optValues(args, ["-t", "--target-directory"]);
      if (t.length) {
        for (const w of t) target(w);
        return;
      }
      const pos = positional(args, ["-S", "--suffix", "-m", "-o", "-g", "-e", "--rsh"]);
      const last = pos[pos.length - 1];
      if (name === "ln" && pos.length === 1) f.targets.push(ctx.cwd);
      else if (last) target(last);
      return;
    }
    case "tee":
      for (const w of positional(args)) target(w);
      return;
    case "dd":
      for (const w of args) if (w.text.startsWith("of=")) target({ text: w.text.slice(3), hasVar: w.hasVar });
      return;
    case "sed": {
      if (!hasFlag(args, /^(-[A-Za-z]*i[A-Za-z.]*|--in-place.*)$/)) return;
      const files = positional(args, ["-e", "-f", "--expression", "--file", "-l", "--line-length"]);
      const hasScriptFlag = hasFlag(args, /^(-e|-f|--expression.*|--file.*)$/);
      for (const w of hasScriptFlag ? files : files.slice(1)) target(w);
      return;
    }
    case "patch":
      f.cwdWrites.push(ctx.cwd);
      return;
    case "curl": {
      for (const w of optValues(args, ["-o", "--output"])) target(w);
      for (const w of args) {
        if (/^-[A-Za-z]*o$/.test(w.text) && w.text !== "-o") {
          const v = args[args.indexOf(w) + 1];
          if (v) target(v);
        }
        if (/^-[A-Za-z]*O[A-Za-z]*$/.test(w.text) || w.text === "--remote-name" || w.text === "-J") f.targets.push(ctx.cwd);
      }
      return;
    }
    case "wget": {
      const out = [...optValues(args, ["-O", "--output-document"]), ...args.filter((w) => /^-[A-Za-z]*O$/.test(w.text) && w.text !== "-O").map((w) => args[args.indexOf(w) + 1]).filter((w): w is Word => !!w)];
      const dir = optValues(args, ["-P", "--directory-prefix"]);
      for (const w of out) if (w.text !== "-") target(w);
      for (const w of dir) target(w);
      if (!out.length && !dir.length && positional(args, ["-P", "-O", "-o", "-t", "-T", "-w"]).length) f.targets.push(ctx.cwd);
      return;
    }
    case "find":
      analyzeFind(args, ctx);
      return;
    default:
  }

  if (INTERPRETERS.has(name)) {
    const quiet = hasFlag(args, /^(--version|-V|-v|--help|-h)$/);
    const inline =
      hasFlag(args, /^(-c|-p|-r|--eval|--print)$/) ||
      (name !== "python" && name !== "python2" && name !== "python3" && hasFlag(args, /^-[A-Za-z]*[eE]$/)) ||
      (name === "deno" && args[0]?.text === "eval");
    const perlInPlace = name === "perl" && hasFlag(args, /^-[A-Za-z]*i[A-Za-z.]*$/);
    // No script file at all: the script comes from stdin.
    const stdin = positional(args).length === 0 && !quiet;
    if (perlInPlace || (!quiet && (inline || stdin))) f.cwdWrites.push(ctx.cwd);
  }
}

/** A command that writes somewhere under `dir`. */
function writesUnder(f: Facts, dir: string): void {
  f.cwdWrites.push(dir);
}

function analyzeGit(args: Word[], ctx: Ctx): void {
  const f = ctx.facts;
  let dir = ctx.cwd;
  let i = 0;
  for (; i < args.length; i++) {
    const t = args[i]?.text ?? "";
    if (t === "-C") {
      const v = args[i + 1];
      if (v) dir = absPath(v.text, v.hasVar, dir);
      i++;
    } else if (t === "-c" || t === "--git-dir" || t === "--work-tree" || t === "--namespace") {
      i++;
    } else if (!t.startsWith("-")) break;
  }
  const sub = args[i]?.text;
  if (!sub) return;
  if (sub === "push") f.push = true;
  else if (COMMITTERS.has(sub)) f.commit = true;
  else if (!GIT_READ.has(sub)) writesUnder(f, dir);
}

function analyzeFind(args: Word[], ctx: Ctx): void {
  const f = ctx.facts;
  const roots: Word[] = [];
  for (const w of args) {
    if (w.text.startsWith("-") || w.text === "(" || w.text === "!") break;
    roots.push(w);
  }
  if (!roots.length) roots.push({ text: ".", hasVar: false });
  const hitRoots = () => {
    for (const r of roots) addTarget(ctx, r);
  };
  for (let k = 0; k < args.length; k++) {
    const t = args[k]?.text ?? "";
    if (t === "-delete") hitRoots();
    else if (/^-f(print0?|printf|ls)$/.test(t)) {
      const v = args[k + 1];
      if (v) addTarget(ctx, v);
    } else if (t === "-exec" || t === "-execdir" || t === "-ok" || t === "-okdir") {
      const cmd: Word[] = [];
      for (let m = k + 1; m < args.length; m++) {
        const w = args[m];
        if (!w || w.text === ";" || w.text === "+") break;
        cmd.push(w);
      }
      const sub: Facts = { targets: [], cwdWrites: [], commit: false, push: false, heavy: null };
      analyzeWords(cmd, { ...ctx, facts: sub }, false);
      f.commit ||= sub.commit;
      f.push ||= sub.push;
      f.heavy ??= sub.heavy;
      f.targets.push(...sub.targets);
      f.cwdWrites.push(...sub.cwdWrites);
      if (sub.targets.length || sub.cwdWrites.length || WRITERS.has(basename(cmd[0]?.text ?? ""))) hitRoots();
    }
  }
}

// ---------------------------------------------------------------- reading the tool call

function str(v: unknown): string | null {
  return typeof v === "string" && v !== "" ? v : null;
}

/** A shell tool gives its command as a string, or as an argv array. */
function commandText(v: unknown): string | null {
  if (typeof v === "string") return v;
  if (Array.isArray(v) && v.every((x) => typeof x === "string")) {
    return (v as string[]).map((x) => (/^[\w@%+=:,./-]+$/.test(x) ? x : `'${x.replace(/'/g, `'\\''`)}'`)).join(" ");
  }
  return null;
}

function collect(i: GuardInput): Facts {
  const facts: Facts = { targets: [], cwdWrites: [], commit: false, push: false, heavy: null };
  const ctx: Ctx = { facts, cwd: resolve(i.cwd), heavyPatterns: i.heavyPatterns, depth: 0 };
  const name = i.tool.toLowerCase();
  if (READ_TOOLS.has(name)) return facts;
  const inp = i.input;

  if (typeof inp === "string") {
    if (inp.includes("*** Begin Patch") || /^(diff --git|\+\+\+ )/m.test(inp) || name.includes("patch")) addPatch(ctx, inp);
    else if (/shell|bash|exec|command|terminal/.test(name)) analyzeCommand(inp, ctx);
    return facts;
  }
  if (typeof inp !== "object" || inp === null) return facts;
  // The hook input is JSON of any shape, so it is read as a record of unknown values.
  const o = inp as Record<string, unknown>;

  const workdir = str(o.workdir);
  if (workdir) ctx.cwd = absPath(workdir, false, ctx.cwd);
  const cmd = commandText(o.command ?? o.cmd);
  if (cmd !== null) analyzeCommand(cmd, ctx);
  for (const key of ["file_path", "path", "notebook_path"]) {
    const p = str(o[key]);
    if (p) addPath(ctx, p);
  }
  for (const key of ["patch", "input", "diff"]) {
    const p = str(o[key]);
    if (p && (p.includes("*** Begin Patch") || name.includes("patch"))) addPatch(ctx, p);
  }
  return facts;
}

// ---------------------------------------------------------------- decisions

const deny = (reason: string): Decision => ({ allow: false, reason });

const label = (role: Role) => (role === "cardRunner" ? "card runner" : role);

export function decide(i: GuardInput): Decision {
  const f = collect(i);
  if (f.push) return deny("No agent pushes a branch, because the engine never pushes; leave the branch as it is.");
  if (f.commit) return deny("No agent makes a commit, because the engine commits a task after its check passes; run `starship check <task>` instead.");
  if (f.heavy !== null) return deny(`Only the engine runs a heavy command like "${f.heavy}"; run \`starship check <task>\` instead.`);
  const writes = f.targets.length > 0 || f.cwdWrites.length > 0;
  if (!writes) return { allow: true };
  if (i.role === "worker") return worker(i, f);
  if (i.role === "admin") return admin(i, f);
  return deny(`A ${label(i.role)} writes nothing, so report through a \`starship\` command instead.`);
}

function worker(i: GuardInput, f: Facts): Decision {
  if (i.worktree === null) return deny("A worker needs a worktree to write, and this chat has none.");
  const wt = resolve(i.worktree);
  const ff = i.featureFolder === null ? null : resolve(i.featureFolder);
  for (const t of f.targets) {
    if (!inside(wt, t)) {
      const what = t === UNKNOWN ? "a path the guard cannot work out" : `"${t}"`;
      return deny(`A worker writes only inside its worktree, and ${what} is outside it.`);
    }
    if (ff !== null && inside(ff, t)) {
      return deny('A worker never writes in the feature folder; ask the plan\'s owner with `starship ask --task <id> "<question>"` instead.');
    }
  }
  for (const d of f.cwdWrites) {
    if (!inside(wt, d)) return deny("A worker writes only inside its worktree, and that command works outside it.");
  }
  return { allow: true };
}

function admin(i: GuardInput, f: Facts): Decision {
  const ff = i.featureFolder === null ? null : resolve(i.featureFolder);
  const adr = i.adrDir === null ? null : resolve(i.adrDir);
  const refuse = deny("The admin agent writes only plan files and decision records, and never edits code.");
  if (f.cwdWrites.length > 0) return refuse;
  for (const t of f.targets) {
    if (t === UNKNOWN) return refuse;
    if (adr !== null && inside(adr, t)) continue;
    if (ff !== null && inside(join(ff, "wireframes"), t)) continue;
    const file = basename(t).toLowerCase();
    if (ff !== null && dirname(t) === ff && PLAN_FILES.has(file)) {
      if (file === "tasks.md" && i.buildStarted) {
        return deny("TASKS.md belongs to the engine once the build has started, so send the change as `starship note --to orchestrator`.");
      }
      continue;
    }
    return refuse;
  }
  return { allow: true };
}

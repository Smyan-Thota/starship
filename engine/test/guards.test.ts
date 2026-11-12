import { describe, expect, test } from "bun:test";
import { type GuardInput, claudeHookOutput, decide } from "../src/guards.ts";
import type { Role } from "../src/types.ts";
import { fixture } from "./helpers.ts";
import { readFileSync } from "node:fs";

const WT = "/work/wt";
const FF = "/work/wt/docs/features/demo";
const ADR = "/work/wt/docs/adr";
const HEAVY = ["tsc", "typecheck", "vitest", "jest", "pytest", "yarn install", "bun install"];

function input(role: Role, tool: string, toolInput: unknown, over: Partial<GuardInput> = {}): GuardInput {
  return {
    role,
    tool,
    input: toolInput,
    cwd: WT,
    worktree: WT,
    featureFolder: FF,
    adrDir: ADR,
    buildStarted: false,
    heavyPatterns: HEAVY,
    ...over,
  };
}

const bash = (role: Role, command: string, over: Partial<GuardInput> = {}) => input(role, "Bash", { command }, over);
const write = (role: Role, file_path: string, over: Partial<GuardInput> = {}) => input(role, "Write", { file_path }, over);

function denied(i: GuardInput): string {
  const d = decide(i);
  if (d.allow) throw new Error(`expected a refusal, got allow for ${JSON.stringify(i.input)}`);
  return d.reason;
}
const allowed = (i: GuardInput) => expect(decide(i)).toEqual({ allow: true });

describe("hook output", () => {
  test("a refusal prints the Claude Code PreToolUse JSON, an allow prints nothing", () => {
    expect(claudeHookOutput({ allow: true })).toBe("");
    const out = JSON.parse(claudeHookOutput({ allow: false, reason: "No." }));
    expect(out).toEqual({ hookSpecificOutput: { hookEventName: "PreToolUse", permissionDecision: "deny", permissionDecisionReason: "No." } });
  });

  test("the real hook input of Claude Code has the shape the guard reads", () => {
    const hook = JSON.parse(readFileSync(fixture("claude", "hook-pre-tool-use.json"), "utf8"));
    allowed(input("worker", hook.tool_name, hook.tool_input, { cwd: WT }));
    const d = decide(input("reviewer", hook.tool_name, { command: "rm x" }, { cwd: hook.cwd }));
    expect(d.allow).toBe(false);
  });
});

describe("worker", () => {
  test("worker: writes a file inside the worktree", () => {
    allowed(write("worker", `${WT}/src/a.ts`));
    allowed(input("worker", "Edit", { file_path: "src/a.ts" }));
    allowed(input("worker", "MultiEdit", { file_path: `${WT}/src/deep/er/a.ts` }));
    allowed(input("worker", "NotebookEdit", { notebook_path: `${WT}/n.ipynb` }));
  });

  test("C7: a worker writes inside the feature folder and the hook refuses the write", () => {
    expect(denied(write("worker", `${FF}/SPEC.md`))).toMatch(/feature folder/);
    expect(denied(write("worker", `${FF}/run/state.json`))).toMatch(/feature folder/);
    expect(denied(input("worker", "Edit", { file_path: "docs/features/demo/TASKS.md" }))).toMatch(/feature folder/);
    expect(denied(bash("worker", `echo x > ${FF}/run/progress.md`))).toMatch(/feature folder/);
    expect(denied(bash("worker", "sed -i s/a/b/ docs/features/demo/PLAN.md"))).toMatch(/feature folder/);
    expect(denied(bash("worker", "touch PLAN.md", { cwd: FF }))).toMatch(/feature folder/);
  });

  test("C7: a worker writes into the feature folder with a Codex patch", () => {
    const patch = `*** Begin Patch\n*** Update File: docs/features/demo/TASKS.md\n@@\n-a\n+b\n*** End Patch`;
    expect(denied(input("worker", "apply_patch", patch))).toMatch(/feature folder/);
    expect(denied(input("worker", "apply_patch", { input: patch }))).toMatch(/feature folder/);
    expect(denied(bash("worker", `apply_patch <<'EOF'\n${patch}\nEOF`))).toMatch(/feature folder/);
  });

  test("worker: a Codex patch inside the worktree is allowed, and one outside is refused", () => {
    allowed(input("worker", "apply_patch", "*** Begin Patch\n*** Add File: src/new.ts\n+x\n*** Update File: src/old.ts\n@@\n-a\n+b\n*** End Patch"));
    expect(denied(input("worker", "apply_patch", "*** Begin Patch\n*** Update File: ../other/x.ts\n@@\n-a\n+b\n*** End Patch"))).toMatch(/worktree/);
    expect(denied(input("worker", "apply_patch", "*** Begin Patch\n*** Update File: src/a.ts\n*** Move to: /etc/a.ts\n*** End Patch"))).toMatch(/worktree/);
    expect(denied(input("worker", "apply_patch", "*** Begin Patch\n*** Delete File: /tmp/x\n*** End Patch"))).toMatch(/worktree/);
  });

  test("worker: a write outside the worktree is refused, also with ../ and absolute paths", () => {
    expect(denied(write("worker", "/work/other/a.ts"))).toMatch(/worktree/);
    expect(denied(write("worker", `${WT}/../other/a.ts`))).toMatch(/worktree/);
    expect(denied(write("worker", "../a.ts"))).toMatch(/worktree/);
    expect(denied(write("worker", "/work/wt-sibling/a.ts"))).toMatch(/worktree/);
    expect(denied(write("worker", `${WT}/src/../../x.ts`))).toMatch(/worktree/);
    allowed(write("worker", `${WT}/src/../lib/x.ts`));
    expect(denied(bash("worker", "echo x > ../x.txt"))).toMatch(/worktree/);
    expect(denied(bash("worker", "rm -rf /work/other"))).toMatch(/worktree/);
    expect(denied(bash("worker", "cp a.ts /tmp/a.ts"))).toMatch(/worktree/);
    expect(denied(bash("worker", "mv a.ts ../a.ts"))).toMatch(/worktree/);
    expect(denied(bash("worker", "cd .. && touch x"))).toMatch(/worktree/);
    expect(denied(bash("worker", "echo x | tee ~/notes.txt"))).toMatch(/worktree/);
    expect(denied(bash("worker", 'echo x > "$HOME/x"'))).toMatch(/worktree/);
  });

  test("worker: a write with no worktree is refused", () => {
    expect(denied(write("worker", `${WT}/a.ts`, { worktree: null }))).toMatch(/worktree/);
  });

  test("worker: shell commands inside the worktree are allowed", () => {
    allowed(bash("worker", "echo hi > src/out.txt"));
    allowed(bash("worker", "mkdir -p src/new && touch src/new/a.ts"));
    allowed(bash("worker", "cp a.ts b.ts"));
    allowed(bash("worker", "mv a.ts src/b.ts"));
    allowed(bash("worker", "sed -i s/a/b/ src/a.ts"));
    allowed(bash("worker", "cat src/a.ts | grep foo > /dev/null 2>&1"));
    allowed(bash("worker", "ls -la && git status && git diff HEAD~1"));
    allowed(bash("worker", "git add src/a.ts"));
    allowed(bash("worker", "rm src/old.ts", { cwd: `${WT}/src` }));
    allowed(bash("worker", "grep -rn jest src"));
    allowed(bash("worker", 'echo "a > b" > src/notes.txt'));
  });

  test("worker: starship commands are always allowed", () => {
    allowed(bash("worker", 'starship check T012'));
    allowed(bash("worker", 'starship ask --task T012 "Which table does the recipe use?"'));
    allowed(bash("worker", 'starship ask --task T012 "can I run bun run typecheck > out?"'));
    allowed(bash("worker", "/usr/local/bin/starship check T012 2>&1"));
  });

  test("D10: a worker runs a heavy command and the hook names starship check", () => {
    for (const c of ["bun run typecheck", "yarn typecheck:web", "npx tsc --noEmit", "pytest -q", "uv run pytest", "yarn install", "bun install", "yarn workspace x exec vitest run", "cd src && npx jest"]) {
      expect(denied(bash("worker", c))).toContain("starship check <task>");
    }
    expect(denied(bash("worker", 'bash -lc "bun run typecheck"'))).toContain("starship check <task>");
    expect(denied(bash("worker", "echo ok && tsc -p ."))).toContain("starship check <task>");
    expect(denied(bash("worker", "FOO=1 pytest"))).toContain("starship check <task>");
    expect(denied(input("worker", "shell", { command: ["bash", "-lc", "bun run typecheck"] }))).toContain("starship check <task>");
    expect(denied(input("worker", "exec_command", { cmd: "pytest -q" }))).toContain("starship check <task>");
  });

  test("D10: a worker's heavy pattern matches whole words only, and reading about a tool is not running it", () => {
    allowed(bash("worker", "bun test engine/test/notes.test.ts"));
    allowed(bash("worker", "echo mytsc"));
    allowed(bash("worker", "cat docs/jest-notes.md"));
    expect(denied(bash("worker", "bun run typecheck", { heavyPatterns: ["typecheck"] }))).toContain("starship check <task>");
    allowed(bash("worker", "bun run typecheck", { heavyPatterns: [] }));
  });

  test("D10: any role, a worker included, that runs a heavy command is refused with starship check", () => {
    for (const role of ["admin", "orchestrator", "reviewer", "cardRunner"] as const) {
      expect(denied(bash(role, "bun run typecheck"))).toContain("starship check <task>");
    }
  });

  test("D10: a worker runs git commit and the hook refuses it", () => {
    expect(denied(bash("worker", 'git commit -m "x"'))).toMatch(/commit/i);
    expect(denied(bash("worker", "git add -A && git commit -m x"))).toMatch(/commit/i);
    expect(denied(bash("worker", "git -C /work/wt commit --amend"))).toMatch(/commit/i);
    expect(denied(bash("worker", "git -c user.name=x commit -m x"))).toMatch(/commit/i);
    expect(denied(bash("worker", 'sh -c "git commit -m x"'))).toMatch(/commit/i);
    expect(denied(bash("worker", "git cherry-pick abc"))).toMatch(/commit/i);
    expect(denied(input("worker", "shell", { command: ["git", "commit", "-m", "x"] }))).toMatch(/commit/i);
    expect(denied(bash("worker", 'git commit -m "x"'))).toContain("starship check");
  });

  test("D10: a worker runs a push and the hook refuses it", () => {
    for (const c of ["git push", "git push origin HEAD", "git -C /work/wt push -f", "git --no-pager push", "echo x; git push", 'bash -c "git push"']) {
      expect(denied(bash("worker", c))).toMatch(/push/i);
    }
    expect(denied(bash("admin", "git push origin main"))).toMatch(/push/i);
    expect(denied(bash("orchestrator", "git push"))).toMatch(/push/i);
  });

  test("worker: a git command that writes outside the worktree is refused", () => {
    expect(denied(bash("worker", "git -C /work/other add x"))).toMatch(/worktree/);
    expect(denied(bash("worker", "git checkout main", { cwd: "/work/other" }))).toMatch(/worktree/);
  });

  test("worker: a command that holds a write inside a command substitution is checked", () => {
    expect(denied(bash("worker", "echo $(touch /tmp/x)"))).toMatch(/worktree/);
    expect(denied(bash("worker", 'echo "$(rm -rf /tmp/x)"'))).toMatch(/worktree/);
    expect(denied(bash("worker", "echo `rm /tmp/x`"))).toMatch(/worktree/);
    expect(denied(bash("worker", "find /work -name x -delete"))).toMatch(/worktree/);
    expect(denied(bash("worker", "find /work -name x -exec rm {} \\;"))).toMatch(/worktree/);
    expect(denied(bash("worker", "ls | xargs rm"))).toMatch(/worktree/);
    expect(denied(bash("worker", "dd if=a of=/tmp/b"))).toMatch(/worktree/);
    expect(denied(bash("worker", "curl -o /tmp/f http://x"))).toMatch(/worktree/);
  });

  test("worker: a Write tool of an unknown name is judged by its input", () => {
    allowed(input("worker", "mcp__fs__write", { path: `${WT}/a.ts` }));
    expect(denied(input("worker", "mcp__fs__write", { path: `/etc/a` }))).toMatch(/worktree/);
    expect(denied(input("worker", "Foo", { file_path: `${FF}/SPEC.md` }))).toMatch(/feature folder/);
    expect(denied(input("worker", "sandbox_exec", { command: "touch /etc/x" }))).toMatch(/worktree/);
    allowed(input("worker", "Read", { file_path: "/etc/hosts" }));
    allowed(input("worker", "Grep", { pattern: "x", path: "/etc" }));
    allowed(input("worker", "mcp__thing__query", { q: "x" }));
  });

  test("worker: the Codex workdir sets the directory a relative path is read against", () => {
    allowed(input("worker", "shell", { command: ["bash", "-lc", "touch a.ts"], workdir: `${WT}/src` }));
    expect(denied(input("worker", "shell", { command: ["bash", "-lc", "touch a.ts"], workdir: "/tmp" }))).toMatch(/worktree/);
  });
});

describe("admin", () => {
  test("admin: writes the plan files in the feature folder", () => {
    for (const f of ["SPEC.md", "PLAN.md", "TASKS.md", "ACCEPTANCE.md", "PROMPTS.md"]) allowed(write("admin", `${FF}/${f}`));
    allowed(write("admin", `${FF}/wireframes/login.html`));
    allowed(write("admin", `${FF}/wireframes/sub/a.html`));
    allowed(input("admin", "Edit", { file_path: "docs/features/demo/PLAN.md" }));
    allowed(bash("admin", `mkdir -p ${FF}/wireframes`));
    allowed(bash("admin", `cat > ${FF}/SPEC.md`));
  });

  test("admin: writes decision records in the adr folder", () => {
    allowed(write("admin", `${ADR}/2026-11-11-x.md`));
    allowed(bash("admin", `echo x >> ${ADR}/2026-11-11-x.md`));
  });

  test("B11: the admin agent tries to edit code and the hook refuses the write", () => {
    expect(denied(write("admin", `${WT}/src/a.ts`))).toMatch(/never edits code|plan files/);
    expect(denied(input("admin", "Edit", { file_path: `${WT}/engine/src/guards.ts` }))).toMatch(/plan files/);
    expect(denied(input("admin", "MultiEdit", { file_path: `${WT}/a.ts` }))).toMatch(/plan files/);
    expect(denied(input("admin", "NotebookEdit", { notebook_path: `${WT}/a.ipynb` }))).toMatch(/plan files/);
    expect(denied(bash("admin", "echo x > src/a.ts"))).toMatch(/plan files/);
    expect(denied(bash("admin", "sed -i s/a/b/ src/a.ts"))).toMatch(/plan files/);
    expect(denied(bash("admin", "rm src/a.ts"))).toMatch(/plan files/);
    expect(denied(bash("admin", "mv src/a.ts src/b.ts"))).toMatch(/plan files/);
    expect(denied(bash("admin", "cp README.md src/README.md"))).toMatch(/plan files/);
    expect(denied(bash("admin", "echo x | tee src/a.ts"))).toMatch(/plan files/);
    expect(denied(bash("admin", "chmod +x src/run.sh"))).toMatch(/plan files/);
    expect(denied(bash("admin", "git checkout -- src/a.ts"))).toMatch(/plan files|git/);
    expect(denied(input("admin", "apply_patch", "*** Begin Patch\n*** Update File: src/a.ts\n@@\n-a\n+b\n*** End Patch"))).toMatch(/plan files/);
    expect(denied(bash("admin", `python3 -c "open('src/a.ts','w').write('x')"`))).toMatch(/plan files/);
  });

  test("B11: the admin agent's paths cannot slip out of the plan folders", () => {
    expect(denied(write("admin", `${FF}/../../../src/a.ts`))).toMatch(/plan files/);
    expect(denied(write("admin", `${FF}/wireframes/../../../../src/a.ts`))).toMatch(/plan files/);
    expect(denied(write("admin", `${ADR}/../../src/a.ts`))).toMatch(/plan files/);
    expect(denied(write("admin", `${FF}/run/state.json`))).toMatch(/plan files/);
    expect(denied(write("admin", `${FF}/run/handoffs.md`))).toMatch(/plan files/);
    expect(denied(write("admin", `${FF}/sub/SPEC.md`))).toMatch(/plan files/);
    expect(denied(write("admin", `${FF}/notes.txt`))).toMatch(/plan files/);
    expect(denied(write("admin", `${FF}/wireframes-evil/a.html`))).toMatch(/plan files/);
    expect(denied(write("admin", `${ADR}-other/a.md`))).toMatch(/plan files/);
    expect(denied(write("admin", `${FF}/SPEC.md`, { featureFolder: null }))).toMatch(/plan files/);
    expect(denied(bash("admin", "echo x > ../../../src/a.ts", { cwd: FF }))).toMatch(/plan files/);
    allowed(bash("admin", "echo x > SPEC.md", { cwd: FF }));
    expect(denied(bash("admin", "echo x > SPEC.md"))).toMatch(/plan files/);
  });

  test("B11: with no feature folder the admin agent can still write decision records", () => {
    allowed(write("admin", `${ADR}/a.md`, { featureFolder: null }));
    expect(denied(write("admin", `${ADR}/a.md`, { adrDir: null }))).toMatch(/plan files/);
  });

  test("admin: refuses a write to TASKS.md once the build has started, and allows the other plan files", () => {
    const over = { buildStarted: true };
    expect(denied(write("admin", `${FF}/TASKS.md`, over))).toMatch(/TASKS\.md/);
    expect(denied(write("admin", `${FF}/TASKS.md`, over))).toMatch(/orchestrator/);
    expect(denied(input("admin", "Edit", { file_path: `${FF}/tasks.md` }, over))).toMatch(/TASKS\.md/);
    expect(denied(bash("admin", `echo x >> ${FF}/TASKS.md`, over))).toMatch(/TASKS\.md/);
    expect(denied(input("admin", "apply_patch", "*** Begin Patch\n*** Update File: docs/features/demo/TASKS.md\n*** End Patch", over))).toMatch(/TASKS\.md/);
    allowed(write("admin", `${FF}/PLAN.md`, over));
    allowed(write("admin", `${FF}/ACCEPTANCE.md`, over));
    allowed(write("admin", `${FF}/wireframes/a.html`, over));
    allowed(write("admin", `${ADR}/a.md`, over));
    allowed(write("admin", `${FF}/TASKS.md`, { buildStarted: false }));
  });

  test("admin: refuses git commit and a push, and allows starship and read commands", () => {
    expect(denied(bash("admin", 'git commit -m "plan"'))).toMatch(/commit/i);
    expect(denied(bash("admin", "git push"))).toMatch(/push/i);
    expect(denied(bash("admin", "git add -A"))).toMatch(/plan files/);
    allowed(bash("admin", 'starship note --to orchestrator --said "do it" "Do it."'));
    allowed(bash("admin", 'starship answer Q3 "Use the users table."'));
    allowed(bash("admin", "starship plan check"));
    allowed(bash("admin", "ls docs && cat docs/features/demo/SPEC.md | head -20 && git log --oneline && git status"));
    allowed(input("admin", "Read", { file_path: `${WT}/src/a.ts` }));
    allowed(input("admin", "Glob", { pattern: "**/*.ts", path: WT }));
  });
});

describe("read-only roles", () => {
  const roles = ["orchestrator", "reviewer", "cardRunner"] as const;

  test("orchestrator, reviewer and card runner: every write tool is refused", () => {
    for (const role of roles) {
      expect(denied(write(role, `${WT}/src/a.ts`))).toMatch(/writes nothing/);
      expect(denied(write(role, `${FF}/PLAN.md`))).toMatch(/writes nothing/);
      expect(denied(write(role, `${ADR}/a.md`))).toMatch(/writes nothing/);
      expect(denied(input(role, "Edit", { file_path: "src/a.ts" }))).toMatch(/writes nothing/);
      expect(denied(input(role, "NotebookEdit", { notebook_path: "a.ipynb" }))).toMatch(/writes nothing/);
      expect(denied(input(role, "apply_patch", "*** Begin Patch\n*** Add File: a.ts\n+x\n*** End Patch"))).toMatch(/writes nothing/);
      expect(denied(input(role, "mcp__fs__write", { path: "a.ts" }))).toMatch(/writes nothing/);
    }
  });

  test("orchestrator, reviewer and card runner: every shell command that writes is refused", () => {
    const writes = [
      "echo x > a.txt",
      "echo x >> a.txt",
      "cat a | tee b",
      "rm a",
      "mv a b",
      "cp a b",
      "mkdir d",
      "touch a",
      "chmod +x a",
      "sed -i s/a/b/ a",
      "sed -i.bak s/a/b/ a",
      "git add a",
      "git checkout main",
      "git reset --hard",
      "git stash",
      "ls && rm a",
      "bash -c 'touch a'",
      "echo x &> a",
      "cat a 1> b",
      "python3 -c \"open('a','w').write('x')\"",
      "node -e \"require('fs').writeFileSync('a','x')\"",
    ];
    for (const role of roles) {
      for (const c of writes) expect(denied(bash(role, c))).toMatch(/writes nothing/);
    }
  });

  test("orchestrator, reviewer and card runner: reading and starship commands are allowed", () => {
    const reads = [
      "ls -la",
      "cat src/a.ts",
      "rg foo src",
      "git status",
      "git diff main...HEAD",
      "git log --oneline -5",
      "git show HEAD",
      "git blame src/a.ts",
      "git ls-files",
      "git rev-parse HEAD",
      "git -C /work/wt diff",
      "cat a > /dev/null",
      "cat a 2>&1",
      "cat a 2>/dev/null | head",
      'echo "a > b"',
      "echo 'rm -rf /' | cat",
      "starship task add --phase 2 --text x --files a --verify y",
      "starship note ack 3 4",
      'starship finding add --sev high --where a.ts:3 "boom"',
      'starship card result C1 pass "ok"',
    ];
    for (const role of roles) {
      for (const c of reads) allowed(bash(role, c));
      allowed(input(role, "Read", { file_path: "/etc/hosts" }));
      allowed(input(role, "Grep", { pattern: "x", path: WT }));
    }
  });

  test("orchestrator, reviewer and card runner: a path trick does not matter, a write is a write", () => {
    for (const role of roles) {
      expect(denied(bash(role, `echo x > ${WT}/../x`))).toMatch(/writes nothing/);
      expect(denied(write(role, `${WT}/./a/../b.ts`))).toMatch(/writes nothing/);
    }
  });
});

describe("both tool families", () => {
  test("Claude Code: Bash, Write, Edit and NotebookEdit; Codex: shell with an array, exec_command, apply_patch", () => {
    // Claude Code
    expect(denied(input("reviewer", "Bash", { command: "rm a", description: "x" }))).toMatch(/writes nothing/);
    expect(denied(input("reviewer", "Write", { file_path: "a", content: "x" }))).toMatch(/writes nothing/);
    // Codex
    expect(denied(input("reviewer", "shell", { command: ["bash", "-lc", "rm a"] }))).toMatch(/writes nothing/);
    expect(denied(input("reviewer", "shell", { command: ["rm", "a b"] }))).toMatch(/writes nothing/);
    expect(denied(input("reviewer", "local_shell", { command: ["touch", "a"] }))).toMatch(/writes nothing/);
    expect(denied(input("reviewer", "exec_command", { cmd: "touch a" }))).toMatch(/writes nothing/);
    expect(denied(input("reviewer", "apply_patch", "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch"))).toMatch(/writes nothing/);
    expect(denied(input("reviewer", "apply_patch", { patch: "*** Begin Patch\n*** Add File: a\n+x\n*** End Patch" }))).toMatch(/writes nothing/);
    expect(denied(input("reviewer", "apply_patch", "diff --git a/x b/x\n--- a/x\n+++ b/x\n@@\n-a\n+b\n"))).toMatch(/writes nothing/);
    allowed(input("reviewer", "shell", { command: ["bash", "-lc", "cat a | head"] }));
    allowed(input("reviewer", "shell", { command: ["starship", "finding", "add", "--sev", "low", "--where", "a:1", "x > y"] }));
    allowed(input("reviewer", "exec_command", { cmd: "ls" }));
  });

  test("the reason is one plain sentence for the agent", () => {
    const reasons = [
      denied(write("worker", "/etc/a")),
      denied(write("admin", `${WT}/a.ts`)),
      denied(write("reviewer", `${WT}/a.ts`)),
      denied(bash("worker", "bun run typecheck")),
      denied(bash("worker", "git commit -m x")),
      denied(bash("worker", "git push")),
    ];
    for (const r of reasons) {
      expect(r.length).toBeGreaterThan(10);
      expect(r).not.toContain("\n");
      expect(r.trim().endsWith(".")).toBe(true);
    }
  });

  test("nothing to judge is allowed: an empty command, an empty input, an unknown shape", () => {
    allowed(bash("reviewer", ""));
    allowed(input("reviewer", "Bash", {}));
    allowed(input("reviewer", "Bash", null));
    allowed(input("reviewer", "Mystery", { a: 1 }));
    allowed(input("worker", "Bash", "ls -la"));
  });
});

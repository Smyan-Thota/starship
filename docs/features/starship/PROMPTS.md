# Prompts — Starship

Each prompt below is written for a coding agent that builds one phase.

Status: All phases were built by parallel builder agents and checked by a minder. The minder is the agent that ran every verify command itself, corrected the builders' work and edited the prompts. The prompts below are the record of the plan, not the commands that were run.

Who does what: builder agents built the phases. The minder checked them.

## Prompt 0 — inspect

```text
Read AGENTS.md, docs/ARCHITECTURE.md, the six ADRs in docs/adr/, and
docs/features/starship/SPEC.md, PLAN.md, TASKS.md, ACCEPTANCE.md.

The ADRs are Proposed. The owner ordered the build on 2026-11-11. See docs/adr/README.md.
Do not write code.

Report: files you will touch, contradictions between the documents,
unnecessary complexity, and the commands you will use to verify.
Do not broaden the scope. Stop.
```

## Prompt 1 — Phase 0

```text
Implement Phase 0 of docs/features/starship/TASKS.md only: T001–T009.
A parser that cannot read a line reports the file and the line number. It never guesses.
A parse followed by a write gives the same bytes.
Tests set STARSHIP_HOME to a temp folder.
Run each task's verify command. Check off only verified tasks.
Run the Phase 0 checkpoint. Stop.
```

## Prompt 2 — Phase 1

```text
Implement Phase 1 only: T010–T019.
Do NOT start an agent. Do NOT add tmux code. Do NOT build the Tauri shell.
The server binds 127.0.0.1 only. Every route except /health needs the token.
The page is dark only. Labels and data only. It holds no state.
An .html file never renders in the page.
Run each verify command and the checkpoint. Stop.
```

## Prompt 3 — Phase 2

```text
Implement Phase 2 only: T020–T029.
Read ADR agents-in-tmux first. The engine sends only pasted text, Enter and Escape.
Hooks go in a per-session settings file. Never write under ~/.claude or ~/.codex.
Tests use the fake agent and tmux sessions that start with sst-. Kill them in teardown.
Tests never start the real claude or codex.
A message is never dropped: it is queued, sent, answered, or notSent.
Run each verify command and the checkpoint. Then stop for manual check M1.
```

## Prompt 4 — Phase 3

```text
Implement Phase 3 only: T030–T036.
Do NOT implement the task loop, the run queue, or commits.
The admin agent writes only plan files and docs/adr/. The orchestrator writes nothing directly.
A wireframe opens in the browser. It never renders in the page.
The page has no answer buttons.
Run each verify command and the checkpoint. Then stop for manual check M2.
```

## Prompt 5 — Phase 4

```text
Implement Phase 4 only: T040–T053.
Read ADR engine-runs-the-loop and ADR one-worktree-per-chat first.
A task is checked only after the engine ran its verify command and it exited 0.
At most 3 checks per task. Then the orchestrator decides.
The orchestrator never types to a worker.
One heavy command at a time on the whole Mac. Only the engine runs checks.
The engine commits a verified task's listed files. It never pushes.
Notes are delivered only at a task boundary.
Run each verify command and the checkpoint. Then stop for manual check M3.
```

## Prompt 6 — Phase 5

```text
Implement Phase 5 only: T060–T063.
Reviewers write nothing. Findings go through `starship finding add`.
A card is "unclear", never "fail", when the environment is down.
The fix list adds one phase, once.
Run each verify command and the checkpoint. Then stop for manual check M4.
```

## Prompt 7 — Phase 6

```text
Implement Phase 6 only: T070–T073.
The map format is the snapshot format: layers, boxes with code chips,
pipes with a kind and a label, flows with path cards and numbered steps.
A file with a step that names a missing pipe is refused.
Ship no example flow. A repo map has its overview. A chat adds "This plan".
Run each verify command and the checkpoint. Then stop for manual check M5.
```

## Prompt 8 — Phase 7

```text
Implement Phase 7 only: T080–T082.
A move happens only at a task boundary. The in-flight task's check runs first.
A stale number whose reset time has passed counts as 0%. An unknown number moves nothing.
Run each verify command and the checkpoint. Then stop for manual check M7.
```

## Final prompt — Phase 8, docs and acceptance

```text
Implement Phase 8: T090–T096.
Run tauri build alone. It is a heavy command.
Compare docs/ARCHITECTURE.md against the code and correct it.
Do not add roadmap items or rejected options to it.
Run every item in ACCEPTANCE.md and every ADR Confirmation check.
Update the "Done when" section of TASKS.md for verified items only. Stop.
```

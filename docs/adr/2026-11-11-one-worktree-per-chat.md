# One worktree per chat, one heavy check at a time

Status: Proposed
Date: 2026-11-11
Deciders: the owner
Spec: docs/features/starship/SPEC.md

## Context

An agent that runs a typecheck in several worktrees at once can use almost all the memory of a Mac and restart it. This happened once with three parallel `tsc` runs. Starship must never do this. A repo can also have two checks that must not run together, because one rewrites generated files that the other reads.

A chat has two or three workers. Where do they work, and who may run what?

## Decision drivers

- The Mac never runs two heavy commands together.
- Workers can work in parallel.
- A worker's change can be undone task by task.
- The owner's own checkout is never touched.

## Decision

We will give each chat one git worktree on its own branch. All agents of the chat work in it. Tasks marked `[P]` touch different files, so workers do not collide.

- **Run queue.** Only the engine runs checks. One heavy command runs at a time on the whole Mac, across all chats. A repo setting lists what counts as heavy and which commands conflict.
- **Guard.** A hook refuses a heavy command, `git commit` and `git push` from any agent.
- **Commit.** After a task's check passes, the engine commits that task's listed files on the chat's branch. A changed file that no task lists is not committed. It is listed in `run/progress.md` under "Outside the task".
- The engine also commits the plan files: when the owner starts the build, and at a task boundary when they changed. A repo setting turns this off.
- The engine never pushes.

## Alternatives

### A. A worktree for each worker — rejected

Full isolation. Rejected because each one needs its own install, memory multiplies, and the work must be merged.

### B. No worktree: the owner's checkout — rejected

Nothing to set up. Rejected because agents would collide with the owner's own work.

### C. One worktree per chat, engine-run checks, one commit per task

Meets all four drivers.

## Consequences

- Workers share one install, for example one `node_modules`.
- A worker can touch a file outside its task. The engine shows it and Review flags it.
- Checks wait in line. A build is slower than the sum of its tasks.

## Confirmation

- A test: two heavy checks from two chats never overlap in time.
- A test: a commit holds only the task's listed files.
- A test: `git push`, `git commit` and a heavy command from an agent are refused by the hook.
- `grep -rn "push" engine/src/run` finds no git push.

## Anchors

- `AGENTS.md`, section "Heavy commands": run typecheck, build and test suites one at a time.

## Revisit when

Two workers in one worktree block each other often. Then allow a second worktree for a chat.

## Open questions

None.

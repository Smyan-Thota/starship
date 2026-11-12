# The engine runs the build loop, and the orchestrator agent decides

Status: Proposed
Date: 2026-11-11
Deciders: the owner
Spec: docs/features/starship/SPEC.md

## Context

The owner fears that agents go "spinning around in circles" and waste tokens. The owner also wants an orchestrator agent that holds the plan and directs two or three workers, and that the owner can open and read.

The task file format in `docs/templates/TASKS.md` gives each task its files, a verify command, and a `[P]` mark for tasks that can run together. The rule in `docs/templates/PROMPTS.md` is "Check off only verified tasks."

Who picks the next task, and who decides that a task is done?

## Decision drivers

- A task is done only when its check has run and passed.
- No tokens are spent on steps a rule can do.
- Judgment is available when a rule cannot decide.
- The owner can see an orchestrator and read its prompt.

## Decision

We will split the work in two.

**The engine** does every step a rule can do. It reads `TASKS.md`, picks the next ready task, sends the worker its prompt, and waits for the worker's turn to end. Then it runs that task's verify command through the run queue. Exit 0 checks the task off. Any other result sends the last 200 lines of output back to the same worker. After 3 failed checks, the engine stops that task and asks the orchestrator.

A task is ready when its phase is the current one, the tasks before it that are not `[P]` are checked off, and no task in flight lists one of its files. At the end of a phase the engine runs the phase's Checkpoint command through the run queue. A failed checkpoint stops the build and goes to the orchestrator.

**The orchestrator agent** is asked only for judgment:

1. At the start of each phase: read the plan files and report contradictions.
2. At a task boundary with unread notes: change the tasks that have not started.
3. After 3 failed checks on one task: fix the task, split it, or block it for the owner.

It acts through `starship task add|edit|split|block`. It never types to a worker.

## Alternatives

### A. The orchestrator agent drives every step — rejected

Closest to how the owner first described it. Rejected because "done" would be an agent's claim, the agent drifts over 20 tasks, and every step costs tokens.

### B. No orchestrator agent — rejected

Cheapest. Rejected because a plan change in the middle of a build, or a task that keeps failing, needs judgment.

### C. Engine loop plus an orchestrator for judgment

Meets all four drivers.

## Consequences

- The `TASKS.md` grammar is load-bearing. A line the parser cannot read stops the build.
- The orchestrator is quiet most of the time. The window still shows it, with its prompt and its terminal.
- A loop is bounded: 3 checks per task, then the orchestrator, then the owner.

## Confirmation

- A test: a fake worker says "done" while its check fails. The task stays unchecked.
- A test: the fourth attempt on one task never starts without an orchestrator decision.
- The orchestrator role prompt contains no instruction to message a worker.

## Anchors

- `docs/templates/TASKS.md` — task grammar, `[P]`, checkpoints.
- `docs/templates/PROMPTS.md` — "Check off only verified tasks."

## Revisit when

Real builds show the orchestrator is called at almost every boundary. Then give the engine more rules.

## Open questions

None.

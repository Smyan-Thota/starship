# TASKS — {feature}

Depends on: docs/features/{slug}/PLAN.md, accepted ADR {YYYY-MM-DD-slug}, spec docs/features/{slug}/SPEC.md

Each task: `- [ ] T0xx [P?] {behavior} — {files} — verify: {command} ({trace tag})`

`[P]` means different files and no dependency on an unfinished task in the same phase.
The trace tag names where the task comes from: `(in scope #N)`, `(plan: Edge C2)`, `(ADR {slug}: Confirmation 1)`. Every item under "In scope" in PLAN.md needs a task that names it.

## Phase 0 — Foundation

Blocks every later phase.

- [ ] T001 {contract or shared primitive} — `{path}` — verify: `{command}` (plan: Interfaces)

Checkpoint: {what is true} — `{command}`

## Phase 1 — {one user-visible slice}

Goal: {one sentence}
Independent check: {how to see this slice work before later phases exist}

- [ ] T010 [P] {behavior} — `{files}` — verify: `{command}` (in scope #1)
- [ ] T011 Do not {ADR violation this task could introduce}. — `{files}` — verify: `{ADR Confirmation check}` (ADR {slug}: Confirmation 1)

Checkpoint: {slice works on its own} — `{command}`

## Phase N — Rollout

- [ ] T0xx {flag, docs, or cleanup named in the plan} — `{files}` — verify: `{command}` (plan: Rollout)

## Done when

- [ ] Every in-scope behavior has a checked task
- [ ] No out-of-scope item has code
- [ ] Every Confirmation check in the ADRs passes
- [ ] `{the repo's test command}` passes
- [ ] `docs/ARCHITECTURE.md` matches the code

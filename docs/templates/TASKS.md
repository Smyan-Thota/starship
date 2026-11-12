# TASKS — {feature}

Depends on: docs/features/{slug}/PLAN.md, accepted ADR {YYYY-MM-DD-slug}, spec {url}

Each task: `- [ ] T0xx [P?] {behavior} — {files} — verify: {command or click-path} ({trace tag})`

`[P]` means different files and no dependency on an unfinished task in the same phase.

## Phase 0 — Foundation

Blocks every later phase.

- [ ] T001 {contract or shared primitive} — `{path}` — verify: {command} (plan: Interfaces)

Checkpoint: {what is true} — `{command}`

## Phase 1 — {one user-visible slice}

Goal: {one sentence}
Independent check: {how to see this slice work before later phases exist}

- [ ] T010 {behavior} — `{files}` — verify: {test or click-path} (plan: In scope #1)
- [ ] T011 Do not {ADR violation this task could introduce}. — `{files}` — verify: {ADR Confirmation check} (ADR {slug}: Confirmation 1)

Checkpoint: {slice works on its own} — `{command}`

## Phase N — Rollout

- [ ] T0xx {flag, docs, or cleanup named in the plan} — `{files}` — verify: {check}

## Done when

- [ ] Every in-scope behavior has a checked task
- [ ] No out-of-scope item has code
- [ ] Every Confirmation check in the ADR passes
- [ ] `uv run pytest` and `uv run ruff check .` pass offline
- [ ] `docs/ARCHITECTURE.md` matches the code

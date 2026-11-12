# Prompts — {feature}

Written for a coding agent. One prompt at a time. Review the diff between prompts.

## Prompt 0 — inspect

```text
Read AGENTS.md, docs/ARCHITECTURE.md, the ADRs this plan cites, and
docs/features/{slug}/PLAN.md, TASKS.md, ACCEPTANCE.md.

Do not write code.

Report: files you will touch, contradictions between the documents,
unnecessary complexity, and the commands you will use to verify.
Do not broaden the scope. Stop.
```

## Prompt 1 — Phase 0

```text
Implement Phase 0 of docs/features/{slug}/TASKS.md only: T001–T00x.
Do not implement anything from later phases.
Run `starship check <task>` for each task. Check off only verified tasks.
Run the Phase 0 checkpoint. Stop.
```

## Prompt N — Phase N

```text
Implement Phase N only: T0x0–T0xx.
Do NOT implement: {items from Out of scope}.
Run `starship check <task>` for each task, and the ADR Confirmation checks.
Check off only verified tasks. Run the checkpoint. Stop.
```

## Final prompt — docs and acceptance

```text
Run every item in ACCEPTANCE.md.
Compare docs/ARCHITECTURE.md against the code and correct it. Do not add
roadmap items or rejected options to it.
Update the "Done when" section of TASKS.md for verified items only. Stop.
```

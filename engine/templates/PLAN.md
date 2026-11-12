# PLAN — {feature}

Status: Draft
Date: YYYY-MM-DD
Spec: docs/features/{slug}/SPEC.md
ADRs: {YYYY-MM-DD-slug, accepted}
Branch:

## Goal

{What a user can do when this plan is finished, and the success measure from the spec.}

## In scope

1. {Behavior copied from the spec's scope. Each item gets a task that names it: `(in scope #1)`.}

## Out of scope

- {Item copied from the spec's Deferred list.}

An implementer does not build an out-of-scope item from this plan.

## Design rules

- {Concern} lives in `{path}`.
- Reuse `{existing component}`.
- {Invariant from an ADR, written as a rule.}
- Apply the repo rules this change touches, as listed in `AGENTS.md`.

## Data

{Staff checklist: data. Tables, files, types. Reuse an existing one before you add one. Say how many tables the change touches.}

## Interfaces (API)

{Staff checklist: API. Signatures, routes, commands, enums, state machines. Enough that two implementers would not invent different shapes. No function bodies.}

## Error and edge behavior

{Staff checklist: errors and edge cases.}

| Condition | Result |
| --- | --- |
| {missing input, upstream failure, conflict} | {named error, retry, or exit code} |

## Test strategy

{Staff checklist: tests. What proves each in-scope item, and why this mix fits the problem. Name the fixtures.}

## Rollout

{Staff checklist: rollout. Order of steps, flag, migration, rollback. Write "One step, no rollback needed" when that is true.}

## Risks

- {Risk} — {what we do if it shows up}

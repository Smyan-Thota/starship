# PLAN — {feature}

Status: Draft
Date: YYYY-MM-DD
Spec: {tracker URL}
ADRs: {YYYY-MM-DD-slug, accepted}
Branch:

## Goal

{What a user can do when this plan is finished, and the success measure
from the spec.}

## In scope

1. {behavior copied from the accepted spec}

## Out of scope

- {item copied from the spec's deferred list}

An implementer does not build an out-of-scope item from this plan.

## Design rules

- {concern} lives in `{path}`.
- Reuse `{existing component}`.
- {Invariant from the ADR, written as a rule.}
- Apply the repo rules this change touches, as listed in `AGENTS.md`.

## Interfaces

{Signatures, enums, state machines, or data shapes. Enough that two
implementers would not invent different shapes. No function bodies.}

## Error and edge behavior

| Condition | Result |
| --- | --- |
| {missing input, upstream failure, conflict} | {named error, retry, or exit code} |

## Rollout

{Flag, environment order, migration, rollback. Delete this section when the
change ships in one step.}

## Risks

- {risk} — {what we do if it shows up}

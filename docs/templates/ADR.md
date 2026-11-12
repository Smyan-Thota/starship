# {the decision in one line}

Status: Proposed {Proposed | Accepted | Rejected | Superseded}
Date: YYYY-MM-DD
Deciders:
Consulted:
Informed:
Spec: {tracker URL}
Supersedes:
Superseded by:

## Context

{Two or three paragraphs of facts and forces in tension. Name existing
modules and, where it matters, real numbers. End with the single question
this ADR answers.}

## Decision drivers

- {a quality, constraint, or force a good option has to satisfy}

## Decision

We will {imperative sentence}.

{The concrete shape: model or contract, who owns it, what is reused, what
is new. If a name or a field is still open, say so. Do not leave the
decision itself open.}

## Alternatives

### A. {obvious shortcut} — rejected

{What it is.} Rejected because {which driver it fails, and when that cost shows up}.

### B. {other real option} — rejected

{Same shape.}

### C. {chosen option}

{One sentence on why it wins. The Decision section is the source of truth.}

## Consequences

- {what gets easier}
- {the cost: new module, second surface, migration, operational burden}
- {what this decision explicitly does not decide}

## Confirmation

A later reviewer or agent checks compliance by:

- {invariant, for example "no call to time.sleep outside the injected default"}
- {test, grep, or review check}

## Anchors

- `path/to/file.py::symbol` — {why this existing code constrains the decision}

## Revisit when

{A concrete change in context that should produce a new ADR.}

## Open questions

{Questions that block acceptance. Move anything that can ship as a default
into the spec. Empty this section before Status becomes Accepted.}

# Acceptance — {feature}

Written before the build starts. "Done" means every item below holds. The build checks against this list; it does not decide on its own that the feature looks finished.

## Behavior

{One block per in-scope item. Given inputs, expected outputs, counts where relevant.}

## Errors

{One line per failure mode: condition -> message -> exit code. Expected failures print no traceback.}

## Tests

- `{the repo's test command}` passes with the network unavailable.
- {Specific assertions that must exist.}

## Manual checks

- M1: {what to do, and what the owner sees.}

`M1` is the id that TASKS.md names as "manual check M1". Keep each id stable.

## Story cards

{One block per card the card runner acts out in the built app.}

### {Card title}

{One sentence: who does what, and why.}

- {Acceptance criterion the card runner can see in the app.}

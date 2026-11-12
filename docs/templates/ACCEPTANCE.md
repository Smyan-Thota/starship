# Acceptance — {feature}

Written before the agent starts. "Done" means every item below holds. The agent checks against this list; it does not decide on its own that the feature looks finished.

## Behavior

{One block per in-scope behavior. Given inputs, expected outputs, request counts where relevant.}

## Errors

{One line per failure mode: condition -> message -> exit code. Expected failures print no traceback.}

## Tests

- `uv run pytest` passes with the network unavailable.
- {Specific assertions that must exist, e.g. "three mocked pages produce exactly three requests".}

## Manual smoke

```bash
{command that exercises the real upstream, documented but not automated}
```

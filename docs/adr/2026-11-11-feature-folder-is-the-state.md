# The feature folder is the state

Status: Proposed
Date: 2026-11-11
Deciders: the owner
Spec: docs/features/starship/SPEC.md

## Context

A chat can change model in the middle of a build, lose an agent, or be halted for a day. The next agent must continue with no memory of the chat before it. The owner must be able to read every file the agents produce. The plan files follow the templates in `docs/templates/`. They come from the public repo `vivekchopra/rate-limited-cli`. In that method, the plan files of a feature live in the repo under `docs/features/<slug>/`.

Where does the state of a chat live?

## Decision drivers

- Any agent on any model can continue from it.
- The owner can read all of it.
- Plan files can be reviewed in the repo. Run files never pollute a commit.
- No second source of truth.

## Decision

We will keep all work state for a chat as files in `docs/features/<slug>/` inside the chat's worktree, plus its decision records in `docs/adr/`.

- **Plan files** may be committed: `SPEC.md`, `PLAN.md`, `TASKS.md`, `ACCEPTANCE.md`, `PROMPTS.md`, `wireframes/`, and decision records in `docs/adr/`.
- **Run files** live in `run/` and are excluded through `$GIT_COMMON_DIR/info/exclude`: `progress.md`, `handoffs.md`, `questions.md`, `prompts/`, `review/`, `logs/`, `inbox/`, `patches/`, `state.json`, and `map-overlay.json`, which holds the plan's pieces on the repo map.
- Formats are Markdown and JSON only.
- **One writer.** The engine is the only writer of run files. Agents change them through the `starship` CLI. The admin agent writes plan files directly. Once a build starts, only the engine writes `TASKS.md`.
- The engine keeps a registry under `~/.starship/`: which chats exist, which tmux sessions belong to them, and queued sends. Agent sessions in it can be rebuilt from tmux.

A parser that cannot read a line reports the line number and stops. It never guesses.

## Alternatives

### A. A database — rejected

Fast queries. Rejected because agents cannot read it, and it becomes a second source of truth.

### B. State in each agent's conversation — rejected

Nothing to build. Rejected because it is lost on a model switch or a crash.

### C. A folder outside the repo — rejected

No effect on the repo. Rejected because plan files must be reviewable in the repo, and agents work with relative paths.

### D. Files in the worktree, split into plan files and run files

Meets all four drivers.

## Consequences

- The file formats are a contract. A hand edit is legal and must be handled.
- Two writers on one run file cannot happen, because every run-file write goes through the engine.
- The chat log, `messages.jsonl`, lives in the registry, because a chat with no repo has no folder. It is the one thing that cannot be rebuilt.
- A wireframe is a plan file, but the window never renders it. It opens in the browser.

## Confirmation

- A test deletes `~/.starship/chats/<id>/chat.json` agent entries, restarts the engine, and gets the same tasks, notes and progress.
- `grep -rn "writeFile" engine/src` shows run-file writes only inside `engine/src/folder/`.
- `find . -name "*.yml" -o -name "*.yaml"` finds nothing outside `node_modules`.

## Anchors

- `docs/templates/TASKS.md` — the task line grammar the parser must accept.
- `git worktree` — `info/exclude` lives in the common git dir and applies to every worktree.

## Revisit when

A repo refuses a `docs/features/` folder. Then make the folder path a repo setting.

## Open questions

None.

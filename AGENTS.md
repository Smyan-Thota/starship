# AGENTS.md

Rules for any agent that works in this repo.

## Source of truth

- The plan files in `docs/features/starship/` say what to build. Do not build an item from the spec's Deferred list, which the plan repeats as Out of scope.
- The decision records in `docs/adr/` say why. A Proposed record may still be edited. A change to an Accepted decision is a new record.
- `docs/ARCHITECTURE.md` describes the target until the build ends, and what exists after that. Update it in the same change that alters what it describes.

## Layout and commands

- `engine/`: the engine and the `starship` CLI. Its tests are in `engine/test/`.
- `app/`: the window, in React. Component tests are in `app/test/`, browser tests in `app/e2e/`.
- `scripts/`: repo tools. `edges.ts` checks the plan's edge rows against the tests. `check-off.ts` checks a task off after its verify command passed.
- `fixtures/`: sample folders and files for the tests.
- `docs/`: the plan, the decision records, and the plan templates.

| Command | What it does |
| --- | --- |
| `bun run dev` | Starts the engine and prints the window's address. |
| `bun run test` | Runs the engine tests, then the window tests. |
| `bun run typecheck` | Checks both TypeScript projects. |
| `bun run --cwd app e2e <name>` | Builds the window and runs one browser test in Chrome. |
| `bun run edges --list` | Lists each edge row of the plan and whether a test proves it. |

## Hard rules

- JSON and Markdown only. Never add a `.yml` or `.yaml` file. The owner's own rules forbid agents to write YAML.
- TypeScript strict. No `any` without a comment that gives the reason.
- No new dependency unless `PLAN.md` lists it under Dependencies.
- No `git push`. No `git commit` unless the owner says so.
- Tests never read or write the real `~/.starship`, `~/.claude`, or `~/.codex`. They set `STARSHIP_HOME` to a temp folder.
- Tests never start the real `claude` or `codex`. They use the fake agent in `engine/test/fake-agent.ts`.
- tmux sessions made by tests start with `sst-`. Each test kills its sessions in teardown.
- The engine sends an agent's terminal only three kinds of input: the start command, pasted text followed by Enter, and Escape.

## Heavy commands

Run one at a time. A subagent runs one only when the agent that started it allows it. A heavy command is a typecheck, a test suite, a build or an install: each one uses much memory. Three typechecks at once have used almost all the memory of a Mac and restarted it.

- `bun run typecheck`
- `bun run test`, the whole repo
- `bun run --cwd app build`
- `bun run --cwd app e2e <name>`, which builds first
- anything with `tauri build`

A single test file is light: `bun test engine/test/tasks.test.ts`.

## Words

Use one name for each thing.

| Word | Meaning |
| --- | --- |
| owner | The one person who uses Starship. The owner decides. |
| chat | One unit of work: one conversation with the admin agent, one feature folder, one worktree, its agents. |
| stage | Where a chat works now: Map, Plan, Build or Review. |
| window | Starship.app's window. It shows the chat list, one page, and the conversation with the admin agent. |
| page | What the window shows in the middle: a TL;DR (the short summary of the chat in its stage), a plan file, the tasks, a file, an agent, or a map. |
| feature folder | `docs/features/<slug>/` inside the chat's worktree. The plan and all state of the chat, as files. |
| plan files | SPEC, PLAN, TASKS, ACCEPTANCE, PROMPTS, `wireframes/`, and the decision records. |
| run files | Everything under `run/` in the feature folder: progress, handoffs, questions, prompts, review, logs, inbox, patches, `state.json`, `map-overlay.json`. |
| engine | The one local process that starts, feeds and stops agents and runs checks. |
| agent | One Claude Code or Codex terminal session in tmux. |
| role | What an agent is for. admin: talks with the owner. orchestrator: decides what the engine's rules cannot. worker: builds one task. reviewer: tries to break the result. card runner: acts out story cards in the built app. |
| note | One instruction from the owner, as the admin agent understood it. The admin agent runs `starship note`, and the engine records the note in `run/handoffs.md`. |
| note status | `queued`: the note waits for delivery. `held`: it waits because its chat is halted. `read`: the orchestrator confirmed it with `starship note ack`; or the engine wrote a `plan` or `repo` note; or the fix list that holds a `fixes` note was sent. `undone`: the owner took it back. |
| turn | One stretch of work by an agent: from the text it gets to the moment it stops and waits. |
| decision record | A file in `docs/adr/` that holds one decision and its reason. Also written ADR. Its status is Proposed, Accepted, Rejected or Superseded. |
| task boundary | The moment a task's check ends with a result that counts: a pass, or a failure when no worker of the chat has the status `working`. A note for the orchestrator is delivered at the next one in the chat, or at once when the build has started and no task is in a turn. A worker that moves to the other tool at the usage threshold, or restarts because its conversation is nearly full, does so at the end of its own task. A dead session and a tool that reports its limit do not wait. |
| check | A task's verify command, run by the engine. To check a task off is to mark it done after its check passed. |
| run queue | The single line in which checks wait. One heavy command runs at a time. |
| Halt, Pause | Halt stops every agent of one chat except the admin agent. Pause stops one agent. Resume undoes either. |
| needs you | Something waits for the owner: an open question, a permission, a stalled agent, a `blocked` task, a build that stopped, a disputed finding, or a note the orchestrator never confirmed. It is the name of the list. An agent on the list has the status `needsYou`. A task on the list has the state `blocked`. |
| story card | A short test in Markdown: a title, a description, acceptance criteria. The card runner acts it out in a browser. |
| finding | One problem a reviewer reports, with a file and a line. |
| map | A picture of a repo: layers, boxes, the code inside each box, and labelled pipes between boxes. |
| staff checklist | The questions a staff engineer asks of a plan: data, API, errors, edge cases, tests, rollout. |

## UI copy

- Labels and data only. No sentence that explains how the product works.
- Dark theme only.
- A control names its action in one or two words, and it does that action.
- A wireframe never renders inside the window. It opens in the browser.

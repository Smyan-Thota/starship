# Starship

Status: built and tested. Two manual checks are open. `docs/features/starship/CHECKS.md` says what was checked and what was not.

Starship is a Mac app for one person, the owner, who runs Claude Code and Codex agents on the owner's repos. A local engine starts each agent in a tmux session, runs each task's check, and keeps state as files. A React window shows each chat. A chat is one unit of work: one conversation with the admin agent, one feature folder, one git worktree and its agents. A chat moves through four stages: Map (a picture of the repo), Plan (the plan files), Build (workers build the tasks, and the engine checks each one) and Review (reviewers try to break the result). `AGENTS.md`, section "Words", gives the meaning of each word.

## Needs

| Tool | Why |
| --- | --- |
| tmux | Each agent is one tmux session. Tested with tmux 3.8. |
| Bun | Runs the engine, the CLI and the tests. Tested with Bun 1.4.3. |
| git | Each chat gets a worktree. |
| Claude Code, Codex | The agents. The default roles use both. Settings sets the tool of each role. Tested with Claude Code 2.1.322 and Codex 0.166.0. |
| iTerm | Optional. "Terminal" opens iTerm, or Terminal when iTerm is not installed. |
| Rust with cargo | Only to build the Mac app. |

## Trust questions

Each tool asks whether you trust a folder. The engine never answers these questions. You answer them in the agent's terminal.

- A chat with no repo runs its agents in `~/.starship/chats/<id>/`. That folder is not a git root, so Claude Code treats it as trusted when `~/.starship` is trusted. To trust `~/.starship`, run `mkdir -p ~/.starship && cd ~/.starship && claude`, answer "Yes, I trust this folder", and leave Claude Code. Claude Code then asks no question in a chat with no repo.
- A chat on a repo runs its agents in the chat's git worktree. Claude Code asks its trust question once for each git worktree, also inside a trusted folder. Its default answer is "No, exit".
- Codex asks "Trust this folder?" once for each repo. Your answer covers every worktree of that repo. Answer with "1. Trust and continue". Escape quits Codex on that screen.
- A waiting agent shows under "needs you" as `<agent> · trust question`, with a Terminal button. Click Terminal and answer the question in the terminal. The work then goes on with no other action. The engine pastes no text into the agent before you answer.

## Your own Claude Code setup

Your own hooks and plugins run inside every Claude Code agent that Starship starts. The hooks of Starship's per-session settings file run next to yours. They do not replace yours. A global Stop hook that blocks makes an agent work longer: Claude Code then fires Stop a second time for the same turn.

The setting `claudeArgs` in `~/.starship/config.json` passes extra flags to every Claude Code agent. `["--setting-sources", "project,local"]` keeps your user-level hooks and plugins out of the agents. It also keeps your global `CLAUDE.md` rules out of them. The default is `[]`, which adds no flag. You decide which one to use.

## Run from the repo

```bash
bun install
bun install --cwd app
bun run --cwd app build
bun run dev
```

`bun run dev` starts the engine and prints its address, `http://127.0.0.1:<port>/?token=<token>`. Open that address in a browser. The first time, the window shows an empty chat list: press "New chat", give a title, and pick a repo or none. The engine keeps its settings in `~/.starship/config.json`, and the window's Settings page edits that file. The engine serves the window from `app/dist` when that folder exists.

Add a repo with `bun engine/src/cli.ts repo add <path>`, or in the window under New chat. The plan and the agents' prompts name a command `starship`. From the repo, that command is `bun engine/src/cli.ts`. The engine also gives each agent a `starship` program on its PATH.

## Build the Mac app

```bash
bun run --cwd app build
bun run --cwd app engine:build
bun run --cwd app tauri build
```

The first command builds the window into `app/dist`. The second compiles the engine to `app/src-tauri/binaries/starship-engine-aarch64-apple-darwin`, so it is for Apple silicon. The third makes Starship.app under `app/src-tauri/target/`. Run these one at a time. The first and the third are heavy commands.

## Test

```bash
bun run test                       # the engine's tests, then the window's tests
bun test engine/test/tasks.test.ts # one test file
bun run typecheck                  # both TypeScript projects
bun run edges --list               # which rows of PLAN.md's edge-case tables have a test
bun run --cwd app e2e <name>       # builds the window, then runs one browser test in Chrome
cargo test --manifest-path app/src-tauri/Cargo.toml   # the Rust tests of the Mac shell
```

`bun run test`, `bun run typecheck` and `bun run --cwd app e2e` are heavy: each one uses much memory and processor for minutes. Run one at a time. A test never reads or writes the real `~/.starship`, `~/.claude` or `~/.codex`, and never starts the real `claude` or `codex`.

## Where the plan and the decisions are

| File | What it holds |
| --- | --- |
| `AGENTS.md` | Rules for any agent that works in this repo, and the meaning of each word. |
| `docs/features/starship/SPEC.md` | What we build and what we leave out. |
| `docs/ARCHITECTURE.md` | What the system is, as the code builds it. |
| `docs/adr/` | Why. One file per decision. All six are Proposed. |
| `docs/features/starship/PLAN.md` | How: rules, interfaces, every edge case, the test strategy. |
| `docs/features/starship/TASKS.md` | The work, in phases. Each task has a check command. |
| `docs/features/starship/ACCEPTANCE.md` | What "done" means, and the manual checks M1 to M7. |
| `docs/features/starship/PROMPTS.md` | The prompt of each phase, as a record of the plan. |

## Folders

| Folder | What it holds |
| --- | --- |
| `engine/` | The engine and the `starship` CLI, in Bun and TypeScript. Its tests are in `engine/test/`. The plan templates of the Plan stage are in `engine/templates/`. |
| `app/` | The window, in React. Its tests are in `app/test/` and `app/e2e/`. |
| `app/src-tauri/` | The Mac shell, in Rust with Tauri. |
| `docs/templates/` | The original planning templates. See `docs/templates/README.md`. |
| `fixtures/` | Test data. See `fixtures/README.md`. |
| `scripts/` | `edges.ts` lists which edge cases have a test. `check-off.ts` checks a task off. |

## License

MIT. See `LICENSE`. The files in `docs/templates/` and `fixtures/rate-limited-cli/` come from another MIT-licensed repo, and their license is in `docs/templates/LICENSE-rate-limited-cli.txt`.

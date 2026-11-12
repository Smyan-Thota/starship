# CHECKS — Starship

The record of what was checked, by whom, and with what result. `ACCEPTANCE.md` holds the checks themselves.

Starship is the Mac app in this repo: a local engine and a window that run Claude Code and Codex agents on a repo and keep the plan in front of the owner. Builder agents wrote the code. The minder is the agent that ran every verify command itself and corrected the builders' work. The minder wrote this file on 2026-11-12. `AGENTS.md`, section "Words", gives the meaning of each word used here. A result marked **Pass** was seen by the minder in a command's output. A result marked **Not run** was not seen by anyone.

## State

- 69 of 71 tasks are checked off in `TASKS.md`. Each was checked off only after the minder ran its verify command and it passed.
- Two tasks are open. T091 (menu bar item) and T096 (the manual checks) need a person at the screen.
- Nothing is committed in the Starship repo. It is not a git repo yet. The commits named under the real runs are in scratch repos that those runs made.

## Automated checks

Last run by the minder on 2026-11-12, one command at a time.

| Command | Result |
| --- | --- |
| `bun run test` | 1073 engine tests and 225 window tests pass. 0 fail. |
| `bun run typecheck` | Exit 0 for the engine and the window. |
| `bun run edges` | Exit 0. 89 edge rows: 83 have a passing test, 6 are manual. |
| `bun run --cwd app e2e` | 42 tests pass in Google Chrome, in six specs: shell, chat, build, review, map, settings. |
| `cargo test` in `app/src-tauri` | 12 pass. |
| `bun run --cwd app engine:build`, then `bun run --cwd app tauri build` | Exit 0. `app/src-tauri/target/release/bundle/macos/Starship.app`, 82 MB, holds the engine and the window. |
| The two source checks of T029 and T052 | Empty: no write under the tools' home folders, no push. |

The engine tests and the Chrome tests use a stand-in agent, not Claude Code or Codex. The stand-in runs in real tmux and replays the real tools' hook inputs and screens from `fixtures/`.

## Runs with the real tools

Each run used the real engine, real tmux, a scratch engine home, and a scratch repo. The admin agent ran on Claude Code with the Haiku model. The workers ran on Codex. `fixtures/real-tools.json` holds every fact these runs gave.

| Run | What was done | Result |
| --- | --- | --- |
| 1 | One message to the admin agent of a chat with no repo. Then a build. | The reply arrived. The build did not move: the engine missed Codex's trust question. Four faults found. |
| 2 | A build of two tasks, after the fixes. | **Done.** Both tasks verified, one engine commit for each task. Two faults found: "ready" judged too early, and one failed attempt that the task did not earn. |
| 3 | The same build on a new scratch repo, after the fixes. | **Pass.** Both trust questions showed under "needs you". Nothing was pasted into them. After the two answers the build ended `done` in about 45 seconds, with 0 failed attempts. |
| 4 | Plan stage: the admin agent writes `SPEC.md`. | **Pass.** The file was written from the template, and the reply arrived. |
| 5 | A reply, Pause and Resume, a killed session. | Pass for all three. Two chat faults found. |
| 6 | Run 5 again, after the fixes. | **Pass.** The answer stays in the chat. After Pause and Resume the message is `answered`. |

### The faults found late

The real runs found eight faults. The Chrome tests found two more, numbers 7 and 8. All ten are fixed, and each fix has a test. A trust question is a screen where Claude Code or Codex asks the owner whether it may work in a folder.

1. Codex's trust question was taken for a screen to skip, and the worker stopped.
2. Claude Code asks its trust question for each new git worktree. The engine showed it as a permission, not as a trust question.
3. The owner's own Stop hook made an agent go on after its first "turn ended" signal. The engine took the first signal for the end.
4. A dialog of Claude Code can cover the prompt after a turn. A paste plus Enter would have confirmed it.
5. The engine judged Codex "ready" at a bare prompt that showed for a moment before the trust question.
6. A task got one failed attempt for a check that ran before its worker's turn.
7. Found in Chrome: Halt lost to a line that was already on its way to an agent, and the agent showed `idle`.
8. Found in Chrome: the admin agent's page showed no prompt.
9. With two "turn ended" signals in one turn, the chat showed only the last remark and lost the answer.
10. After Pause and Resume, the owner's message could end as `interrupted` although its answer arrived.

## Manual checks

| Check | Result | What ran | What is left for the owner |
| --- | --- | --- | --- |
| M1 one real agent | Part | Real runs 5 and 6: a reply, Pause and Resume, a restart after `tmux kill-session`. The message went in through the engine's route, not through a click in the window. | Step 1: trust `~/.starship` in Claude Code. Step 3: click Terminal and see iTerm open. Step 6: type in the agent's terminal. |
| M2 a real plan | Part | Real run 4: the admin agent wrote `SPEC.md`. | A full plan until `starship plan check` passes, then Start build in the window. |
| M3 the success measure | Not run as written | In its place, real runs 2 and 3: a real build of two tasks on a scratch repo. Halt, Resume and a note at a task boundary pass in Chrome with the stand-in agent. | The build of `vivekchopra/rate-limited-cli`, steps 1 to 4 of M3 in `ACCEPTANCE.md`. It needs a clone from GitHub and a long real build with real agents. The minder did not start that without the owner. |
| M4 a real review | Not run | In Chrome with the stand-in agent: a finding, a dispute, the refusal, the acceptance, and the fix list as a new phase. | All of it with real reviewers. |
| M5 the map | Part | In Chrome: the map of Starship itself draws every box and every pipe of `fixtures/maps/starship.json`, and no box covers another. | A map that the admin agent builds from a real repo. |
| M6 the Mac app | Part | The release app was started once on a scratch home. Its own engine answered `/health`, `/api/chats`, `/api/usage` and `/api/config`, and served the window. Quit ended the app and its engine. | Look at the window. The menu bar count, its Halt entry and the notification. The "Engine did not start" page. |
| M7 the usage switch | Not run | Stand-in tests for edge rows G1 to G6 and D12 pass. | A forced move with real tools. |

## What waits for the owner

1. **Git.** Nothing is committed in the Starship repo. `git init`, a first commit and a GitHub repo are the owner's call.
2. **The six decision records** in `docs/adr/` are Proposed. The code follows them as they stand.
3. **Your own Claude Code setup runs inside every Starship agent.** In each real run, your global fresh-eyes Stop hook fired inside the admin agent and made it start a reader of its own. The engine handles it, but each such turn takes more time and tokens. Three options, none chosen for you:
   - Leave it. This is the default: `claudeArgs` is `[]`.
   - Set `claudeArgs` to `["--setting-sources", "project,local"]` in `~/.starship/config.json`. This keeps your user-level hooks and plugins out. It also keeps your global `CLAUDE.md` rules out. Seen in a real session.
   - Make your own hook skip an agent that Starship started. Every such agent has the variable `STARSHIP_AGENT` in its environment.

   The minder's recommendation: leave the default until you have watched one real Plan session. The second option removes your global rules from every agent. The third needs a change in a plugin that is not part of this repo.
4. **Four plan points were built the way the minder recommended, without your answer.** A chat that adopts a feature folder opens in Plan. The "needs you" list holds agents that are `needsYou`, `stalled` or `stopped`. The window keeps one piece of state, an unsent draft. `POST /fixes/send` is refused unless the build is `done`. To change one of the four, name it: the change is small in each case.
5. **The steps in the table above** that need a person at the screen.
6. **Trust entries for scratch folders.** The real runs answered Claude Code's and Codex's trust questions for scratch folders under this session's temp folder. Both tools saved those answers in their own files: `~/.claude.json` holds entries for the scratch folder, and `~/.codex/config.toml` holds two `[projects."..."]` blocks with `trust_level = "trusted"` for the scratch repos. The minder counted the matching lines in both files and changed neither. The entries are harmless, and the owner can delete them.

## Known limits

- A Codex agent has no hook guard. Codex's own sandbox (`-s workspace-write -a never`) and the role prompt guard it. The engine lists a commit that a worker made under "needs you" and does not undo it.
- After Pause and Resume in the middle of a turn, the chat holds only the text written after "continue". The text before the pause is in the terminal.
- The admin agent's answer to the engine's own line "The chat is now in the <stage> stage" shows in the chat.
- A paste with no sign of delivery within 3 seconds counts as delivered. The stall watchdog is the backstop.
- Three screens come from descriptions, not from captures: Claude Code's permission prompt, and the usage-limit text of both tools.
- Unknown: whether a second Claude Code agent in a worktree that the owner already trusted is asked again. The real runs had one Claude Code agent for each worktree, so no run showed it.

## How to see it

```bash
cd ~/Desktop/Current/starship && bun run dev
```

Open the address it prints. For the Mac app:

```bash
open ~/Desktop/Current/starship/app/src-tauri/target/release/bundle/macos/Starship.app
```

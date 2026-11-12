# Acceptance — Starship

Written before the build. "Done" means every item below holds. An agent checks against this list. It does not decide on its own that the app looks finished.

## Behavior

**Chats and the window**
- A new chat with a repo gets a worktree, a branch, and `docs/features/<slug>/`. A new chat with no repo gets none of them.
- The window shows the chat list, one document page, and the admin chat. A reload shows the same state.
- No screen holds a sentence that explains how the product works.

**Terminals**
- For every agent of every role, "Terminal" opens an iTerm window attached to that agent's tmux session.
- The tmux detach keys, `Ctrl-b d` by default, detach. The agent's status does not change.
- The agent page shows the exact text of each prompt version. A line that came from a note shows the owner's words.

**Admin agent and notes**
- A message typed in the window reaches the admin agent's terminal once, and the reply shows in the chat.
- An instruction shows as one note with the owner's words next to it.
- A note written during a task is read only after that task's check ends.
- Undo works while the note is queued or held, and is refused after it is read.

**Plan**
- The admin agent's plan files pass the validators before "Start build" is enabled.
- A wireframe opens in the browser. No `.html` file renders in the window.

**Build**
- A task is checked only after the engine ran its verify command and it exited 0.
- A worker that says "done" with a failing check gets the last 200 lines of output and tries again. After the third failed check the orchestrator decides.
- Two heavy checks never run at the same time, across all chats.
- A verified task is one commit that holds only that task's listed files.
- Halt stops every agent of that chat except the admin agent. Resume continues each worker on its task.

**Review**
- Two reviewers on different tools write findings. A disagreement shows as disputed.
- The fix list becomes exactly one new phase in `TASKS.md`.

**Usage**
- With Claude at or over the threshold, a worker on Claude Code moves to Codex at its next task boundary. Its task's check runs before any new work.

**Restart**
- Stop the engine during a build and start it again. The page shows the same tasks, notes and progress. No prompt is pasted twice.

## Errors

Every row of tables A to I in PLAN.md holds. `bun run edges` passes. A row marked `M` is covered by a manual check below.

## Tests

- `bun run test` passes with no network, no real `claude`, and no real `codex`. It runs the engine's tests, then the window's tests in their own process.
- `bun run typecheck` passes.
- `bun run edges` passes.
- After the suite, `tmux ls` shows no session that starts with `sst-`.
- After the suite, the real `~/.starship`, `~/.claude` and `~/.codex` are unchanged.
- `test "$(grep -rhoE "send-keys[^;]*" engine/src | grep -vE "Enter|Escape" | wc -l)" -eq 0`

## Manual checks

These use the real tools, so they cost tokens. Record each in `docs/features/starship/CHECKS.md` with the date and the result.

**M1 — one real agent (end of Phase 2)**

```bash
bun run --cwd app build
bun run dev
```

Open the address that `bun run dev` prints.

1. Run `claude` once in `~/.starship` and answer its trust question. Claude Code then asks no trust question in a chat with no repo.
2. New chat with no repo. Send "say hello". The reply shows in the chat.
   The window shows no trust question for Admin. If it shows `admin · trust question` under "needs you", click Terminal and answer in the terminal. The reply then shows with no other action.
3. Click Terminal on Admin. iTerm opens on `ss-<chat>-admin`. Detach with `Ctrl-b d`.
4. Send a long task. Open the Admin page and press Pause. The turn stops. Press Resume.
5. Kill the tmux session by hand. Send a message. The chat shows "Admin restarted" and the reply.
6. Type in the admin's terminal. The turn shows in the chat as "from terminal".

**M2 — a real plan (end of Phase 3)**

1. Run `starship repo add <path>` on a scratch repo. Start a new chat on it. Ask for a small feature with one screen.
2. The plan files appear. `starship plan check --chat <id>` prints "plan is valid".
3. The wireframe opens in the browser.

**M3 — the success measure (end of Phase 4)**

1. Clone `vivekchopra/rate-limited-cli`. Run `starship repo add <path>` on the clone. Then `starship chat new --title v1 --repo rate-limited-cli --feature v1-repos-command`.
2. Start the build with two workers.
   The build is on a repo, so the agents run in the chat's worktree. Claude Code asks its trust question once for each git worktree, and Codex asks once for each repo. Each waiting agent shows under "needs you" as `<agent> · trust question`, with a Terminal button. Click Terminal and answer each question in the terminal. The engine answers none of them and pastes nothing before the answer. After the last answer the build goes on with no other action. Escape quits Codex at its question: answer "1. Trust and continue".
3. During the build: send one note, and press Halt and Resume once.
4. Every task is checked. `uv run pytest` passes. Each task is one commit.

**M4 — a real review (end of Phase 5)**

1. Plant one bug in a finished build. Start Review.
2. A reviewer reports it. The fix list goes to Build as one phase.

**M5 — the map (end of Phase 6)**

1. Run `starship map import fixtures/maps/starship.json --repo <name>` on a repo that you added. The map draws with its layers, boxes and labelled pipes.
2. A chat on that repo shows "This plan" with its pieces lit.

**M7 — the usage switch (end of Phase 7)**

1. Run the M3 build again with the Worker role set to Claude Code in Settings.
2. Set "Usage threshold %" in Settings below Claude's current use.
3. Each worker moves to Codex when its own task ends. Its task's check runs before any new work.

**M6 — the Mac app (end of Phase 8)**

1. Open Starship.app with the engine stopped. It shows "Starting engine", then the chats. (Edge A12)
2. Close the window during a build. `tmux ls` still shows the agents. (Edge D4)
3. Stop and start the engine with the window open. The page reconnects. (Edge I4)
4. Read `handoffs.md` in the window while a note is added. The page updates and keeps its place. (Edge C11)
5. Give an instruction that can be read two ways. The owner's words sit next to the note, and Undo works. (Edge B12)
6. The menu bar item shows the needs-you count. Its "Halt <chat title>" entry halts that chat.
7. Put a script that only sleeps in the engine's place and open the app. Within 5 seconds the app stops that process and shows "Engine did not start". (Edge I7)

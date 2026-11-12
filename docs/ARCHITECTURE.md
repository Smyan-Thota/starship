# Architecture

The decision records in `docs/adr/` explain why. This file says what the system is. `AGENTS.md`, section "Words", gives the meaning of each word used here: chat, stage, engine, agent, role, note, check, task boundary, Halt, needs you.

## Processes

```text
YOU        Starship.app: window (React) + Mac shell (Tauri)        iTerm or Terminal
              │  HTTP and one WebSocket, 127.0.0.1                     │ tmux attach
              ▼                                                        │
STARSHIP   Engine ── one Bun process ──────────────────────────────────┤
              │  new session, pasted text + Enter, Escape              │
              ▼                                                        ▼
TOOLS      tmux ── one session per agent: ss-<chat>-<agent> ───────────┘
              │ runs                          │ runs
              ▼                               ▼
           Claude Code (unchanged)        Codex (unchanged)
              │  hook → `starship hook` → events.jsonl ◀── the engine reads it every second
              │                        └─ POST /api/hook ───▶ the engine reads it at once
              │  reads the plan, edits files
              ▼
REPO       Worktree: code + docs/features/<slug>/   ◀── Engine: watch, check off, commit
           Checks: each task's verify command       ◀── Engine: run queue, one heavy at a time
```

| Process | What it is | Started by |
| --- | --- | --- |
| Window | The React page in `app/src`. It reads the engine over HTTP and one WebSocket, `/api/events`. | The Mac shell, or a browser on the address that `starship daemon` prints. |
| Mac shell | The Tauri program in `app/src-tauri/src`. It shows the window and a menu bar item. | The owner. |
| Engine | `engine/src/cli.ts daemon`. It binds `127.0.0.1` on the first free port from `portFrom` (default 8787). | The Mac shell, or `bun run dev`. |
| Agent | One tmux session, `ss-<chat>-<agent>`, that runs Claude Code or Codex inside a small wrapper shell. | The engine. |
| Hook program | `starship hook`, one short process for each hook event of a tool. | Claude Code or Codex. |
| Check | `sh -c <verify command>` in the chat's worktree, in its own process group. | The engine's run queue. |

The page gets the token in one of two ways. `starship daemon` prints `http://127.0.0.1:<port>/?token=<token>`, and opening it sets the cookie `starship`. The Mac shell reads `~/.starship/engine.json` and opens the same address.

The engine refuses a request with a foreign Host or Origin header. A route other than `/health` needs the token: a bearer header, the cookie, or `?token=`.

The engine keeps its token in `~/.starship/token` and reuses it after a restart. An open window works again with no new address.

The Mac shell uses an engine that answers `/health` within 1 second. Otherwise it starts the sidecar `starship-engine daemon --static <dist>` in the app's data folder. It stops that process when `/health` is silent for 5 seconds, and the window shows "Engine did not start". Closing the window hides it. Quitting stops only an engine that the shell started. The menu bar item reads `/api/chats` every 5 seconds. It shows the needs-you count, one Halt entry for each chat that is not halted, and a notification when a count rises.

## Parts of the engine

| Part | Owns | Does not |
| --- | --- | --- |
| `server.ts`, `api.ts` | The sockets, the token check, and every route. A refusal becomes 400, 404 or 409. | Hold state. |
| `engine.ts` | One of each part below, and the connections between them. It also owns the operations the routes call: stage, halt, resume, check, fix list, pause, restart. | Run a loop itself. |
| `cli.ts` | The `starship` command. `daemon` starts the engine. Repo, chat and map commands read and write files. The other commands call the engine over HTTP. | Hold state. |
| `config.ts`, `repos.ts`, `chats.ts` | Settings, repo files, and the chat folder with `chat.json` and `messages.jsonl`. `chatState` builds the one object that the window reads. | Start an agent. |
| `folder/` | Reading the feature folder. The parsers and writers for `TASKS.md`, notes, questions, findings and `progress.md`. The plan validator. | Guess at a line it cannot parse. |
| `sessions.ts` | Agents as tmux sessions: start, the ready wait, paste with its delivery check, Escape, restart, stop. Reading hook lines and the screen. The end of a Claude Code turn. The stall watch. | Send any other key. Answer a question that a tool asks. |
| `agents/` | `tmux.ts`, the only code that runs tmux. `claude.ts` and `codex.ts`: start flags, per-session settings, readers of hook input, and `claudeScreen` and `codexScreen`, which name what a capture of the screen shows. `roles.ts`: the role prompts. | Change the tools or the owner's global config. |
| `hooks.ts`, `hook-entry.ts` | The event log, the applied count, and the program that the tools run as their hook. | Trust an agent's claim that a task is done. |
| `guards.ts` | The decision to refuse a tool call: a write outside the role's files, a heavy command, a commit, a push. Only a Claude Code agent runs it, through its PreToolUse hook. | Decide anything else. |
| `chat.ts` | The owner's messages to the admin agent: outbox, one paste at a time, the reply, the restart of a lost admin agent. | Drop a message silently. |
| `run/loop.ts` | Picking tasks, sending prompts, deciding verified or failed, checkpoints. | Mark a task done without a check that exits 0. |
| `run/states.ts`, `run/state.ts` | The transition tables of task, agent, note and build. `run/state.json`. | |
| `run/queue.ts` | Running checks. One heavy command at a time on the whole Mac. A heavy command is a typecheck, a test suite, a build or an install. | Run two heavy commands together. |
| `run/commit.ts` | One commit for each verified task, and the plan commits. Setting a blocked task's edits aside as a patch. | Push. Undo a commit that a worker made. |
| `run/halt.ts`, `run/park.ts`, `run/notes-loop.ts`, `run/orchestrator.ts` | Halt and Resume. Questions that park a task. Delivery of notes. The orchestrator's asks and `starship task`. | Type to a worker. |
| `restart.ts` | The one recovery sequence at engine start. | |
| `usage/` | Reading usage numbers, the pure switch rule, and the executor that moves a worker. | Switch in the middle of a task. |
| `review/` | Starting two reviewers and the card runner, story cards, the fix list. | Write a finding itself. |
| `map/` | The map format and its validator, import, low-detail build, the plan overlay. | Draw. The window draws. |
| `worktree.ts`, `watch.ts`, `wireframes.ts`, `open.ts`, `terminal.ts` | One worktree for each chat. The folder watcher. Wireframe links. Opening a file in the browser. Opening iTerm or Terminal on a tmux session. | Touch the owner's own checkout. |
| `app/src` | The window. | Hold state except an unsent draft and view state. Render an `.html` file. |

## Seams

`engine/src/run/ports.ts` holds the seams that the loop uses. The loop reaches agents, checks and time only through them.

- `AgentPort`: `ensure`, `send`, `interrupt`, `restart`, `stop`, `status`, `mark`, `agents`, `on`. `Sessions` implements it on tmux. `send` takes one line. `on` delivers the events of every agent: started, turn start, turn end, needs you, stalled, signal, ended, usage.
- `CheckPort`: `enqueue` and `drop`. The engine implements it on `RunQueue`.
- `Clock`: `now`.

The engine wraps `Sessions` once. A new Codex agent gets one line first: "Read <prompt file> first". Its turn is marked quiet, so the loop does not take it for a task turn. An agent at its trust question gets no line. The wrapper holds the lines for the orchestrator, the reviewers and the card runner, and sends them after the owner has answered. The chat service keeps the owner's messages for the admin agent queued, and the loop hands a task out again.

The loop tests use in-memory fakes of the two ports. The engine tests use `engine/test/fake-agent.ts` in a real tmux session.

## Files on disk

```text
~/.starship/
  config.json            settings; a missing file gives the defaults. `bins`: the argv that starts each tool. `claudeArgs`: more flags for every Claude Code agent, default none.
                         `codexArgs`: flags for every Codex agent, default `-s workspace-write -a never`. `stallMin`, `maxWorkers`, `maxHeavy`: see PLAN.md, Paths.
  engine.json            { pid, port, token }, mode 0600; removed on a clean stop
  token                  the token, mode 0600; kept across restarts
  bin/starship           a script that runs this program; on the PATH of every agent
  locks/                 the lock folder of the heavy slot
  usage/claude-status.json   the newest Claude Code status line input of any agent
  usage-moves.json       the moves of workers between tools
  hook-errors.log        failures of the hook program
  repos/<name>.json      { name, path, baseBranch, featureDir, commitPlanFiles, checks, heavyPatterns, conflicts, review }
  repos/<name>.map.json  the repo map
  repos/<name>.notes.md  notes with the target `repo`
  worktrees/<repo>/<slug>/   the chat's worktree, on the branch starship/<slug>
  chats/<id>/
    chat.json            { id, title, repo, stage, halted, slug, worktree, branch, featureDir, createdAt, agents }
    messages.jsonl       the chat log: you, admin, system lines
    outbox.json          messages waiting to be pasted
    events.jsonl         one line for each hook event: { at, agent, tool, raw }
    events.applied       the number of lines that the engine has applied
    agents/<agent>.json  tool, model, tmux name, session id, status, last pasted text
    agents/<agent>.settings.json   the per-session settings of a Claude Code agent
    agents/<agent>.status.json     the newest status line input of that agent: its context use
    agents/<agent>.prompt.md       the role prompt
    inbox/               long messages of a chat with no feature folder

<worktree>/docs/features/<slug>/        the feature folder
  SPEC.md PLAN.md TASKS.md ACCEPTANCE.md PROMPTS.md
  wireframes/<name>.html, wireframes/links.json
  run/                   kept out of git through the repo's `info/exclude`
    state.json           build status, task states, attempts, runs, note deliveries, pending commit, sent ids, last fix sent
    progress.md handoffs.md questions.md map-overlay.json
    prompts/<agent>-<task>-v<n>.md     inbox/     patches/<task>-<run>.patch
    logs/<task>-<run>.log  logs/loop.log
    review/findings.md  review/story-cards.md  review/fixes.md
<worktree>/docs/adr/
```

A chat with no repo has no worktree and no feature folder. Its admin agent runs in `~/.starship/chats/<id>/`. A chat that starts with `--folder <path>` uses that folder in place, with no worktree and no branch.

## The hook path

1. The engine starts an agent in tmux with `STARSHIP_CHAT`, `STARSHIP_AGENT` and `STARSHIP_HOME` set.
2. Claude Code gets `--settings agents/<agent>.settings.json`. It names `starship hook claude` for SessionStart, UserPromptSubmit, Stop, Notification, SessionEnd and PreToolUse, and `starship status` as the status line. Codex gets `-c notify=[..., "hook", "codex"]`.
3. The tool runs `starship hook`. `hook-entry.ts` appends one line to `events.jsonl`. It needs no running engine, and it exits 0 even when it fails. Then it posts `POST /api/hook { chat }` to the engine with a limit of 300 ms, and the engine applies the line at once. It ignores a failed post, and the poll loop in step 5 applies the line.
4. For a Claude Code PreToolUse input, `hook-entry.ts` also asks `guards.decide` and prints a deny answer when the role may not do the call. Codex has no such hook.
5. The poll loop of `Sessions` runs every 1000 ms. It reads the lines after `events.applied`, turns each into an agent event, and writes the new count after each line. A line applies once, also after an engine restart.
6. `engine.ts` passes each event to the chat service, the build loop, the usage switch and the questions. Each change publishes `{ type: "chat", id }` on the WebSocket.
7. The window reads `GET /api/chats/:id` again.

`starship status` also writes `usage/claude-status.json` and the agent's own `agents/<agent>.status.json`. `Sessions` reads the first file once a second.

## Ready, delivery and the end of a turn

`Sessions` reads the screen of each agent with `tmux capture-pane`. `claudeScreen` and `codexScreen` name what a capture shows: `trust`, `dialog` (Claude Code only), `update` (Codex only), `permission` (Claude Code only), `busy`, `ready` or `unknown`.

1. **Ready.** An agent is ready when its own tool's `ready` screen shows in two polls in a row, at least 500 ms apart. A bare prompt glyph is not `ready`. A question on the screen at any poll wins over `ready`. Claude Code's SessionStart hook also announces its start. After `readyMs` (60 s) with no ready screen and no question for the owner, the engine kills the session. The agent is `stopped`.
2. **Delivery.** After each paste, `send` looks for up to 3 seconds for a sign that the tool took the text. Claude Code: a UserPromptSubmit event for that line, or a busy screen. Codex: a busy screen, or the line above its prompt. A question on the screen instead means the paste did not arrive: the status goes back to what it was, the agent is `needsYou`, and `send` throws `SendError`.
3. **Before a paste.** `send` reads the screen first. A Claude Code dialog over the prompt gets one Escape. When the dialog stays, the agent is `needsYou` with the need `other`, and `send` throws. A trust question, an update question or a permission prompt gets no key and no paste: the agent is `needsYou`, and `send` throws.
4. **The end of a Claude Code turn.** One turn can give several Stop events, for example when the owner's own Stop hook blocks. So a Stop is held. The turn ends when the screen is not `busy` in two polls in a row after the Stop. A later Stop of the same turn replaces the held one. A new prompt ends the turn before it. A Codex turn ends with its `notify` call.
5. **Questions at the start.** At a trust question, the agent is `needsYou` with the need `trust`, and the engine sends nothing. At Codex's update question the engine sends Escape once. At a dialog at the start, the agent is `needsYou` with the need `other`. After the owner's answer, the ready rule of item 1 starts the agent.
6. **The need.** `needsYou` has three needs: `trust`, `permission` and `other`. The "needs you" list shows `trust` as `<agent> · trust question`, with a Terminal button.

## The life of one task

1. `TASKS.md` parses. A line the parser cannot read stops the build with its line number.
2. A task is ready when its phase is current, earlier tasks of the phase are `verified`, and no active task lists one of its files.
3. The loop writes `run/prompts/<agent>-<task>-v<n>.md` and pastes one line that points at it. The task is `assigned`, then `working` when a turn starts with that line as its text. A turn of any other text does not start the task. A worker at a trust question starts no turn, so its task stays `assigned`, and no check runs.
4. The turn of the task ends. A task whose verify is prose goes to `blocked` with the reason "manual check". Any other task goes to `checking`.
5. The run queue runs the verify command and writes `run/logs/<task>-<run>.log`. A check times out after `checkTimeoutMin` (15).
6. Exit 0 makes the task `verified`. The engine checks the box in `TASKS.md` and commits the task's listed files. A changed file that no task lists goes under "Outside the task". The engine keeps the commit that it made last. A commit above it that the engine did not make, such as a worker's commit, stays in the branch. The engine lists it under "needs you" as "A commit the engine did not make: <sha> <subject>", once for each commit, and the build goes on.
7. A failure in a quiet worktree counts as an attempt. A worktree is quiet when no worker of the chat has the status `working`. The last 200 lines go back to the same worker. After `checkAttempts` (3) the task is `escalated`, and the orchestrator decides.
8. When every task of a phase is `verified`, the engine runs the phase checkpoint. The build is `done` when every phase has ended.

## The life of one note

1. The owner types in the window. The chat service queues the message in `outbox.json` and pastes it into the admin agent when it is idle.
2. The admin agent runs `starship note --to <target> --said "<words>" "<note>"`. The engine writes the note to `run/handoffs.md`.
3. A note to `plan` or `repo` is `read` at once. A note to `orchestrator` is `queued`, or `held` when the chat is halted. A note to `fixes` joins the fix list.
4. `NoteDelivery` sends all queued notes in one turn. That turn comes at the next task boundary, or at once when the build has started and no task is in a turn. The notes go in a file in `run/inbox/`, and the orchestrator gets one line that points at it.
5. The orchestrator runs `starship note ack <n>` and its task commands. When its turn ends, each acked note is `read`. Other notes are `queued` again.
6. A note that three deliveries did not get acked stays `queued` and shows under needs you.

## External contracts

- **tmux**: `new-session`, `load-buffer`, `paste-buffer -p -d`, `send-keys Enter`, `send-keys Escape`, `capture-pane`, `has-session`, `list-sessions`, `kill-session`, `delete-buffer`.
- **Claude Code**: `--settings`, `--append-system-prompt-file`, `--model`, `--resume`, then the flags of `claudeArgs`. Hooks and the status line command, as above. The hooks of the settings file run next to the owner's own hooks and plugins.
- **Codex**: `-C`, `-c notify=[...]`, `-m`, `resume <id>`, then the flags of `codexArgs`. The rollout file of the agent's session under `~/.codex/sessions`, found by session id.
- **iTerm and Terminal**: `osascript` runs `tmux attach -t <session>` in a new window. Terminal opens when iTerm is not installed.
- **git**: `worktree add`, `worktree remove`, `add`, `commit`, `restore`, `apply`, and the `info/exclude` file of the repo.

The engine answers no question that a tool asks. Claude Code's trust question defaults to "No, exit", and Codex's trust question quits on Escape. So the engine never presses Enter on a trust question and never sends Escape to Codex's. The owner answers in the agent's terminal.

- Claude Code asks once for each git worktree, also inside a trusted folder. A folder that is not a git root takes the trust of its parent. A chat with no repo runs in `~/.starship/chats/<id>/`, so it asks nothing when the owner has trusted `~/.starship`.
- Codex asks once for each repo. The answer covers every worktree of that repo.
- Codex's update question defaults to an installer. The engine sends it Escape once and never Enter.

## Not in the code

- A Codex agent has no PreToolUse guard. Codex's own sandbox (`codexArgs`, default `-s workspace-write -a never`) and the role prompt guard it. The sandbox refuses a write outside the workspace, and the agent still reaches the engine on 127.0.0.1.
- The engine has no guard that stops a Codex worker from running a heavy command or `git commit`. The role prompt forbids both. The engine lists a worker's commit under "needs you".

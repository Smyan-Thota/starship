# PLAN — Starship

Status: In force. The owner ordered the build on 2026-11-11. The six ADRs are still Proposed.
Date: 2026-11-11
Spec: docs/features/starship/SPEC.md
ADRs: 2026-11-11-engine-and-window, 2026-11-11-agents-in-tmux, 2026-11-11-feature-folder-is-the-state, 2026-11-11-engine-runs-the-loop, 2026-11-11-one-admin-agent, 2026-11-11-one-worktree-per-chat (all Proposed)
Branch: none yet

## Goal

The owner opens Starship.app, starts a chat on a repo, plans with the admin agent, starts the build, and watches tasks get checked by the engine. The owner can open any agent in iTerm at any time. Success measure from the spec: Starship builds `v1-repos-command` of `rate-limited-cli` with every task checked by the engine, through one Halt and Resume and one note at a task boundary. In a second build, one worker moves from Claude Code to Codex.

## In scope

1. Chats
2. One window
3. Real terminals
4. Prompts in the open
5. Admin agent, notes, questions
6. Map
7. Plan stage
8. Build stage
9. Review stage
10. Usage and the switch
11. Files
12. Roles and models as settings
13. Mac app
14. Restart safe

## Out of scope

- PR reviews
- Tools other than Claude Code and Codex
- Remote machines, cloud runs, Windows, Linux
- More than one person
- A terminal drawn inside the window
- Pushing a branch or opening a PR
- Setting up a repo's test environment for story cards
- A worktree for each worker

An implementer does not build an out-of-scope item from this plan.

## Design rules

- The engine is the only process that starts, feeds or stops an agent. (ADR engine-and-window)
- The engine binds `127.0.0.1` only. Every route except `/health` needs the token. (ADR engine-and-window)
- The token is the bearer header, the cookie `starship`, or `?token=`. The engine refuses a request with a foreign Host or Origin header.
- The engine keeps its token in `~/.starship/token` and reuses it after a restart, so an open window works again with no new address.
- After the start command, the engine sends an agent's terminal only pasted text followed by Enter, and Escape. (ADR agents-in-tmux)
- The engine answers no question that a tool asks. (fixtures/real-tools.json)
  - Claude Code asks a trust question once for each git worktree, also inside a trusted folder. Its default answer is "No, exit". A folder that is not a git root takes the trust of its parent. So a chat with no repo, which runs in `~/.starship/chats/<id>/`, asks nothing when the owner has trusted `~/.starship`.
  - Codex asks "Trust this folder?" once for each repo. The answer covers every worktree of that repo. Escape quits Codex on that screen.
  - The engine never presses Enter on a trust question and never sends Escape to Codex's. The agent is `needsYou` with the need `trust`. The "needs you" list shows it as "<agent> · trust question", with a Terminal button. The owner answers in the terminal, and the work goes on with no other action. Until then the engine pastes no text into the agent, and a task of that agent starts no turn and has no check.
  - Codex can ask an update question at its start. Its default answer runs an installer. The engine sends Escape once and never Enter.
  - A Claude Code dialog over the prompt (for example "Teach auto mode about your environment?") has the default answer "Yes". Before a paste the engine sends it one Escape. When the dialog stays, the agent is `needsYou`, and the engine pastes nothing.
  - A Claude Code permission prompt has the default answer "Yes". The engine never pastes into it.
- An agent is ready when its own tool's ready screen shows in two polls in a row, at least 500 ms apart. A bare prompt glyph is not a ready screen. A question on the screen wins over a ready screen.
- After each paste the engine checks that the tool took the text: for Claude Code a UserPromptSubmit event for that line or a busy screen, for Codex a busy screen or the line above its prompt. A paste into a question counts as not delivered: the agent is `needsYou`, and the sender gets an error.
- A Claude Code turn ends when a Stop event has arrived and the screen is not busy in two polls in a row. One turn can give several Stop events. A Codex turn ends with its `notify` call.
- A task is `checking` only after a turn that began with the task's own prompt line has ended. A paste that no turn followed, and a turn of another text, never send a task to `checking`.
- Hooks are set in a per-session settings file for Claude Code, and by `-c notify=` on the command line for Codex. No code writes under `~/.claude` or `~/.codex`. (ADR agents-in-tmux)
- A prompt longer than one line goes in a file. The pasted text is one line that points at the file. (ADR agents-in-tmux)
- The feature folder is the state. Markdown and JSON only. (ADR feature-folder-is-the-state)
- Run files have one writer: the code in `engine/src/folder/`. Agents use the `starship` CLI. (ADR feature-folder-is-the-state)
- A parser never guesses. In `TASKS.md`, a line it cannot read stops the build, with the file and the line number. In `handoffs.md` and `questions.md`, an entry it cannot read is reported and skipped, and the other entries still work. (ADR feature-folder-is-the-state)
- A task is checked only after its verify command exits 0, run by the engine. (ADR engine-runs-the-loop)
- At most 3 attempts per task before the orchestrator decides. An attempt is a failed check that counts: see the task loop. (ADR engine-runs-the-loop)
- The orchestrator never types to a worker. (ADR engine-runs-the-loop)
- A task boundary is the end of a check whose result counts: a pass, or a failure in a quiet worktree. A run that a worker asked for with `starship check`, a failure that will be run again, and a checkpoint are not task boundaries.
- A note to the orchestrator is delivered only at a task boundary in that chat, or at once when the build has started and no task is in a turn. Before the build starts, it waits for the start. A note to the plan, the fix list or the repo is recorded at once. (ADR one-admin-agent)
- The admin agent writes plan files and `docs/adr/` directly, and nothing else. The orchestrator writes nothing directly. It uses `starship task` and `starship note ack`. (ADR one-admin-agent)
- Once a build starts, no agent writes `TASKS.md`. The engine writes it: the checkbox when a check passes, and new or changed task lines when the orchestrator runs `starship task` or a fix list arrives. During a build, the admin agent still edits the other plan files directly, and it sends a change to the tasks as a note to the orchestrator.
- One heavy command at a time on the whole Mac. Only the engine runs checks, always through the run queue. A worker can ask for its check with `starship check`. (ADR one-worktree-per-chat)
- The engine commits a verified task's listed files. It never pushes. (ADR one-worktree-per-chat)
- A worker must never commit, and a Codex worker has no guard that stops it. The engine does not undo a commit that a worker made. It keeps the commit that it made last. Each commit above it that the engine did not make goes once under "needs you" as "A commit the engine did not make: <sha> <subject>". The build goes on.
- The engine commits the plan files when the owner starts the build, and again at a task boundary when they changed. A repo setting, `commitPlanFiles`, turns this off.
- A failed check counts as an attempt only when it also fails in a quiet worktree: no worker of that chat has the status `working`.
- The engine reads a run file again before every write. It never writes from an old copy. `progress.md` is derived, so a hand edit to it is overwritten.
- A hook event is never lost and never applied twice. `starship hook` appends the event to `events.jsonl` and needs no running engine. The engine reads the file every second. `chats/<id>/events.applied` holds the number of lines the engine has applied, and the engine applies the lines after that number.
- A stage is where the chat works now. The owner can open any stage's pages at any time. Only two moves have a gate: Plan to Build needs a valid plan, and Build to Review needs the build status `done`.
- No message, note or question is ever dropped silently. Each has a visible state.
- The states of a task, an agent, a note and a build live in one transition table in code, `engine/src/run/states.ts`. A test fails when a pair of state and event has no result. Where this file and that table differ, correct this file.
- The window never renders an `.html` file from the folder. It opens it in the browser.
- The window keeps no state except an unsent draft and view state. A reload shows the same chat state.
- Tests use `STARSHIP_HOME` in a temp folder, the fake agent, and tmux sessions that start with `sst-`.
- Apply the repo rules in `AGENTS.md`.

## Interfaces

### Paths

```text
~/.starship/
  config.json                 terminalApp, portFrom, workers, maxWorkers, checkAttempts, checkTimeoutMin, maxHeavy, stallMin,
                              contextRestartAt, switch, roles, bins, claudeArgs, codexArgs
                              bins: the argv that starts each tool, default { claude: ["claude"], codex: ["codex"] }
                              claudeArgs: flags that every Claude Code agent gets after the engine's own, default [].
                                ["--setting-sources", "project,local"] keeps the owner's user-level hooks and plugins out of the agents,
                                and also the owner's global CLAUDE.md rules. The owner chooses.
                              codexArgs: flags that every Codex agent gets, default ["-s", "workspace-write", "-a", "never"]:
                                Codex's own sandbox. A write outside the workspace is refused. The agent still reaches the engine on 127.0.0.1.
                              stallMin: minutes with no hook event and no screen change before a working agent is stalled, default 10, 1 to 240
                              maxWorkers: the most workers for one chat, default 3, 1 to 3; the chat gets the smaller of `workers` and `maxWorkers`
                              maxHeavy: heavy commands at once, must be 1; any other value is an error
  engine.json                 { pid, port, token }   mode 0600   removed on a clean stop
  token                       the token   mode 0600   kept across restarts
  bin/starship                a script that runs the CLI; it is on the PATH of every agent
  locks/                      the lock folder of the heavy slot
  usage/claude-status.json    the newest Claude Code status line input
  usage-moves.json            the moves of workers from one tool to the other
  hook-errors.log             failures of the hook program
  repos/<name>.json           { name, path, baseBranch, featureDir, commitPlanFiles, checks, heavyPatterns, conflicts, review }
                              featureDir: where feature folders live in the repo, default docs/features
                              checks: named commands, each { cmd, heavy }
                              heavyPatterns: a command that contains one of these words is heavy
                              conflicts: pairs of check names that never run together
                              review: what the card runner needs, such as the app's address (address, appAddress or url)
  worktrees/<repo>/<slug>/    the chat's worktree
  repos/<name>.map.json       the repo map
  repos/<name>.notes.md       notes with the target `repo`
  chats/<chatId>/
    chat.json                 { id, title, repo, stage, halted, slug, worktree, branch, featureDir, createdAt, agents }
    messages.jsonl            the chat log: you, admin, system lines
    outbox.json               messages waiting to be pasted
    events.jsonl              every hook event, one line each: { at, agent, tool, raw }
    events.applied            the number of lines of events.jsonl that the engine has applied
    agents/<agent>.json       { id, role, tool, model, cwd, promptFile, tmux, sessionId, status, lastPasted, error }
    agents/<agent>.settings.json    the per-session settings of a Claude Code agent
    agents/<agent>.status.json      the newest status line input of that agent
    agents/<agent>.prompt.md        the agent's role prompt
    inbox/<messageId>.md      long or multi-line messages of a chat with no feature folder

(docs/features below stands for the repo's featureDir)

<worktree>/docs/features/<slug>/
  SPEC.md PLAN.md TASKS.md ACCEPTANCE.md PROMPTS.md
  wireframes/<name>.html      plus wireframes/links.json: { "<name>": "<artifact url>" }
  run/                        excluded through info/exclude
    state.json                the loop's state: build status, task states, attempts, check runs, note deliveries,
                              pending commit, sent prompt ids, last fix sent
    progress.md handoffs.md questions.md
    patches/<task>-<run>.patch       edits set aside from a blocked or dropped task
    prompts/<agent>-<task>-v<n>.md
    review/findings.md review/story-cards.md review/fixes.md
    logs/<task>-<run>.log            run: a counter for each task. It goes up with every run of the check and never starts again.
    logs/loop.log                    the loop's own notes, such as a state change that the transition tables refuse
    inbox/                    long or multi-line messages, notes and briefs for an agent, answers to questions
    map-overlay.json
<worktree>/docs/adr/YYYY-MM-DD-slug.md
```

A chat with no repo has no worktree and no feature folder. Its admin agent runs in `~/.starship/chats/<chatId>/`. A chat made with `--folder <path>` uses that folder in place, with no worktree and no branch.

### File formats

```text
TASKS.md      - [ ] T0xx [P] {behavior} — `{files}` — verify: `{command}` ({trace})
              ## Phase N — {title}
              Checkpoint: {text} — `{command}`
              [P]: the task may run at the same time as the other [P] tasks of its phase.
              verify: `same` copies the command of the task before it. A verify text with no backtick span is prose: the engine
              runs nothing for that task, and its turn ends in `blocked` with the reason "manual check".
              ({trace}): where the task comes from, such as (plan: Edge C2) or (in scope #3).
              Other task state lives in run/state.json, never in this file.

handoffs.md   ## Note {n} · {YYYY-MM-DD HH:MM} · {stage} → {orchestrator|plan|fixes|repo}
              You: {the owner's words}
              Note: {one instruction}
              Status: {queued|read HH:MM|undone|held}

questions.md  ## Q{n} · {HH:MM} · {agent} · {task}
              {question}
              Status: {open|answered HH:MM}
              Answer: {text}

findings.md   ## F{n} · {high|medium|low} · {reviewer} · {file:line}
              {text}
              Status: {open|disputed|accepted|rejected}
              Dispute: {reviewer}: {why}
              Decision: {why}                       only when the owner gave a reason
              ## No findings · {reviewer}           a reviewer that found nothing

story-cards.md  ## C{n} · {title}
              Description: {text, may be empty}
              - {criterion}
              Result: {pass|fail|unclear|none}
              Note: {text}

fixes.md      - X{n} {text} — from {F{n}|Note {n}}

progress.md   One table: phase, verified, total. Then "Now": one line per running or waiting task.
              Then "Outside the task": changed files that no task lists. Then "Dropped": each dropped task with its reason. Then "Halted {time}" when halted.
```

### Data types

```ts
type Stage = 'map' | 'plan' | 'build' | 'review'
type Role = 'admin' | 'orchestrator' | 'worker' | 'reviewer' | 'cardRunner'
type Tool = 'claude' | 'codex'
type AgentStatus = 'starting' | 'working' | 'idle' | 'needsYou' | 'stalled' | 'stopped' | 'halted' | 'paused'
type TaskState = 'queued' | 'assigned' | 'working' | 'checking' | 'verified' | 'failed' | 'escalated' | 'parked' | 'blocked' | 'dropped'
type NoteStatus = 'queued' | 'read' | 'undone' | 'held'
type MessageState = 'queued' | 'sent' | 'answered' | 'notSent' | 'interrupted'

interface Task { id: string; phase: number; parallel: boolean; text: string; files: string[]; verify: string | null; verifyNote: string; trace: string; done: boolean; line: number }
//   verify is null when the line holds prose: a person checks that task, and the engine runs nothing.
interface Note { n: number; at: string; stage: Stage; to: 'orchestrator' | 'plan' | 'fixes' | 'repo'; said: string; note: string; status: NoteStatus; readAt?: string; line: number }
interface AgentView { id: string; name: string; role: Role; tool: Tool; model: string; tmux: string; status: AgentStatus; task: string | null; prompts: PromptVersion[]; history: { at: string; text: string }[] }
```

### CLI

```text
starship daemon [--port N] [--static <dir>]  start the engine; --static serves a built window, default app/dist when it exists
starship status [--json]                     is the engine running; Claude Code also runs it as its status line command
starship repo add <path> [--name <n>] [--base <branch>] | list
starship chat new --title <t> [--repo <name>] [--feature <slug>] [--folder <path>] | list
starship chat halt <id> | resume <id>
starship agent pause|resume|restart <chat> <agent>
starship term <chat> <agent>                 open iTerm, or Terminal, on that agent
starship hook <claude|codex> [json]          reads the hook input on stdin (claude) or as its last argument (codex); used only by the tools' hooks
starship note --to <target> --said "<words>" "<note>"      admin agent
starship note ack <n>...                                    orchestrator: "I have read these notes"
starship ask --task <id> "<question>"                       any agent
starship answer <Qn> "<text>"                               admin agent
starship task add --phase <n> --text "<t>" --files <a,b> --verify "<cmd>" [--parallel]    orchestrator
starship task edit <id> [--text "<t>"] [--files <a,b>] [--verify "<cmd>"]                orchestrator
starship task split <id> --into "<text 1>" "<text 2>"       its parts replace the task's line     orchestrator
starship task block <id> --reason "<why>"            the task goes to blocked               orchestrator
starship task drop <id> --reason "<why>"             its line leaves TASKS.md, and progress.md keeps it under "Dropped"     orchestrator, or the admin agent on the owner's word
starship task retry <id>                             an escalated task goes back to queued, once for each task     orchestrator
                                                     a blocked task goes back to queued     the admin agent on the owner's word
starship check <task>                       a worker asks the engine to run its task's check, through the run queue,
                                            and waits for the result. It does not check the task off, and it is not an attempt.
starship plan check                         prints what stops the plan from being valid          admin agent
starship finding add --sev high|medium|low --where <file:line> "<text>"     reviewers
starship finding none                                                       a reviewer that found nothing
starship finding dispute <n> "<why>"                                        reviewers
starship finding accept <n> | reject <n> "<why>"                            the admin agent on the owner's word
starship card result <card> pass|fail|unclear "<note>"                      card runner
starship map build <repo> | import <file> --repo <name> | validate <file>
starship map overlay <file>                 the admin agent writes the chat's "This plan" overlay to run/map-overlay.json
```

Every command that acts on a chat takes `--chat <id>`, or reads `STARSHIP_CHAT`. An agent's session carries `STARSHIP_CHAT`, `STARSHIP_AGENT` and `STARSHIP_HOME`. The CLI talks to the engine over HTTP with the token. `repo add`, `repo list`, `chat new`, `chat list`, `map validate` and `status` work without a running engine. The other commands need it.

### HTTP and WebSocket

```text
GET  /health                                                              no token
GET  /api/chats                         GET /api/chats/:id            the whole chat state
POST /api/chats                         { title, repo?, feature?, folder? }
GET  /api/repos                         POST /api/repos               { path, name?, base? }
GET  /api/repos/:name/map?chat=         the repo map, with the chat's overlay when `chat` is given
POST /api/repos/:name/map/import        { file }                      an absolute path; a file with errors is refused with the list
POST /api/repos/:name/map/build         a low detail map from the repo's folders
GET  /api/config                        PUT /api/config               the whole config
POST /api/chats/:id/messages            { id, text }                  id makes a resend safe
POST /api/chats/:id/messages/:mid/retry                               only for a message that is notSent or interrupted
POST /api/chats/:id/notes               { to, said, note }
POST /api/chats/:id/notes/ack           { numbers }
POST /api/chats/:id/notes/:n/undo
POST /api/chats/:id/questions           { task, text, agent }         POST .../questions/:q/answer   { text }
POST /api/chats/:id/findings            { sev, where, text, reviewer }
POST /api/chats/:id/findings/none       { reviewer }
POST /api/chats/:id/findings/:n/dispute { reviewer, why }             POST .../accept   { why? }   POST .../reject   { why }
POST /api/chats/:id/cards/:card/result  { result, note? }
POST /api/chats/:id/tasks               { agent, command, ... }       add, edit, split, block, drop, retry
POST /api/chats/:id/check               { task }                      waits for the check; answers { outcome, exit, tail }
POST /api/chats/:id/fixes/send                                        refused unless the build is done, and while a finding is disputed
                                                                      the fix list becomes one new phase
POST /api/chats/:id/halt                POST /api/chats/:id/resume    resume also starts a build again that stopped on its checkpoint
GET  /api/chats/:id/files               GET /api/chats/:id/file?path=
GET  /api/chats/:id/code?path=          a file of the worktree
GET  /api/chats/:id/plan/check          { problems }
POST /api/chats/:id/open?path=          opens an .html file in the browser
POST /api/chats/:id/open?wireframe=     opens a wireframe: its artifact url when it has one, else its file
POST /api/chats/:id/wireframes/:name/link   { url }
POST /api/chats/:id/map/overlay         { file }                      an absolute path; a file with errors is refused with the list
POST /api/chats/:id/agents/:a/terminal  POST .../pause   POST .../resume   POST .../restart   POST .../model { tool?, model? }
POST /api/chats/:id/stage               { stage }                     build: refused with the problems unless the plan is valid
                                                                      review: refused unless the build is done
GET  /api/usage
POST /api/hook                          { chat }                      applies the chat's new hook lines now
POST /api/refresh                       ?chat=<id>                    makes the engine push events; the CLI calls it after it writes files
WS   /api/events                        pushes { type }: chats, chat (with id), usage, repos, config. The window reads the named thing again.
GET  /<path>                            the built window, from --static or app/dist
```

### Task loop

```text
queued ──assign──▶ assigned ──turn starts──▶ working ──turn ends──▶ checking
checking ──exit 0──▶ verified ──commit──▶ (next task)
checking ──fail──▶ failed
failed ──attempt < 3──▶ working                (last 200 lines of the log go back to the same worker)
failed ──attempt = 3──▶ escalated ──orchestrator: task retry | block | drop──▶ queued | blocked | dropped
blocked ──the owner, through the admin agent: task retry | drop──▶ queued | dropped
working ──starship ask, or its agent is paused──▶ parked ──the answer, or Resume──▶ working
working ──turn ends, verify is prose──▶ blocked        reason "manual check"
```

A task is ready when its phase is the current phase, the tasks before it in the phase are `verified`, and no task that is `assigned`, `working`, `checking`, `failed`, `parked` or `escalated` lists one of its files. A dropped task has no line in `TASKS.md` any more, so it blocks nothing. A `[P]` task waits only for the earlier tasks that are not `[P]`. A `blocked` task holds back the later tasks that wait for it under this rule, until the owner decides.

A check that fails while another worker of the chat has the status `working` is run again when the worktree is quiet: when no worker of the chat has that status. A worker that waits for an answer, for a permission, or for Resume is not `working`. Until the second run ends, the task stays `checking` and the engine hands out no new task. Only a failure in a quiet worktree counts as an attempt. A timeout is a failure like any other. A check that Halt kills or drops is not an attempt.

The orchestrator returns an escalated task to `queued` with `starship task retry`, once for each task, and its attempts start again at 0. A second escalation of the same task goes to `blocked`. The orchestrator gets one turn for an escalated task: a task that is still `escalated` when that turn ends goes to `blocked` too. `starship task edit` does not change a task's state. `starship task split` takes the task's line out of `TASKS.md` and puts its parts there, `queued`. Only the owner moves a task out of `blocked`: the owner tells the admin agent, which runs `starship task retry` or `starship task drop`. That retry starts the attempts again at 0.

A `parked` task waits and keeps its files out of the ready rule. It has one of two causes: an open question, or a paused agent. It returns to `working` when that cause ends.

When every task of a phase is `verified`, the engine runs the phase's Checkpoint command through the run queue. The phase ends when the checkpoint passes. A phase with no Checkpoint line ends when its last task is `verified`. A phase with no task has not ended. When the checkpoint fails, the orchestrator gets the last 200 lines of the log and adds fix tasks to that phase with `starship task add`. When those tasks are `verified`, the engine runs the checkpoint again. The build is `stopped` after 3 failed runs of one phase's checkpoint, or when the orchestrator's turn ends with no new task for that phase.

The build status in `state.json` is `running`, `stopped` or `done`. `done` means every phase has ended. A fix list that is sent, or `starship task add`, makes a `done` build `running` again. Neither one starts a `stopped` build again. `stopped` means the engine hands out no task and runs no checkpoint. It shows under "needs you" with one of three reasons. A `TASKS.md` line the parser cannot read: the build runs again as soon as the file parses. A missing feature folder: the build runs again as soon as the folder is back. A checkpoint that failed 3 times, or that got no fix task: the build runs again when the owner presses Resume, and the checkpoint gets 3 more runs. When the chat is halted too, the same Resume clears both. A note still reaches the orchestrator while the build is `stopped`, because no task is in a turn then. So the orchestrator can add tasks first. Halt is separate: it is the chat's `halted` flag.

### Chats, repos and stages

- `starship repo add <path>` writes `repos/<name>.json`. `baseBranch` defaults to the branch the repo's main checkout is on.
- A new chat on a repo gets a worktree at `~/.starship/worktrees/<repo>/<slug>/`, from `baseBranch`, on the branch `starship/<slug>`.
- A new chat on a repo starts in Map when that repo has no map yet, and in Plan when it has one. A chat with no repo has no stage. A chat made with `--folder` starts in Plan.
- A note with the target `repo` is about the repo, not about one chat. The engine appends it to `repos/<name>.notes.md`.
- `--feature <slug>` adopts a feature folder that already exists on `baseBranch`. The chat opens in Plan with those files, also when the repo has no map. "Start build" works as soon as the plan is valid.
- `--folder <path>` makes a chat on an existing feature folder, in place. It has no worktree, no branch and no build.
- A plan is valid when `engine/src/folder/plan.ts` finds no error. SPEC, PLAN, TASKS and ACCEPTANCE exist with their required sections. `TASKS.md` parses. Every "In scope" item of PLAN has a task whose trace names it. No decision record that the plan names is `Rejected` or `Superseded`. PLAN has a section for each point of the staff checklist: data, API, errors, edge cases, tests, rollout.
- The owner accepts the plan by saying so in the chat. Nothing stores that. "Start build" is `POST /stage` with `build`, and it is the only gate.
- A note is `read` at these moments. Target `orchestrator`: when the orchestrator's turn ends after it ran `starship note ack <n>`. Target `fixes`: when the fix list is sent. Until then it is `queued`, and Undo takes it off the fix list. Targets `plan` and `repo`: when the engine has written it, so they have no Undo.
- From the moment the engine pastes a note to the orchestrator until that turn ends, Undo is refused with "Being read". If the turn ends with no `starship note ack`, the note is `queued` again and Undo works again. The engine pastes it again at the next task boundary. `state.json` counts the deliveries of each note. After 3 deliveries with no ack, the engine stops delivering that note. The note stays `queued`, and the chat lists it under "needs you".
- A note with the target `plan` records a change that the admin agent made to a plan file in the same turn. The engine writes the note to `handoffs.md` as `read`. During a build, the engine tells the orchestrator at the next task boundary which plan files changed, as in C1.
- **Pause** sends Escape to one agent. Its status becomes `paused`, and a task of it that is `working` becomes `parked`. A task that is `assigned` or `checking` does not change. Resume sends "continue <task>", or "continue" to an agent with no task.
- **Halt** sets the chat's `halted` flag and sends Escape to every agent of the chat except the admin agent. Their status is `halted`, except that a `paused` agent stays `paused` and the chat's Resume does not resume it. Task states do not change. While the flag is set, the engine hands out no task, runs no check and delivers no note to the orchestrator. Resume clears the flag, as in E4.
- **Restart** ends one agent's session, if it still runs, and starts it again: with the tool's own resume when the engine has the session id, otherwise as a new session with a pickup prompt for its task. The task's state does not change. A change of tool always starts a new session with a pickup prompt.
- A finding is `open` when a reviewer adds it. A dispute by the other reviewer makes it `disputed`. The owner's decision makes it `accepted` or `rejected`.
- The engine keeps `review/fixes.md`: one line for each finding that is `open` or `accepted`, and one for each `fixes` note that is not `undone`.
- The "needs you" list holds these items. An open question. An agent with the status `needsYou`, `stalled` or `stopped`: a trust question shows as "<agent> · trust question". A `blocked` task. A build that is `stopped`. A commit that a worker made. A `disputed` finding. A note that three deliveries did not get an ack. The length of the list is the count in the chat list and in the menu bar.
- `POST /fixes/send` is refused unless the build status is `done`. It adds one phase header, "Fixes", to `TASKS.md`, moves the chat to Build, sets the build status to `running`, and gives the fix list to the orchestrator. The orchestrator writes one task for each fix with `starship task add`, with its files and its verify command. `state.json` holds the number of the last fix sent, so a second send adds nothing. It is refused while a finding is `disputed`.

### Map format

```ts
interface MapFile { name: string; layers: [name: string, note: string][]; boxes: MapBox[]; pipes: MapPipe[]; flows: Record<string, MapFlow>; order: string[] }
interface MapBox { id: string; layer: number; row: number; left: number; right: number; name: string; what: string; dir: string; chips: string[]; store?: boolean; off?: boolean; tag?: string }
//   layer: index into `layers`. row: which line of boxes, from the top. left, right: the box's edges, from 0 to 1 across the map.
//   chips: the code inside the box. A chip that starts with `~` is a shared package, with `#` a store.
//   route: where the pipe runs. x: a straight line at that position. toX: it bends to enter the target there.
//          side and lane: it runs down the left or right margin. across: it joins two boxes of one row.
//   lit: the chips a flow uses, by box id. marks: a word on a chip, such as "changed", keyed "<box>|<chip>".
//   order: the flows as tabs, left to right. The flow `over` is the overview: every box, no steps.
interface MapPipe { id: string; from: string; to: string; kind: 'call' | 'lookup' | 'event'; label: string; route: { x?: number; toX?: number; side?: 'L' | 'R'; lane?: number; across?: boolean } }
interface MapFlow { name: string; story?: string; paths?: MapPath[]; steps?: MapStep[]; lit?: Record<string, string[]>; marks?: Record<string, string> }
interface MapPath { n: number; name: string; who: 'person' | 'clock' | 'auto'; trigger: string; entry: string; after: string }
interface MapStep { n: string; pipe: string; dir?: 'rev' | 'both'; label: string; text: string; where: string }
```

The repo map lives in `~/.starship/repos/<name>.map.json` and always has the flow `over`. A chat adds one flow, "This plan", from `run/map-overlay.json`. The fixture `fixtures/maps/starship.json` is the map of Starship itself.

### Usage numbers

- Claude: every Claude Code session that Starship starts has a status line command, `starship status`. It writes the input to `~/.starship/usage/claude-status.json`, and the engine reads that file. The input carries the account's windows. The engine keeps the newest value. One number serves all Claude agents.
- Codex: `rate_limits` in the rollout file of the agent's own session, under `~/.codex/sessions`. The engine finds the file by session id and reads it after each turn of that agent.
- The switch looks at every window of the tool. Any window at or over the threshold counts.
- Context, for G6. Claude Code: `context_window` in the agent's own status line input, which `starship status` writes to `chats/<id>/agents/<agent>.status.json`. Codex: the newest `token_count` entry of that session's rollout, against `model_context_window`. The level-3 contract tests prove both fields on real fixtures. An unknown number causes no restart.

### Roles

| Role | Default tool and model | May write | Refused by hook |
| --- | --- | --- | --- |
| admin | Claude Code, Opus | Plan files and `docs/adr/`. `TASKS.md` only before the build starts. | Any other write |
| orchestrator | Claude Code, Opus | Nothing directly. It uses the CLI. | Every write |
| worker | Codex | The worktree, except the feature folder | Heavy commands, `git commit`, `git push`, writes in the feature folder |
| reviewer | 1: Codex. 2: Claude Code, Sonnet | Nothing. Findings go through the CLI. | Every write |
| cardRunner | Codex, model `luna` | Nothing. Results go through the CLI. | Every write |

A guard runs only for a Claude Code agent, through its PreToolUse hook. Codex has no such hook here, so a Codex agent has its role prompt and no guard.

The card runner clicks through the app with the browser tool its own CLI has. Starship gives it the cards and the address. Starship has no browser automation of its own.

## Error and edge behavior

Each row names the test that proves it. `M6` means manual check M6 in ACCEPTANCE.md.

### A. A message from the owner to the admin agent

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| A1 | The admin agent is in a turn | The message waits as `queued`. It is pasted when the turn ends. | chat.test |
| A2 | The admin session is gone | The engine restarts it with `--resume`, then pastes. The chat shows "Admin restarted". | chat.test |
| A3 | Resume fails | A new session starts with a pickup prompt that names the feature folder and `messages.jsonl`. | chat.test |
| A4 | tmux refuses the paste | The message shows `notSent` with Retry. | chat.test |
| A5 | The message has more than one line or more than 400 characters | The text goes to `run/inbox/<id>.md`, or to `~/.starship/chats/<chat>/inbox/<id>.md` for a chat with no repo. The pasted line points at it. | chat.test |
| A6 | The same message id arrives twice while it is `queued`, `sent` or `answered` | It is pasted once. Retry is a separate route, for `notSent` and `interrupted` only. | chat.test |
| A7 | The engine restarts with a queued message | The message is still queued and goes out. | chat.test |
| A8 | The owner types in the admin's terminal | The turn shows in the chat, marked "from terminal". | hooks.test |
| A9 | The turn ends with no reply text | The chat shows "Done" and the files that changed. | chat.test |
| A10 | The admin agent needs a permission | The chat shows "Admin needs you" with Terminal. | hooks.test |
| A11 | The chat has no repo | The admin agent runs in `~/.starship/chats/<id>/`. There is no feature folder and no stage. | chat.test |
| A12 | The engine is not running when the window opens | The window starts it and shows "Starting engine". | M6 |
| A13 | The admin session dies after the paste and before the reply | The message shows `interrupted` with Retry. The session restarts with resume. Nothing is pasted twice without the owner. | chat.test |
| A14 | The owner sends while the engine cannot be reached | The text stays in the input and in a local draft. Send works again on reconnect. | data.test |
| A15 | A worker asks a question while the admin agent is in a turn, is gone, or the chat is halted | The question is written to `questions.md` at once. The admin agent is told when it is idle. | chat.test |

### B. Notes

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| B1 | A task is running | The note stays `queued` until the next task boundary in that chat, for any task. | notes-loop.test |
| B2 | The build has not started | A note to the plan is recorded at once. A note to the orchestrator is delivered when the build starts. | notes-loop.test |
| B3 | The chat is halted | A note to the orchestrator is `held`. Resume makes it `queued`. A note to the plan, the fix list or the repo is still recorded at once. | halt.test |
| B4 | Undo while `queued` or `held` | The note becomes `undone` and is never delivered. An undone `fixes` note leaves the fix list. | notes.test |
| B5 | Undo after `read` | Refused. The chat says "Already read". | notes.test |
| B6 | Two notes contradict | Both are delivered in order. The later one wins, and the orchestrator records that. | notes-loop.test |
| B7 | A note touches a running task | The task finishes. The orchestrator adds a follow-up task. | notes-loop.test |
| B8 | A note touches a verified task | The orchestrator adds a redo task that names it. | notes-loop.test |
| B9 | A note is delivered 3 times and the orchestrator never runs `starship note ack` for it | The engine stops delivering it. The note stays `queued` and shows under "needs you". | notes-loop.test |
| B10 | `handoffs.md` has an entry the parser cannot read | That part of the file shows as "unreadable note" with its line. It is not a note and has no status. Other notes work. | notes.test |
| B11 | The admin agent tries to edit code | The hook refuses the write. | guards.test |
| B12 | The admin agent misreads the owner | The owner's words sit next to the note. A note that is `queued` or `held` has Undo. For a `plan` or `repo` note, the owner tells the admin agent, and that is a new note. | M6 |
| B13 | Undo arrives while the engine hands the note to the orchestrator | Refused with "Being read". Undo before that moment wins. | notes-loop.test |

### C. Files

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| C1 | The owner edits a plan file by hand during a build | The page shows "changed by hand". The engine tells the orchestrator which files changed at the next boundary. | watch.test |
| C2 | `TASKS.md` has a line the parser cannot read | The build does not start. A running build is `stopped` at the next task boundary. The page shows the file and the line. | tasks.test |
| C3 | A hand edit changes a running task's line | The task finishes on its old text. The change is flagged at the boundary. | watch.test |
| C4 | The feature folder is missing | The chat shows "Feature folder missing". The build is `stopped`. Nothing is recreated. | folder.test |
| C5 | A worker changes a file no task lists | The file is not committed. It is listed under "Outside the task". | commit.test |
| C6 | A worker changes a file that another task lists | The file stays out of the first task's commit, as in C5. The task that lists it commits it. The orchestrator is told at the next boundary. | commit.test |
| C7 | A worker writes inside the feature folder | The hook refuses the write. | guards.test |
| C8 | A file is binary or larger than 1 MB | The page shows its name, kind and size. No render. | folder.test |
| C9 | A Markdown file holds HTML or script | It renders sanitized. No script runs. | render.test |
| C10 | A file path points outside the worktree, or a symlink leaves it | Refused. | folder.test |
| C11 | A file changes while the owner reads it | The page updates and keeps the scroll position. | M6 |
| C12 | An `.html` file is opened | It opens in the browser. It never renders in the window. | open.test |
| C13 | Two chats ask for one slug in one repo | The second gets `-2`. | worktree.test |
| C14 | The branch exists, or `git worktree add` fails | The chat is not created. The error text shows. | worktree.test |
| C15 | A task goes to `blocked` or is dropped, with edits in the worktree | Its listed files are saved to `run/patches/` and put back as they were. The patch is applied again when a `blocked` task goes back to `queued`. A dropped task's patch stays in `run/patches/`. | commit.test |
| C16 | The owner edits `handoffs.md` or `questions.md` by hand while the engine writes | The engine reads the file again before it writes. The hand edit stays. | watch.test |

### D. Agents and terminals

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| D1 | An agent's process ends | Status `stopped`. Its task's state does not change. The engine restarts it once. When it ends again before its turn ends, it stays `stopped` and shows under "needs you", with Restart. | sessions.test |
| D2 | No hook and no screen change for 10 minutes while `working` | Status `stalled`. Its task's state does not change. The page shows "needs you", with Terminal and Restart. A new hook event or a screen change makes it `working` again. | sessions.test |
| D3 | The owner types in a worker's terminal | Allowed. `progress.md` records "from terminal" for that task. | hooks.test |
| D4 | The owner closes the iTerm window | The agent keeps running. | M6 |
| D5 | The owner kills the tmux session | Same as D1. | sessions.test |
| D6 | A worker needs a permission | The agent's status is `needsYou`, with Terminal. Its task's state does not change. | hooks.test |
| D7 | A check fails | The last 200 lines go back to the same worker. Attempt 2. | loop.test |
| D8 | A check fails 3 times | The task is `escalated`. The orchestrator decides. | loop.test |
| D9 | A check runs longer than 15 minutes | It is killed. It is a failed check, "timed out", under the same quiet-worktree rule as D17. | queue.test |
| D10 | An agent runs a heavy command, `git commit` or `git push` | The hook refuses it and names `starship check`. | guards.test |
| D11 | A worker says done but changed nothing | The check still runs. Its result decides. | loop.test |
| D12 | The tool reports a usage limit | The agent is `stalled` with reason "limit". The engine does not wait for its task to end. It runs the task's check, as in G2, and that run is not an attempt. A pass verifies the task. Otherwise a new session on the other tool gets a pickup prompt with the result. When the check fails, the task stays `working`. When the other tool is over the threshold too, nothing moves, as in G4: the agent stays `stalled`, and the engine looks again each time a usage number changes or a reset time passes. | usage.test |
| D13 | The model name is wrong, or the tool will not start | Status `stopped` with the tool's own error text. | sessions.test |
| D14 | iTerm is not installed | Terminal.app opens instead. | terminal.test |
| D15 | The Mac sleeps | On wake the engine reads tmux and the event log again. No prompt is sent twice. | sessions.test |
| D16 | The engine restarts during a task | Running agents keep running. The engine rebuilds its view. Checks in the queue start again. | restart.test |
| D17 | A check fails while another worker is in a turn | It runs again when the worktree is quiet. Only that result counts. | loop.test |
| D18 | A hook fires while the engine is down | The event is in `events.jsonl`. On start the engine applies the lines after the count in `events.applied`, each one once. | hooks.test |
| D19 | The engine stops between a passed check and its commit | `state.json` holds the pending commit. On start the engine finishes it once. | restart.test |

### E. Halt and Resume

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| E1 | Halt | Escape goes to every agent of that chat except the admin agent. Other chats run on. | halt.test |
| E2 | Halt while a check runs | The check is killed. It is not an attempt. The task stays `checking`, and Resume queues its check again. | halt.test |
| E3 | Halt while a commit runs | The commit finishes, then the halt applies. | halt.test |
| E4 | Resume | Each agent that was in a turn gets "continue <task>", or "continue" when it has no task. An idle agent gets nothing. A dead session is restarted, as in D1. | halt.test |
| E5 | Halt twice, or Resume when the chat is not halted and its build is not `stopped` on a checkpoint | No effect. | halt.test |

### F. Run queue

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| F1 | Two chats queue heavy checks | First in, first out. One runs at a time. | queue.test |
| F2 | Two commands are listed as a conflict | They never run together, even when light. | queue.test |
| F3 | A chat is halted | Its queued checks are dropped. Resume queues them again. | queue.test |
| F4 | The engine restarts | Queued checks are queued again. | restart.test |

### G. Usage and the switch

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| G1 | One tool reaches the threshold | Each worker on that tool moves to the other tool when its own task ends. | switch.test |
| G2 | The move | The engine runs the in-flight task's check before any new work. | switch.test |
| G3 | A number is stale and its reset time has passed | It counts as 0%. | usage.test |
| G4 | Both tools are over the threshold | No move. The page shows "needs you". | switch.test |
| G5 | A usage number is unknown | No automatic move. | usage.test |
| G6 | An agent's context is over 85% | It restarts when its own task ends, with a pickup prompt. | switch.test |

### H. Review

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| H1 | A reviewer finds nothing | The findings file says so. | review.test |
| H2 | The test environment is down | Every card is "unclear", with the reason. No card is "fail". | review.test |
| H3 | The fix list is sent twice | One phase is added, once. | review.test |
| H4 | Two reviewers disagree | The finding is `disputed` and shows under "needs you". The owner decides in the chat, and the admin agent runs `starship finding accept` or `reject`. | review.test |

### I. Map and window

| # | Condition | Result | Test |
| --- | --- | --- | --- |
| I1 | A map file has a step that names a missing pipe, or a lit chip that does not exist | The file is refused. The errors are listed. | map.test |
| I2 | The repo has no CodeGraph index | The map is built from the repo's docs and folders, and says "low detail". | map.test |
| I3 | The engine's port is taken | The next free port is used and written to `engine.json`. | server.test |
| I4 | The WebSocket drops | The window reconnects and reads the chat state again. | M6 |
| I5 | The token is wrong | 401. The window shows "Unauthorized". A restarted engine keeps its token, so an open window works again. | server.test |
| I6 | The engine cannot bind a port or cannot write `engine.json` | It prints one line and exits 1 within 5 seconds. It never hangs. | cli.test |
| I7 | The engine's process is alive but does not answer `/health` within 5 seconds of its start | The app stops the process and shows "Engine did not start". | M6 |

## Test strategy

The app must work for real, so there are five levels. A phase is done only when its level-1 to level-3 tests pass and its manual checks are done.

1. **Unit.** Parsers, writers, the task loop, the run queue, the switch rule, the map validator. Pure code. Run on every task.
2. **Engine with a fake agent.** A small script that acts like Claude Code or Codex inside a real tmux session: it reads pasted text, waits, writes a session file, and fires the same hooks. It can also stall, crash, ask for a permission, and claim "done". This level proves the rows of tables A to H that name an engine test, with no tokens spent.
3. **Contract tests on real tool output.** Fixture copies of a real Claude Code transcript, a real Stop hook input, a real status line input, and a real Codex rollout. The adapters must read them. When a tool changes a format, this level fails first.
4. **Real tools, small.** One short real session on Claude Code and one on Codex: start, paste, turn-end hook, Escape, resume, attach. Run by hand at the end of Phase 2 and Phase 4. These cost tokens.
5. **End to end.** The success measure: build `v1-repos-command` (manual check M3), then the same build with a forced usage move (M7). Then one real ticket on the owner's repo.

For the window: component tests on fixture data for every page, and one browser test per stage against the engine with fake agents. The Mac shell has Rust unit tests in `app/src-tauri/src/engine.rs` and `app/src-tauri/src/tray.rs`.

A test name in the tables is a file: `engine/test/<name>.ts`, or `app/test/<name>.tsx` for the window. `M6` names a manual check in ACCEPTANCE.md.

Every edge row above has a test name. `bun run edges` reads this file and fails if a named test file does not exist or has no test that carries the row's number.

## Dependencies

- Engine: Bun's built-ins only.
- App: `react`, `react-dom`, `vite`, `@vitejs/plugin-react`, `typescript`, `marked`, `dompurify`.
- App tests: `@testing-library/react`, `happy-dom`, `@playwright/test` with the installed Chrome.
- Shell: `@tauri-apps/cli`, `@tauri-apps/api`. Rust crates in `app/src-tauri/Cargo.toml`: `tauri`, `tauri-plugin-shell`, `tauri-plugin-notification`, `serde`, `serde_json`, `ureq`.

## Rollout

1. The engine and the page run from the repo: `bun run --cwd app build`, then `bun run dev`. The engine serves `app/dist` when that folder exists.
2. The success measure passes.
3. Three commands make Starship.app: `bun run --cwd app build`, `bun run --cwd app engine:build`, `bun run --cwd app tauri build`. The compiled engine is for Apple silicon.
4. One real ticket on the owner's repo.

Rollback: stop the engine. Chats and folders stay as files.

## Risks

- Pasted text is handled differently by a new tool version — the fake agent and level 4 catch it; files carry the content.
- The owner's own hooks and plugins run inside every Claude Code agent that Starship starts — the hooks of Starship's settings file run next to them. A global Stop hook that blocks makes an agent work longer, and one turn then gives several Stop events. `claudeArgs` with `--setting-sources project,local` keeps user-level hooks and plugins out. It also keeps the owner's global CLAUDE.md rules out. The default adds no flag. The owner chooses.
- A tool changes its screen text — the engine reads the screens with `claudeScreen` and `codexScreen`. A screen that neither names is `unknown`. At a start, an `unknown` screen is not ready, and the start fails after `readyMs` (60 s). The real captures are in `fixtures/claude/screens/` and `fixtures/codex/screens/`; `permission.txt` is not a capture.
- Codex reports a turn only through `notify`, when the turn ends — the engine reads a turn start and a turn end from that one call. Codex has no pre-tool hook here, so it has no guard.
- The orchestrator is called too often — count its turns per build; add rules to the engine.
- Two workers in one worktree block each other — the ready rule already keeps tasks with shared files apart.
- The admin agent writes no note for an instruction — the chat shows no note, so the owner sees it; the admin prompt requires one note per instruction.
- A wireframe cannot be published as an artifact from a terminal session — the file still opens in the browser.
- The engine's process blocks before its own code runs — seen once on 2026-11-11: Bun waited inside the system call `getcwd` when another app's helper started it in a folder under Desktop. The engine's own start timer cannot fire then, so the app watches the start from outside (edge I7) and starts the engine in the app's own folder.

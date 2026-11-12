# TASKS — Starship

Depends on: docs/features/starship/PLAN.md, the six ADRs of 2026-11-11, spec docs/features/starship/SPEC.md

Each task: `- [ ] T0xx [P?] {behavior} — {files} — verify: {command} ({trace tag})`

`[P]` means different files and no dependency on an unfinished task in the same phase.

## Phase 0 — Foundation

Blocks every later phase.

- [x] T001 Repo scaffold: Bun workspace, strict TypeScript, scripts `test`, `typecheck`, `edges`, `dev` — `package.json`, `tsconfig.json`, `engine/package.json` — verify: `bun run typecheck` (plan: Dependencies)
- [x] T002 Paths and config with a `STARSHIP_HOME` override; defaults from the spec — `engine/src/config.ts`, `engine/test/config.test.ts` — verify: `bun test engine/test/config.test.ts` (spec: Defaults)
- [x] T003 [P] `TASKS.md` parser and writer: phases, tasks, `[P]`, files, verify, trace, checkpoints; check a task; add a phase; refuse a bad line with its number; parse then write gives the same bytes — `engine/src/folder/tasks.ts`, `engine/test/tasks.test.ts` — verify: `bun test engine/test/tasks.test.ts` (plan: Edge C2)
- [x] T004 [P] Notes: append, parse, status changes, refuse Undo after read, show an unreadable entry — `engine/src/folder/notes.ts`, `engine/test/notes.test.ts` — verify: `bun test engine/test/notes.test.ts` (plan: Edge B4, B5, B10)
- [x] T005 [P] Questions and progress writers — `engine/src/folder/questions.ts`, `engine/src/folder/progress.ts`, `engine/test/progress.test.ts` — verify: `bun test engine/test/progress.test.ts` (plan: File formats)
- [x] T006 [P] Folder reader: file list, safe path, binary and size, plan files and run files, missing folder — `engine/src/folder/folder.ts`, `engine/test/folder.test.ts` — verify: `bun test engine/test/folder.test.ts` (plan: Edge C4, C8, C10)
- [x] T007 Fixtures: the sample folder and the two `TASKS.md` files of `rate-limited-cli` — `fixtures/recipe-search/`, `fixtures/rate-limited-cli/` — verify: `bun test engine/test/tasks.test.ts -t fixtures` (plan: Test strategy 1)
- [x] T008 Edge checker: read the edge tables in PLAN.md and fail when a named test is missing — `scripts/edges.ts` — verify: `bun run edges --list` (plan: Test strategy)
- [x] T009 Do not add a YAML file. — `.` — verify: `test -z "$(find . \( -name '*.yml' -o -name '*.yaml' \) -not -path './node_modules/*' -not -path './*/node_modules/*')"` (AGENTS.md: Hard rules)

Checkpoint: the folder code reads and writes the sample folder — `bun test engine && bun run typecheck`

## Phase 1 — The window shows a folder

Goal: the page shows a feature folder, live.
Independent check: `bun run dev`, then the sample chat shows in a browser.

- [x] T010 Server: loopback only, token, `engine.json` at mode 0600, port fallback, `/health` — `engine/src/server.ts`, `engine/test/server.test.ts` — verify: `bun test engine/test/server.test.ts` (plan: Edge I3, I5)
- [x] T011 Repo and chat registry and read API: `starship repo add`, chats, chat state, files, one file — `engine/src/repos.ts`, `engine/src/chats.ts`, `engine/src/api.ts`, `engine/test/api.test.ts` — verify: `bun test engine/test/api.test.ts` (plan: HTTP)
- [x] T012 Watcher and WebSocket events; a hand edit is flagged; run files are read again before each write — `engine/src/watch.ts`, `engine/test/watch.test.ts` — verify: `bun test engine/test/watch.test.ts` (plan: Edge C1, C3, C16)
- [x] T013 Open `.html` files and links in the browser; never inline — `engine/src/open.ts`, `engine/test/open.test.ts` — verify: `bun test engine/test/open.test.ts` (plan: Edge C12)
- [x] T014 [P] Page scaffold: Vite, React, dark tokens, the three-part layout — `app/package.json`, `app/index.html`, `app/src/main.tsx`, `app/src/App.tsx`, `app/src/styles.css` — verify: `bun run --cwd app build` (in scope #2)
- [x] T015 [P] Document page: TL;DR for each stage, sanitized Markdown, Tasks, Files, raw view — `app/src/pages/`, `app/test/render.test.tsx` — verify: `bun --cwd app test test/render.test.tsx` (in scope #11; plan: Edge C8, C9)
- [x] T016 Live data: fetch, WebSocket, reconnect, chat list, new chat, a draft that survives an offline engine — `app/src/data.ts`, `app/test/data.test.ts` — verify: `bun --cwd app test test/data.test.ts` (plan: Edge A14)
- [x] T017 Browser test: the page shows the sample folder — `app/e2e/shell.spec.ts` — verify: `bun run --cwd app e2e shell` (in scope #2)
- [x] T018 `starship daemon`, `starship status`, `bun run dev` — `engine/src/cli.ts`, `engine/test/cli.test.ts` — verify: `bun test engine/test/cli.test.ts` (plan: CLI)
- [x] T019 Do not bind any address except `127.0.0.1`. — `engine/src/server.ts` — verify: `bun test engine/test/server.test.ts -t loopback` (ADR engine-and-window: Confirmation 1)
- [x] T019a The daemon fails loudly: when it cannot bind a port or write `engine.json`, it prints one line and exits 1 within 5 seconds — `engine/src/cli.ts`, `engine/test/cli.test.ts` — verify: `bun test engine/test/cli.test.ts -t loudly` (plan: Edge I6)

Checkpoint: the sample chat shows in a browser — `bun run test && bun run typecheck && bun run --cwd app e2e shell`

## Phase 2 — One agent

Goal: the owner chats with the admin agent and opens its terminal.
Independent check: with the fake agent, a message gets a reply in the chat pane.

- [x] T020 tmux adapter: new session, has, paste and Enter, Escape, capture, kill, list — `engine/src/agents/tmux.ts`, `engine/test/tmux.test.ts` — verify: `bun test engine/test/tmux.test.ts` (ADR agents-in-tmux: Decision)
- [x] T021 Fake agent: pasted text in, session file out, hooks fired; it can stall, crash, ask for a permission, and claim done — `engine/test/fake-agent.ts`, `engine/test/fake-agent.test.ts` — verify: `bun test engine/test/fake-agent.test.ts` (plan: Test strategy 2)
- [x] T022 Hook receiver and event log; "from terminal"; needs you; events kept when the engine is down — `engine/src/hooks.ts`, `engine/test/hooks.test.ts` — verify: `bun test engine/test/hooks.test.ts` (plan: Edge A8, A10, D3, D6, D18)
- [x] T023 Claude Code adapter: per-session settings, role prompt file, start command, transcript reader, resume — `engine/src/agents/claude.ts`, `engine/test/claude.test.ts`, `fixtures/claude/` — verify: `bun test engine/test/claude.test.ts` (plan: Test strategy 3)
- [x] T024 Sessions: start, stop, restart, crash, stall, wrong model, rebuild from tmux — `engine/src/sessions.ts`, `engine/test/sessions.test.ts` — verify: `bun test engine/test/sessions.test.ts` (plan: Edge D1, D2, D5, D13, D15)
- [x] T025 Chat: outbox, queue while busy, long message to the inbox, retry, one paste per id, reply from the session file, a chat with no repo — `engine/src/chat.ts`, `engine/test/chat.test.ts` — verify: `bun test engine/test/chat.test.ts` (plan: Edge A1, A2, A3, A4, A5, A6, A7, A9, A11, A13, A15)
- [x] T026 Terminal: open iTerm on a session; Terminal.app when iTerm is missing — `engine/src/terminal.ts`, `engine/test/terminal.test.ts` — verify: `bun test engine/test/terminal.test.ts` (plan: Edge D14)
- [x] T027 Chat pane and agent page: send, queued, not sent, interrupted, needs you; status, model, prompt, Terminal, Pause, Resume and Restart — `app/src/chat/`, `app/src/pages/Agent.tsx`, `app/test/chat.test.tsx` — verify: `bun --cwd app test test/chat.test.tsx` (in scope #3, #4)
- [x] T028 Do not send any key except Enter and Escape. — `engine/src/agents/tmux.ts` — verify: `bun test engine/test/tmux.test.ts -t keys` (ADR agents-in-tmux: Confirmation 1)
- [x] T029 Do not write under `~/.claude` or `~/.codex`. — `engine/src/` — verify: `test -z "$(grep -rnE "\.claude/|\.codex/" engine/src | grep -vE "read|Read|sessions" || true)"` (ADR agents-in-tmux: Confirmation 2)

Checkpoint: a message gets a reply through a real tmux session — `bun test engine/test/chat.test.ts engine/test/sessions.test.ts`, then manual check M1

## Phase 3 — Plan stage

Goal: the admin agent writes the plan files and the owner accepts them.
Independent check: with the fake agent, a new chat on a scratch repo ends with a valid plan.

- [x] T030 Worktree and feature folder for a new chat; adopt a folder that exists; base branch; `info/exclude`; slug clash; branch exists — `engine/src/worktree.ts`, `engine/test/worktree.test.ts` — verify: `bun test engine/test/worktree.test.ts` (plan: Edge C13, C14)
- [x] T031 Role guards: the admin agent writes only plan files and `docs/adr/`, and not `TASKS.md` during a build; the orchestrator writes nothing — `engine/src/guards.ts`, `engine/test/guards.test.ts` — verify: `bun test engine/test/guards.test.ts -t admin` (plan: Edge B11)
- [x] T032 Templates and the admin prompt for Plan: data model first, wireframe, test strategy, staff checklist — `engine/templates/`, `engine/src/agents/roles.ts`, `engine/test/roles.test.ts` — verify: `bun test engine/test/roles.test.ts` (in scope #7)
- [x] T033 Plan validators and `starship plan check`: required sections, every in-scope item has a task, decision status, staff checklist — `engine/src/folder/plan.ts`, `engine/src/cli.ts`, `engine/test/plan.test.ts` — verify: `bun test engine/test/plan.test.ts` (in scope #7)
- [x] T034 `starship note`, `starship note ack`, the notes API, Undo — `engine/src/api.ts`, `engine/src/run/notes-loop.ts`, `engine/test/notes-api.test.ts` — verify: `bun test engine/test/notes-api.test.ts` (plan: Edge B2, B4, B5)
- [x] T035 Wireframes: list them, open them in the browser, keep `links.json` — `engine/src/wireframes.ts`, `engine/test/wireframes.test.ts` — verify: `bun test engine/test/wireframes.test.ts` (plan: Edge C12)
- [x] T036 Plan pages: a TL;DR whose lines open the plan file at that part, Start build with the validator's errors, wireframe links — `app/src/pages/Plan.tsx`, `app/test/plan.test.tsx` — verify: `bun --cwd app test test/plan.test.tsx` (in scope #7)
- [x] T037 New chat form: title, repo, a feature folder to adopt; add a repo — `app/src/components/NewChat.tsx`, `app/test/newchat.test.tsx` — verify: `bun --cwd app test test/newchat.test.tsx` (in scope #1)

Checkpoint: a scratch repo gets a valid plan — `bun test engine/test/plan.test.ts engine/test/worktree.test.ts`, then manual check M2

## Phase 4 — Build stage

Goal: the engine builds a plan with two workers.
Independent check: with fake agents, the sample `TASKS.md` runs to the end.

- [x] T040a Transition table for task, agent, note and build states, as data; every pair of state and event has one result — `engine/src/run/states.ts`, `engine/test/states.test.ts` — verify: `bun test engine/test/states.test.ts` (plan: Design rules)
- [x] T040 Run queue: first in first out, one heavy at a time on the whole Mac, conflicts, timeout, drop on halt — `engine/src/run/queue.ts`, `engine/test/queue.test.ts` — verify: `bun test engine/test/queue.test.ts` (plan: Edge D9, F1, F2, F3)
- [x] T041 Task loop: ready rule, assign, prompt file, turn end, check, quiet second run, retry, escalate, checkpoint — `engine/src/run/loop.ts`, `engine/test/loop.test.ts` — verify: `bun test engine/test/loop.test.ts` (plan: Edge D7, D8, D11, D17)
- [x] T042 Commit a verified task's listed files; list the rest as outside the task; commit plan files; set a blocked task's edits aside as a patch — `engine/src/run/commit.ts`, `engine/test/commit.test.ts` — verify: `bun test engine/test/commit.test.ts` (plan: Edge C5, C6, C15)
- [x] T043 Worker guard: heavy commands, `git commit`, `git push`, writes in the feature folder — `engine/src/guards.ts`, `engine/test/guards.test.ts` — verify: `bun test engine/test/guards.test.ts -t worker` (plan: Edge C7, D10)
- [x] T044 Orchestrator turns and `starship task add|edit|split|block|drop|retry` — `engine/src/run/orchestrator.ts`, `engine/test/orchestrator.test.ts` — verify: `bun test engine/test/orchestrator.test.ts` (ADR engine-runs-the-loop: Decision)
- [x] T045 Notes in the loop: delivery at a boundary, order, follow-up and redo tasks, needs you — `engine/src/run/loop.ts`, `engine/test/notes-loop.test.ts` — verify: `bun test engine/test/notes-loop.test.ts` (plan: Edge B1, B6, B7, B8, B9, B13)
- [x] T046 Questions: `starship ask` parks a task, `starship answer` resumes it — `engine/src/run/park.ts`, `engine/test/questions.test.ts` — verify: `bun test engine/test/questions.test.ts` (in scope #5)
- [x] T047 Halt and Resume for one chat — `engine/src/run/halt.ts`, `engine/test/halt.test.ts` — verify: `bun test engine/test/halt.test.ts` (plan: Edge B3, E1, E2, E3, E4, E5)
- [x] T048 Codex adapter: start flags, hooks and `notify`, rollout reader, resume — `engine/src/agents/codex.ts`, `engine/test/codex.test.ts`, `fixtures/codex/` — verify: `bun test engine/test/codex.test.ts` (plan: Risks)
- [x] T049 Restart: rebuild from tmux, the folder and the event log; no prompt sent twice — `engine/src/restart.ts`, `engine/test/restart.test.ts` — verify: `bun test engine/test/restart.test.ts` (in scope #14; plan: Edge A7, D16, D19, F4)
- [x] T050 Build pages: TL;DR, live tasks, Halt and Resume, prompt versions with the line from a note — `app/src/pages/Build.tsx`, `app/test/build.test.tsx` — verify: `bun --cwd app test test/build.test.tsx` (in scope #4, #8)
- [x] T051 Browser test: a fake build runs to the end with a halt, a note and a question — `app/e2e/build.spec.ts` — verify: `bun run --cwd app e2e build` (in scope #8)
- [x] T052 Do not push. — `engine/src/` — verify: `test -z "$(grep -rnE "git[^\n]*push" engine/src | grep -v "refuse" || true)"` (ADR one-worktree-per-chat: Confirmation 4)
- [x] T053 Do not check a task without a check that exits 0. — `engine/src/run/loop.ts` — verify: `bun test engine/test/loop.test.ts -t claim` (ADR engine-runs-the-loop: Confirmation 1)

Checkpoint: a fake build ends with every task checked — `bun test engine && bun run --cwd app e2e build`, then manual check M3

## Phase 5 — Review stage

Goal: a finished build is reviewed, and fixes go back to Build.
Independent check: with fake agents, a planted finding becomes a fix task.

- [x] T060 Reviewer and card runner roles; `starship finding add|dispute|accept|reject` — `engine/src/review/roles.ts`, `engine/src/folder/findings.ts`, `engine/test/review.test.ts` — verify: `bun test engine/test/review.test.ts -t findings` (plan: Edge H1, H4)
- [x] T061 Story cards from the chat's ACCEPTANCE.md; runner results; "unclear" when the environment is down — `engine/src/review/cards.ts`, `engine/test/review.test.ts` — verify: `bun test engine/test/review.test.ts -t cards` (plan: Edge H2)
- [x] T062 Fix list to Build as one new phase, once — `engine/src/review/fixes.ts`, `engine/test/review.test.ts` — verify: `bun test engine/test/review.test.ts -t fixes` (plan: Edge H3)
- [x] T063 Review pages: findings, story cards, fixes, reviewers one click away — `app/src/pages/Review.tsx`, `app/test/review.test.tsx` — verify: `bun --cwd app test test/review.test.tsx` (in scope #9)

Checkpoint: a planted finding becomes a task — `bun test engine/test/review.test.ts`, then manual check M4

## Phase 6 — Map

Goal: the repo map shows in the snapshot format, with the plan on it.
Independent check: the map of Starship itself loads and draws.

- [x] T070 Map format and validator — `engine/src/map/schema.ts`, `engine/test/map.test.ts`, `fixtures/maps/starship.json` — verify: `bun test engine/test/map.test.ts` (plan: Edge I1)
- [x] T071 Map page: layers, boxes, chips, pipes, pills, key, step table — `app/src/map/`, `app/test/map.test.tsx` — verify: `bun --cwd app test test/map.test.tsx` (in scope #6)
- [x] T072 `starship map import|build|validate`; "low detail" with no index — `engine/src/map/build.ts`, `engine/test/map.test.ts` — verify: `bun test engine/test/map.test.ts -t build` (plan: Edge I2)
- [x] T073 Plan overlay: `map-overlay.json` and the "This plan" tab — `engine/src/map/overlay.ts`, `engine/test/map.test.ts` — verify: `bun test engine/test/map.test.ts -t overlay` (in scope #6)

Checkpoint: the map of Starship itself draws — `bun test engine/test/map.test.ts && bun --cwd app test test/map.test.tsx`, then manual check M5

## Phase 7 — Usage

Goal: the engine moves workers before a limit stops them.
Independent check: with fake agents, a forced 91% moves one worker and checks its task first.

- [x] T080 Usage readers: the Claude status line input, the Codex rollout; stale, expired, unknown, limit reached — `engine/src/usage/read.ts`, `engine/test/usage.test.ts`, `fixtures/usage/` — verify: `bun test engine/test/usage.test.ts` (plan: Edge D12, G3, G5)
- [x] T081 Switch rule at a task boundary; check first; both over; context restart — `engine/src/usage/switch.ts`, `engine/test/switch.test.ts` — verify: `bun test engine/test/switch.test.ts` (plan: Edge G1, G2, G4, G6)
- [x] T082 Usage in the window: bars, the switch setting, the line in the chat — `app/src/Usage.tsx`, `app/test/usage.test.tsx` — verify: `bun --cwd app test test/usage.test.tsx` (in scope #10)

Checkpoint: a forced move works — `bun test engine/test/switch.test.ts`, then manual check M7

## Phase 8 — Mac app and rollout

Goal: Starship is a Mac app, and every check has passed.

- [x] T090 Tauri shell: the window loads the page and starts the engine; it stops an engine that does not answer `/health` within 5 seconds — `app/src-tauri/` — verify: `bun run --cwd app tauri build --debug` (in scope #13; plan: Edge I7)
- [ ] T091 Menu bar item with Halt and the needs-you count; notifications — `app/src-tauri/src/tray.rs` — verify: manual check M6 (in scope #13)
- [x] T092 Settings page: roles, tools, models, terminal app, thresholds — `app/src/pages/Settings.tsx`, `app/test/settings.test.tsx` — verify: `bun --cwd app test test/settings.test.tsx` (in scope #12)
- [x] T093 Package Starship.app with the engine inside — `app/src-tauri/tauri.conf.json` — verify: `bun run --cwd app tauri build` (plan: Rollout 3)
- [x] T094 `docs/ARCHITECTURE.md` matches the code — `docs/ARCHITECTURE.md` — verify: `test -z "$(grep -nE "build is in progress|Not yet in the system" docs/ARCHITECTURE.md || true)"` (AGENTS.md: Source of truth)
- [x] T095 Every edge row has a passing test — `scripts/edges.ts` — verify: `bun run edges` (plan: Test strategy)
- [ ] T096 Run every item in ACCEPTANCE.md — `docs/features/starship/ACCEPTANCE.md` — verify: manual checks M1 to M7 recorded in `docs/features/starship/CHECKS.md` (spec: Success measure)

Checkpoint: the app opens and every check passes — `bun run test && bun run typecheck && bun run edges`, then manual check M6

## Done when

- [ ] Every in-scope behavior has a checked task
- [ ] No out-of-scope item has code
- [ ] Every Confirmation check in the six ADRs passes
- [ ] `bun run test`, `bun run typecheck` and `bun run edges` pass
- [ ] Manual checks M1 to M7 are done and recorded
- [ ] `docs/ARCHITECTURE.md` matches the code

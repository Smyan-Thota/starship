# SPEC — Starship

> This project has no issue tracker, so the spec lives in the repo.

## What Starship is

Starship is a Mac app for one person, the owner. It runs Claude Code and Codex agents on the owner's repos and keeps the plan in front of the owner. It has two parts: a window, and a local engine that starts the agents and checks their work. `AGENTS.md`, section "Words", gives the meaning of each word used below.

## Problem

The owner runs Claude Code and Codex in many terminals through a terminal session manager. Sessions get buried, and the owner loses time finding them. The owner plans too little before building. The owner understands a system fastest from a picture. The owner wants one window that keeps the plan in view, and the agents' own terminals when the owner wants to look.

## Scope

1. **Chats.** A left bar of chats. A chat is one unit of work, with a title. When it has a repo, it also has a stage (Map, Plan, Build or Review), a worktree, a feature folder and agents. The feature folder is `docs/features/<slug>/`: the plan and all state of the chat, as files. A chat can take over a feature folder that already exists in the repo. A chat with no repo is a plain conversation with the admin agent.
2. **One window.** The chat list, one page in the middle, and the conversation with the admin agent on the right. Dark only. The window shows labels and data, never a sentence that explains the product.
3. **Real terminals.** Every agent is Claude Code or Codex as installed, running in tmux. A "Terminal" control on each agent opens iTerm attached to it. The owner can detach, and the agent keeps running.
4. **Prompts in the open.** Each agent shows its status, task, model, and the exact prompt it got. A prompt that changes gets a new version. A prompt line that came from a note shows the owner's own words next to it.
5. **Admin agent.** One per chat, in every stage. The owner talks only to it. It turns each instruction into one note. A note for the orchestrator is delivered at a task boundary: the moment a task's check ends with a result that counts. Until then the owner can undo it. A worker's question reaches the owner through the admin agent.
6. **Map.** One map per repo: layers, boxes, the code inside each box, and labelled pipes that say what goes from one box to the next. The format is one JSON file: layers, boxes, the code inside each box, and labelled pipes. A chat adds one overlay, "This plan", that lights the pieces its plan touches. A chat on a repo with no map starts in the Map stage: the admin agent builds the map, and the owner reads it before the plan.
7. **Plan.** The admin agent writes the plan files: SPEC, decision records, PLAN, TASKS, ACCEPTANCE and PROMPTS. It starts from the templates in `engine/templates/`, which task T032 adapts from `docs/templates/`. It must answer the staff checklist. A wireframe is an HTML page that opens in the browser, never in the window. The owner accepts the plan in the chat, then starts the build.
8. **Build.** The engine gives tasks to two or three workers. It runs each task's check, which is the task's verify command, in the run queue. Then it checks the task off and commits it. The workers share the chat's one worktree. The orchestrator agent decides what the engine's rules cannot: a plan change in the middle of a build, or a task that keeps failing. Halt stops every agent of one chat except the admin agent. Resume continues.
9. **Review.** Two reviewers on different tools read the change, which is the diff of the chat's branch against its base branch, and report findings. A card runner acts out story cards in the app that was built. Where the reviewers disagree, the owner decides. The engine keeps the fix list from the findings and from the owner's notes. The fix list goes back to Build as a new phase of tasks.
10. **Usage.** The engine reads how much of the Claude and the Codex subscription limits is used. At a threshold it moves each worker to the other tool when that worker's own task ends. A worker whose tool reports its limit in the middle of a task moves at once. The engine runs the check of the task in flight before any new work. An agent whose conversation is nearly full restarts when its own task ends.
11. **Files.** Every file in the feature folder is readable in the window, rendered and raw, and updates live.
12. **Roles and models are settings.** Each role (admin, orchestrator, worker, reviewer, card runner) runs on Claude Code or Codex with any model name.
13. **Mac app.** Starship.app is the window, and it starts the engine. A menu bar item has Halt and a count of the things that wait for the owner. The Mac notifies the owner when something waits.
14. **Restart safe.** After an engine restart, a closed window, or a sleeping Mac, a chat has the same tasks, notes and progress, and its running agents are still running.

## Deferred

- Reviews of pull requests on GitHub. Scope item 9 reviews the chat's own change before a pull request exists.
- Tools other than Claude Code and Codex
- Remote machines, cloud runs, Windows, Linux
- More than one person
- A terminal drawn inside the window
- Pushing a branch or opening a pull request
- Setting up a repo's test environment for story cards
- A worktree for each worker

## Defaults, with the why

- Terminal app: iTerm. The owner chose it. Fallback: Terminal.app.
- Theme: dark only. The owner wants one theme.
- Admin and orchestrator: Claude Code with Opus. Workers and reviewer 1: Codex. Reviewer 2: Claude Code with Sonnet. Card runner: Codex with the model `luna`, which the owner chose. Workers default to Codex because the owner's Claude limit tends to fill first.
- Workers per chat: 2. Limit: 3. The owner asked for two to three.
- Check attempts per task: 3. Then the orchestrator decides. Then the owner. A loop must end.
- Check timeout: 15 minutes. A check that hangs must not hold the run queue.
- Heavy commands at once: 1, on the whole Mac. A heavy command is a typecheck, a test suite, a build or an install. Three at once can use all the memory of a Mac and restart it.
- Usage threshold: 90% of any limit window of the tool. The move must happen before the limit stops an agent.
- Context threshold: 85% of an agent's conversation. Past it, the agent restarts when its own task ends.
- Stall watchdog: 10 minutes with no signal from the agent and no change on its screen. Then the agent shows as stalled, and the owner is told.
- Permissions: a worker may edit files in the chat's worktree. The admin agent may write plan files. A reviewer writes nothing. A hook refuses what a role may not do: a write outside its files, a heavy command, a commit, a push. Any other action that the tool wants approval for asks the owner. No agent runs with its permission checks switched off.
- Engine port: the first free port from 8787, on 127.0.0.1 only. Nothing outside the Mac can reach the engine.

## Success measure

Two builds on `vivekchopra/rate-limited-cli`. It is a small public Python repo that holds a plan and no code. Its author wrote the plan templates in `docs/templates/`.

1. Starship takes over that repo's feature folder `docs/features/v1-repos-command/` and builds it from its `TASKS.md`. Every task is checked by the engine, and `uv run pytest` passes. During the build: one Halt and Resume, and one note delivered at a task boundary. This is manual check M3 in `ACCEPTANCE.md`.
2. When the usage switch exists: the same build with one worker set to Claude Code. With the threshold forced, that worker moves to Codex, and its task's check runs first. This is manual check M7.

Plan, Review, the map and the Mac app each have their own manual check in `ACCEPTANCE.md`.

# Every agent is an unchanged Claude Code or Codex terminal in tmux

Status: Proposed
Date: 2026-11-11
Deciders: the owner
Spec: docs/features/starship/SPEC.md

## Context

The owner must be able to open any agent in a real iTerm window, whatever its role, see everything the tool shows, type in it, and detach while it keeps running. The owner treats this as a requirement, not a feature. The owner also wants Starship to be a layer on top of Claude Code and Codex, not a replacement for them.

A headless run (`claude -p`, `codex exec`) has no terminal to open. An agent built on an SDK is not the tool the owner knows.

How do agents run?

## Decision drivers

- A real terminal for every agent, with attach and detach.
- The same design for Claude Code and Codex.
- The engine learns an agent's state from the agent's own signals, not by reading text off its screen.
- The owner's global Claude Code and Codex config is never changed.

## Decision

We will run every agent as the unchanged interactive tool inside its own tmux session named `ss-<chat>-<agent>`, for example `ss-recipes-worker-a`.

The engine sends a session only three kinds of input: the start command, pasted text followed by Enter, and Escape. It also looks at the session's screen for one purpose, the stall watchdog, and it ends a session that it started.

The engine hears back in two ways:

- **Hooks.** Claude Code: Stop, Notification, PreToolUse, SessionStart, UserPromptSubmit, and the status line command. Codex: its `hooks.json` events and `notify`. Each hook runs `starship hook <event>`.
- **Session files.** The reply text comes from the tool's own file: the transcript `.jsonl` for Claude Code, the rollout `.jsonl` for Codex.

Hooks are set in a per-session settings file passed at start. A prompt longer than one line is written to a file, and the pasted text is a pointer to that file.

"Terminal" in the window opens iTerm with `tmux attach -t <session>`.

## Alternatives

### A. Headless runs with structured output — rejected

Easy to parse. Rejected because there is no terminal to open. To let the owner type, the engine would have to stop the run and start an interactive one.

### B. An agent SDK — rejected

Full control. Rejected because it covers Claude only, and it is not the tool the owner already uses.

### C. A terminal drawn inside the window — rejected

One window for everything. Rejected because the owner wants the real terminal and said not to put everything in one UI.

### D. Unchanged tools in tmux

Meets all four drivers.

## Consequences

- Typing into a terminal UI is fragile. So the engine uses only paste, Enter and Escape, and files carry the content.
- Status comes from hooks. If no hook arrives and the screen does not change for 10 minutes, the watchdog marks the agent `stalled`.
- Codex's hook coverage is proven in task T048, not assumed.

## Confirmation

- `grep -rn "send-keys" engine/src` shows only Enter and Escape as keys.
- Each start command carries a per-session settings file. No code writes under `~/.claude` or `~/.codex`.
- A test with the fake agent proves: paste arrives, the turn-end hook arrives, Escape stops a turn, attach shows the session.

## Anchors

- `claude --help` — lists `--settings`, `--append-system-prompt-file`, `--model`, `--permission-mode`, `--session-id`, `--resume` (checked 2026-11-11).
- `codex --help` — lists `-m`, `-C`, `-c`, `-a`, `-s`, and `resume` (checked 2026-11-11).
- `codex features list` — shows `hooks` as stable. Codex also takes a `notify` program for the end of a turn.
- `tmux 3.8` and iTerm — the versions the build was checked with.

## Revisit when

A tool removes its hooks, or changes how pasted text is handled.

## Open questions

None.

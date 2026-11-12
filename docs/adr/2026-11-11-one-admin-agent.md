# One admin agent per chat, and notes move at task boundaries

Status: Proposed
Date: 2026-11-11
Deciders: the owner
Spec: docs/features/starship/SPEC.md

## Context

The owner does not want to interrupt the orchestrator or the reviewers. A message typed at a working agent gives it stray context and pushes it off its path. The owner wants one agent to talk to in every stage. The owner fears one failure most: the admin agent misreads the owner, passes the wrong thing on, and the build burns tokens on it. An early design offered buttons to answer a worker's question. The owner rejected them and wants to answer in their own words.

How does the owner steer a chat?

## Decision drivers

- The owner talks in one place.
- A working agent is never interrupted by a message.
- A misread is visible before it costs anything.
- The owner answers in their own words.

## Decision

We will give each chat one admin agent, present in every stage.

- The owner talks to the admin agent in the window.
- An instruction becomes exactly one **note** in `handoffs.md`, with the owner's words next to the note.
- A note has a status: `queued` (it waits for delivery), `read`, `undone` (the owner took it back), `held` (it waits because the chat is halted).
- A note has a target. `orchestrator`: delivered at a task boundary. `plan`, `fixes`, `repo`: the engine writes it at once into the plan, the fix list, or the repo's notes.
- The engine delivers a queued note to the orchestrator only at a **task boundary**: the moment any task's check ends in that chat, or at once when no task runs. The orchestrator confirms with `starship note ack`. A queued note can be undone. A read note cannot.
- A worker's question goes to the admin agent first. The admin agent answers it from the plan, or asks the owner in the chat.
- The window has no answer buttons. The owner answers by typing.
- The admin agent may write only plan files and `docs/adr/`. The orchestrator writes nothing directly. A hook refuses any other write.
- Typing in any agent's terminal is allowed. The engine records that turn as "from terminal". It is the exception.

## Alternatives

### A. The owner talks to the orchestrator — rejected

One hop less. Rejected because it interrupts the agent that must not be interrupted.

### B. One chat for each stage or agent — rejected

Each agent has its own context. Rejected because the owner wants one place.

### C. Answer buttons for worker questions — rejected

Fast. Rejected by the owner.

### D. One admin agent, notes at task boundaries

Meets all four drivers.

## Consequences

- The admin agent is the single place a misread can happen. The owner's words next to the note, and Undo, are the defence.
- A note waits for a boundary. A change is not instant. Halt is the tool for "stop now".

## Confirmation

- A test: a note written while a task runs is not delivered until that task's check ends.
- A test: Undo before delivery prevents delivery. Undo after delivery is refused.
- A test: the admin role is refused a write outside the plan files and `docs/adr/`.
- A test: a prompt the engine did not send is logged as "from terminal".

## Anchors

- Claude Code PreToolUse and UserPromptSubmit hooks — carry the tool input and the prompt text.

## Revisit when

The owner finds the wait for a boundary too long. Then add "deliver now" as an explicit action.

## Open questions

None.

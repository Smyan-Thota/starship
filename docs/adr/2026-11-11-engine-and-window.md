# Starship is a local engine with a Tauri window

Status: Proposed
Date: 2026-11-11
Deciders: the owner
Spec: docs/features/starship/SPEC.md

## Context

The owner wants a real Mac app that is a thin layer on top of Claude Code and Codex. Agents must keep running when the window closes. Memory is a real limit: three parallel `tsc` runs have used almost all the memory of a Mac and restarted it.

The owner chose iTerm as the terminal. The owner left the framework for the window to the author of this record.

What are Starship's own processes?

## Decision drivers

- Agents survive when the window closes.
- The window uses little memory.
- The window is one web page, so it also runs in a browser.
- The engine can be tested with no window.

## Decision

We will build two pieces.

1. **Engine.** One Bun and TypeScript process. It serves HTTP and WebSocket on `127.0.0.1` only. Every route except `/health` needs a token from `~/.starship/engine.json` (mode 0600).
2. **Window.** A Tauri shell that loads the engine's page. The same page opens in a browser.

The window starts the engine if it is not running. `starship daemon` starts it by hand. `starship` is the engine's command line, `engine/src/cli.ts`.

## Alternatives

### A. Electron — rejected

One language everywhere. Rejected because the app is about 150 MB and uses about 250 MB of memory for a window.

### B. SwiftUI — rejected

The most native feel. Rejected because the screen is written again from zero.

### C. Browser tab only — rejected

No app to build. Rejected because the owner asked for a Mac app. It stays as a free fallback, because the engine serves the page.

### D. Engine plus a Tauri window

Meets all four drivers.

## Consequences

- The window is replaceable. The engine is the product.
- A thin Rust layer sits next to the TypeScript engine.
- The engine can run commands, so it is an attack surface. It binds loopback only and needs the token.

## Confirmation

- A test proves the server refuses to bind any address except `127.0.0.1`.
- A test proves every route except `/health` returns 401 without the token.
- `bun test engine` passes with no window.

## Anchors

- `cargo 1.98.1`, `bun 1.4.3` — the versions the build was checked with (2026-11-11).

## Revisit when

The system WebView blocks something the page needs. Then move the window to Electron.

## Open questions

None.

# Fixtures

Test data. Tests read these files, so do not change them without running `bun test engine`.

| Folder | What it is |
| --- | --- |
| `recipe-search/` | An invented chat, "Recipe search", as a feature folder: plan files, run files, one wireframe. It is not copied from a real project. The engine's tests read it, and the window shows it during development. Its commands, such as `vitest run ...`, are never run. |
| `recipe-search/run/state.json` | The engine's task state for that chat: who works on what. |
| `maps/starship.json` | The map of Starship itself, in the map format. It uses every part of the format. The map tests and the map browser test read it. |
| `claude/`, `codex/` | Hook inputs, status line inputs, screens and session files that real runs of each tool gave, on 2026-11-11. The adapter tests read them. |
| `usage/` | Status line input and a session file, for the usage readers. |
| `real-tools.json` | What the real tools did when a run tried them, with their versions. |
| `rate-limited-cli/` | Two task files copied unchanged from the public MIT-licensed repo `vivekchopra/rate-limited-cli`. Its license is in `docs/templates/LICENSE-rate-limited-cli.txt`. They prove that the task parser reads real files written by a person, and writes them back byte for byte. |

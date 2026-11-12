# Templates

These five files (`ADR.md`, `PLAN.md`, `TASKS.md`, `ACCEPTANCE.md`, `PROMPTS.md`) are copied unchanged from `docs/templates/` of the public MIT-licensed repo `vivekchopra/rate-limited-cli`, on 2026-11-11. Its license is in `docs/templates/LICENSE-rate-limited-cli.txt`.

Starship uses them as the shape of its own plan files: a spec, then decision records, then a plan, tasks, acceptance and prompts.

Their examples are for a Python command-line tool, so they name `uv run pytest` and `file.py`. Task T032 adapts them for Starship's Plan stage and puts the result in `engine/templates/`. Until then, read them for the shape of each file, not for the commands.

There is no SPEC template. In that method the spec lives in the issue tracker.

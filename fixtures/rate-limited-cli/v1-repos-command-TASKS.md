# TASKS — v1 repos command

Depends on: docs/features/v1-repos-command/PLAN.md, docs/features/v1-repos-command/ACCEPTANCE.md

Each task: `- [ ] T0xx [P?] {behavior} — {files} — verify: {command} ({trace tag})`

`[P]` means different files and no dependency on an unfinished task in the same phase.

## Phase 0 — Repository scaffold

Blocks every later phase.

- [ ] T001 Create `pyproject.toml` with the `src/` layout, pinned `typer` and `httpx`, and console script `rate-limited-cli` — `pyproject.toml` (new) — verify: `uv sync` (plan: Stack)
- [ ] T002 [P] Add Python/uv `.gitignore` — `.gitignore` (new) — verify: `git status` shows no `.venv` (plan: Stack)
- [ ] T003 Configure pytest and ruff in `pyproject.toml` — `pyproject.toml` — verify: `uv run ruff check . && uv run pytest` run with zero tests (plan: Stack)
- [ ] T004 Add package `__init__.py` and a `cli.py` with a Typer app that prints help — `src/rate_limited_cli/__init__.py` (new), `src/rate_limited_cli/cli.py` (new) — verify: `uv run rate-limited-cli --help` exits 0 (plan: In scope #1)
- [ ] T005 Add a smoke test that `--help` exits 0 — `tests/test_cli.py` (new) — verify: `uv run pytest tests/test_cli.py` (acceptance: CLI)

Checkpoint: entrypoint runs, lint and tests pass — `uv run ruff check . && uv run pytest`

## Phase 1 — Domain models

Goal: typed records with only the fields the CLI uses.
Independent check: models import and construct in a REPL.

- [ ] T010 Add `Repository`, `RateLimit`, `RepoSummary` as frozen dataclasses per the plan — `src/rate_limited_cli/models.py` (new) — verify: `uv run python -c "from rate_limited_cli.models import Repository, RateLimit, RepoSummary"` (plan: Interfaces)
- [ ] T011 Do not add GitHub payload fields the CLI does not print. — `src/rate_limited_cli/models.py` — verify: field list equals the plan's Interfaces block (plan: Design rules)

Checkpoint: `uv run ruff check src/rate_limited_cli/models.py`

## Phase 2 — Pagination

Goal: a pure `next_link` function.
Independent check: `tests/test_pagination.py` passes with no HTTP.

- [ ] T020 Implement `next_link(link_header) -> str | None` — `src/rate_limited_cli/pagination.py` (new) — verify: `uv run pytest tests/test_pagination.py` (plan: In scope #2)
- [ ] T021 Test: no `Link` header returns `None` — `tests/test_pagination.py` (new) — verify: same (acceptance: Pagination)
- [ ] T022 Test: `next` and `last` present returns the `next` URL — `tests/test_pagination.py` — verify: same (acceptance: Pagination)
- [ ] T023 Test: `prev` and `next` present returns the `next` URL — `tests/test_pagination.py` — verify: same (acceptance: Pagination)
- [ ] T024 Test: extra commas and whitespace are tolerated — `tests/test_pagination.py` — verify: same (acceptance: Pagination)
- [ ] T025 Do not infer `page + 1` from response length anywhere. `per_page=` is allowed. — `src/rate_limited_cli/` — verify: `test -z "$(grep -Rn -E '[^_]page=' src/rate_limited_cli/ || true)"` (plan: Design rules)

Checkpoint: `uv run pytest tests/test_pagination.py`

## Phase 3 — GitHub client

Goal: `list_user_repos` fetches every page and maps errors.
Independent check: `tests/test_github.py` passes with `respx` mocks and no network.

- [ ] T030 Add `GitHubClient` with `httpx.Client`, `Accept: application/vnd.github+json`, a `User-Agent`, and a finite timeout — `src/rate_limited_cli/github.py` (new) — verify: `uv run pytest tests/test_github.py -k headers` (plan: Interfaces)
- [ ] T031 Implement `list_user_repos` with `per_page=100`, following `next_link` until `None` — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k three_pages` asserts 3 requests (acceptance: Pagination)
- [ ] T032 Implement `limit` stop; on an exact page boundary do not fetch another page — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k limit` asserts 2 requests for 120 and 1 request for 100 (plan: In scope #3)
- [ ] T033 Parse `x-ratelimit-*` from the last response into `RateLimit` — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k ratelimit` (plan: In scope #4)
- [ ] T034 Map 404, 403, 429, 5xx, timeout, and malformed JSON to the plan's exceptions — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k errors` (plan: Error and edge behavior)
- [ ] T035 Write the `respx` tests named in T030–T034 — `tests/test_github.py` (new) — verify: `uv run pytest tests/test_github.py` (acceptance: Pagination, Rate-limit metadata, Errors)
- [ ] T036 Do not retry, sleep, authenticate, or cache in v1. — `src/rate_limited_cli/github.py` — verify: `test -z "$(grep -Rn -E 'sleep|Authorization|If-None-Match|retry' src/rate_limited_cli/ || true)"` (plan: Out of scope)

Checkpoint: `uv run pytest tests/test_github.py`

## Phase 4 — Summary and output

Goal: deterministic text and JSON.
Independent check: `tests/test_output.py` passes with fixture data.

- [ ] T040 Implement `summarize(repos) -> RepoSummary` using the plan's Summary math, including the name tiebreak. Top 5 is over the list it is given. — `src/rate_limited_cli/output.py` (new) — verify: `uv run pytest tests/test_output.py -k summary` (plan: Summary math)
- [ ] T041 Implement `render_text(summary, rate_limit) -> str` — `src/rate_limited_cli/output.py` — verify: `uv run pytest tests/test_output.py -k text` (plan: In scope #5)
- [ ] T042 Implement `render_json(summary, rate_limit) -> str` with the plan's JSON schema, including `rate_limit: null` when headers are absent — `src/rate_limited_cli/output.py` — verify: `uv run pytest tests/test_output.py -k json` parses with `json.loads` and compares keys (plan: JSON schema)
- [ ] T043 Write the output tests — `tests/test_output.py` (new) — verify: `uv run pytest tests/test_output.py` (acceptance: Summary, JSON)
- [ ] T044 Do not make network calls from `output.py`. — `src/rate_limited_cli/output.py` — verify: `test -z "$(grep -n -E 'httpx|github' src/rate_limited_cli/output.py || true)"` (plan: Design rules)

Checkpoint: `uv run pytest tests/test_output.py`

## Phase 5 — CLI

Goal: `repos USER [--limit N] [--json]` end to end.
Independent check: `tests/test_cli.py` with `CliRunner` and `respx`.

- [ ] T050 Add `repos USER` command that builds `GitHubClient`, fetches, summarizes, and prints text — `src/rate_limited_cli/cli.py` — verify: `uv run pytest tests/test_cli.py -k text` (plan: In scope #1)
- [ ] T051 Add `--limit`, validated `> 0` with a Typer usage error on failure — `src/rate_limited_cli/cli.py` — verify: `uv run pytest tests/test_cli.py -k limit` asserts exit 2 for `--limit 0` (plan: Error and edge behavior)
- [ ] T052 Add `--json`; stdout is JSON only, diagnostics on stderr — `src/rate_limited_cli/cli.py` — verify: `uv run pytest tests/test_cli.py -k json` (acceptance: JSON)
- [ ] T053 Map `GitHubError` subclasses to one-line messages and exit 1 — `src/rate_limited_cli/cli.py` — verify: `uv run pytest tests/test_cli.py -k errors` asserts no "Traceback" in output (acceptance: Errors, Exit codes)
- [ ] T054 Extend CLI tests to cover T050–T053 — `tests/test_cli.py` — verify: `uv run pytest tests/test_cli.py` (acceptance: CLI)

Checkpoint: `uv run pytest && uv run ruff check .`

## Phase 6 — Documentation

- [ ] T060 Keep the tutorial framing (what this repo is for, read order, layout). In the sample section, add install, an example command and output, a rate-limit note, and the dev commands. Do not replace the whole README. — `README.md` — verify: `grep -q 'Plan before you prompt' README.md && grep -q 'rate-limited-cli repos octocat' README.md` (plan: Goal)
- [ ] T061 Compare `docs/ARCHITECTURE.md` to the code; remove the "starts as a plan" note; correct responsibilities — `docs/ARCHITECTURE.md` — verify: module table matches `src/rate_limited_cli/` file list (AGENTS.md: Documentation rules)
- [ ] T062 Do not add roadmap items or rejected options to `ARCHITECTURE.md`. — `docs/ARCHITECTURE.md` — verify: `test -z "$(grep -En '\\bwill\\b|plan to|considered' docs/ARCHITECTURE.md || true)"` (AGENTS.md: Documentation rules)

## Phase 7 — Acceptance

- [ ] T070 Run every item in `ACCEPTANCE.md` and record results in the PR — `docs/features/v1-repos-command/ACCEPTANCE.md` — verify: each item checked (acceptance: all)
- [ ] T071 Run the manual smoke test if network is available — none — verify: `uv run rate-limited-cli repos octocat` prints a summary (acceptance: Manual smoke)
- [ ] T072 Commit `uv.lock`; do not commit `.venv` or caches — `uv.lock` — verify: `git status --porcelain` is clean (plan: Stack)

## Done when

- [ ] Every in-scope behavior has a checked task
- [ ] No out-of-scope item has code
- [ ] `uv run pytest` and `uv run ruff check .` pass offline
- [ ] `docs/ARCHITECTURE.md` matches the code

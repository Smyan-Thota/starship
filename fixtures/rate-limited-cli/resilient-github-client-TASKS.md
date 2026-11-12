# TASKS — resilient GitHub client

Depends on: docs/features/resilient-github-client/PLAN.md, ADRs 2026-10-30-split-github-client-into-collaborators, 2026-10-30-rate-limit-wait-order, 2026-10-30-token-from-environment, spec docs/features/resilient-github-client/SPEC.md

Each task: `- [ ] T0xx [P?] {behavior} — {files} — verify: {command} ({trace tag})`

## Phase 0 — Collaborator contracts

Blocks every later phase.

- [ ] T001 Add `AuthConfig` with `from_env` and `headers`, and unit tests that do not need `GitHubClient` — `src/rate_limited_cli/auth.py` (new), `tests/test_auth.py` (new) — verify: `uv run pytest tests/test_auth.py` (plan: Interfaces)
- [ ] T002 [P] Add `WaitDecision` and `RateLimitPolicy.decide` skeleton returning `give-up` — `src/rate_limited_cli/ratelimit.py` (new) — verify: `uv run python -c "from rate_limited_cli.ratelimit import RateLimitPolicy, WaitDecision"` (plan: Interfaces)
- [ ] T003 [P] Add `RetryPolicy` with `should_retry` and `delay`. With `jitter=0`, `delay(0) == 1` and `delay(1) == 2`. `should_retry` is true while `attempt + 1 < max_attempts`. — `src/rate_limited_cli/retry.py` (new) — verify: `uv run python -c "from rate_limited_cli.retry import RetryPolicy; p = RetryPolicy(jitter=0); assert p.delay(0) == 1 and p.delay(1) == 2 and p.should_retry(0) and p.should_retry(1) and not p.should_retry(2)"` (plan: Interfaces)
- [ ] T004 [P] Add `cache_key`, `CacheEntry`, `CacheStore`, and `NullCacheStore`. `cache_key` hashes the token and never returns the raw token. — `src/rate_limited_cli/cache.py` (new), `tests/test_cache.py` (new) — verify: `uv run pytest tests/test_cache.py -k 'null or key'` (plan: Interfaces)
- [ ] T005 Change `GitHubClient.__init__` to the plan's signature; `cli.py` builds the defaults — `src/rate_limited_cli/github.py`, `src/rate_limited_cli/cli.py` — verify: `uv run pytest` still green (plan: Design rules)
- [ ] T006 Do not import `httpx` in any policy module. — `src/rate_limited_cli/auth.py`, `src/rate_limited_cli/ratelimit.py`, `src/rate_limited_cli/retry.py`, `src/rate_limited_cli/cache.py` — verify: `test -z "$(grep -l 'httpx' src/rate_limited_cli/auth.py src/rate_limited_cli/ratelimit.py src/rate_limited_cli/retry.py src/rate_limited_cli/cache.py || true)"` (ADR split-github-client-into-collaborators: Confirmation 3)

Checkpoint: constructor accepts the four collaborators and v1 tests pass — `uv run pytest`

## Phase 1 — Authentication

Goal: a token in the environment raises the quota.
Independent check: `GITHUB_TOKEN=x uv run rate-limited-cli repos octocat` sends a bearer header in a respx test.

- [ ] T010 Send `Authorization: Bearer` when `AuthConfig.token` is set — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_auth.py -k header_present` (plan: In scope #1)
- [ ] T011 Map 401 to `AuthError` with a friendly message — `src/rate_limited_cli/github.py`, `src/rate_limited_cli/cli.py` — verify: `uv run pytest tests/test_cli.py -k auth_error` (plan: Error and edge behavior)
- [ ] T012 Print one stderr line when the token is absent — `src/rate_limited_cli/cli.py` — verify: `uv run pytest tests/test_cli.py -k no_token_note` asserts stdout unchanged (plan: Error and edge behavior)
- [ ] T013 Do not add a `--token` option. Help text names `GITHUB_TOKEN`. — `src/rate_limited_cli/cli.py` — verify: `help=$(uv run rate-limited-cli repos --help); printf '%s\n' "$help" | grep -q GITHUB_TOKEN; ! printf '%s\n' "$help" | grep -q -- --token` (ADR token-from-environment: Confirmation 1 and 3)

Checkpoint: `uv run pytest tests/test_auth.py tests/test_cli.py`

## Phase 2 — Rate-limit waits

Goal: short waits are honored; long ones fail fast.
Independent check: respx returns 429 with `Retry-After: 5` then 200; `delays == [5.0]`.

- [ ] T020 Implement `RateLimitPolicy.decide` in the ADR's order. Return a kind. Do not raise, sleep, or compute a backoff delay. — `src/rate_limited_cli/ratelimit.py` — verify: `uv run pytest tests/test_ratelimit.py` (plan: In scope #2)
- [ ] T021 Test `Retry-After: 5` is `retry-after` for 5 seconds and wins over other headers. `Retry-After: 120` with the default cap is `give-up`. A non-numeric `Retry-After` is ignored. — `tests/test_ratelimit.py` (new) — verify: same (ADR rate-limit-wait-order: Confirmation 1, 2)
- [ ] T022 Test remaining 0 and reset 30 s ahead is `primary-reset` for 30 seconds. Reset 3600 s ahead is `give-up`. Reset at or before `now` is `primary-reset` with `seconds=0`. — `tests/test_ratelimit.py` — verify: same (ADR rate-limit-wait-order: Confirmation 3)
- [ ] T023 Test status 429 with no limit headers is `backoff` and `seconds is None`. Status 403 with no limit headers and no `secondary rate limit` body is `not-limited`. The same 403 whose body contains that phrase is `backoff`. — `tests/test_ratelimit.py` — verify: same (ADR rate-limit-wait-order: Confirmation 4, 5)
- [ ] T024 Execute the decision in `GitHubClient` via injected `sleep`. One attempt loop per page URL. Sleep only when another attempt will be made and `seconds > 0`. Pass `NullCacheStore` and `RetryPolicy(jitter=0)`. — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k 'retry_after or forbidden or past_reset'` (spec: Success measure)
- [ ] T025 `retry_after`: 429 with `Retry-After: 5`, then 200, is 2 requests and `delays == [5.0]`. `past_reset`: remaining 0 and reset in the past, then 200, is 2 requests and `delays == []`. `forbidden`: 403 with no limit signal is 1 request, `ForbiddenError`, and `delays == []`. — `tests/test_github.py` — verify: same (plan: Error and edge behavior)
- [ ] T026 Replace the v1 expectation that every 403 is an immediate `RateLimitedError`. A 403 with no limit signal is `ForbiddenError` and exit 1 with `GitHub denied the request`. A 429 still follows `WaitDecision`. — `tests/test_github.py`, `tests/test_cli.py`, `src/rate_limited_cli/cli.py` — verify: `uv run pytest tests/test_github.py tests/test_cli.py -k 'errors or forbidden'` (plan: Risks)
- [ ] T027 Do not call `time.sleep(` or `time.time(` anywhere. Defaults `= time.sleep` and `= time.time` have no parentheses and are allowed only in `github.py`. — `src/rate_limited_cli/` — verify: `test -z "$(grep -Rn -E 'time\.sleep\(|time\.time\(' src/rate_limited_cli/ || true)"` (ADR split-github-client-into-collaborators: Confirmation 1, 2)

Checkpoint: `uv run pytest tests/test_ratelimit.py tests/test_github.py`

## Phase 3 — Retry with backoff

Goal: transient 5xx and timeouts recover.
Independent check: respx returns 503, 503, 200; three requests, two recorded delays.

- [ ] T030 Loop attempts for one page URL in `GitHubClient` using `RetryPolicy.should_retry` and `delay`. Do not restart pagination from page 1. Tests pass `RetryPolicy(jitter=0)`. — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k transient` asserts 3 requests and `delays == [1.0, 2.0]` for 503, 503, 200 (plan: In scope #3)
- [ ] T031 Test `RetryPolicy(jitter=0)`: `delay(0) == 1`, `delay(1) == 2`, and `should_retry` is false at attempt 2 when `max_attempts=3`. The file does not call `sleep`. — `tests/test_retry.py` (new) — verify: `uv run pytest tests/test_retry.py` (ADR split-github-client-into-collaborators: Confirmation 4)
- [ ] T032 Do not sleep in any test, except a recorded `sleep=delays.append`. — `tests/` — verify: `test -z "$(grep -Rn 'sleep(' tests/ | grep -v 'delays.append' || true)"` (ADR split-github-client-into-collaborators: Confirmation 4)

Checkpoint: `uv run pytest tests/test_retry.py tests/test_github.py`

## Phase 4 — ETag cache

Goal: unchanged pages cost no quota.
Independent check: first call stores an ETag; second call sends `If-None-Match`, gets 304, returns the same repos.

- [ ] T040 Implement `FileCacheStore` rooted at a constructor path. `cli.py` passes `platformdirs.user_cache_dir("rate-limited-cli")`. Create the directory mode `0o700` and files mode `0o600`. Tests pass `tmp_path` and never the real user cache directory. — `src/rate_limited_cli/cache.py`, `src/rate_limited_cli/cli.py`, `pyproject.toml` — verify: `uv run pytest tests/test_cache.py -k file` (plan: Design rules)
- [ ] T041 Send `If-None-Match` for `cache_key(url, token)` and reuse that URL's body on 304. A different token must not hit the same entry. On 304, follow `rel="next"` from the cached body. — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k etag` (plan: In scope #4)
- [ ] T042 On cache read or write failure, emit `on_event` and continue — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k cache_failure` (plan: Error and edge behavior)
- [ ] T043 Treat 304 without a cache entry as `UpstreamError` — `src/rate_limited_cli/github.py` — verify: `uv run pytest tests/test_github.py -k unexpected_304` (plan: Error and edge behavior)

Checkpoint: `uv run pytest tests/test_cache.py tests/test_github.py`

## Phase 5 — Diagnostics, docs, rollout

- [ ] T050 Add `--verbose`; wire `on_event` to stderr — `src/rate_limited_cli/cli.py` — verify: `uv run pytest tests/test_cli.py -k verbose` asserts stdout JSON still parses (plan: In scope #5)
- [ ] T051 Update `docs/ARCHITECTURE.md`: diagram and table show the four collaborators; remove "Not yet in the system" — `docs/ARCHITECTURE.md` — verify: `grep -q auth.py docs/ARCHITECTURE.md && grep -q ratelimit.py docs/ARCHITECTURE.md && grep -q retry.py docs/ARCHITECTURE.md && grep -q cache.py docs/ARCHITECTURE.md && test -z "$(grep -En '\\bwill\\b|plan to|considered' docs/ARCHITECTURE.md || true)"` (AGENTS.md: Documentation rules)
- [ ] T052 Add a `GITHUB_TOKEN` note and the `platformdirs` cache location to README. Keep the tutorial framing, including "Plan before you prompt". — `README.md` — verify: `grep -q GITHUB_TOKEN README.md && grep -q 'Plan before you prompt' README.md && grep -q user_cache_dir README.md` (plan: Goal)
- [ ] T053 Set the three ADRs' index rows to their final status — `docs/adr/README.md` — verify: index matches each file's `Status:` line (AGENTS.md: Documentation rules)

## Done when

- [ ] Every in-scope behavior has a checked task
- [ ] No out-of-scope item has code
- [ ] Every Confirmation check in the three ADRs passes
- [ ] `uv run pytest` and `uv run ruff check .` pass offline in under 2 seconds
- [ ] `docs/ARCHITECTURE.md` matches the code

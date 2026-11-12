# TASKS — Recipe search

Depends on: docs/features/recipe-search/PLAN.md, accepted ADR 2026-11-11-search-in-postgres

Each task: `- [ ] T0xx [P?] {behavior} — {files} — verify: {command} ({trace tag})`

## Phase 0 — Foundation

Blocks every later phase.

- [x] T001 Trigram index migration — `db/migrations/recipes_trgm_index.sql` — verify: `yarn workspace db exec prisma migrate status` (plan: Design rules)
- [x] T002 `searchRecipes` resolver that returns an empty list — `api/src/services/RecipeSearchService.ts` — verify: `vitest run src/services/RecipeSearchService.search.test.ts -t empty` (plan: Interfaces)
- [x] T003 Shared types `SearchError` and the result shape — `api/src/services/recipeSearch.types.ts` — verify: `vitest run src/services/recipeSearch.types.test.ts` (plan: Interfaces)

Checkpoint: the resolver answers — `vitest run src/services`

## Phase 1 — Search

Goal: the API finds recipes by name and number.
Independent check: a query for R-111 returns one recipe.

- [x] T010 Search by name — `api/src/services/RecipeSearchService.ts` — verify: `vitest run src/services/RecipeSearchService.search.test.ts -t name` (in scope #1)
- [x] T011 Search by number — `api/src/services/RecipeSearchService.ts` — verify: `vitest run src/services/RecipeSearchService.search.test.ts -t number` (in scope #1)
- [x] T012 State filter — `api/src/services/RecipeSearchService.ts` — verify: `vitest run src/services/RecipeSearchService.search.test.ts -t state` (in scope #2)
- [x] T013 Paging — `api/src/services/RecipeSearchService.ts` — verify: `vitest run src/services/RecipeSearchService.search.test.ts -t page` (plan: Errors and edges)

Checkpoint: `vitest run src/services/RecipeSearchService.search.test.ts`

## Phase 2 — Screen

Goal: cooks search from the Cookbook page.
Independent check: typing R-1 shows three recipes.

- [x] T020 Search box — `app/src/pages/Cookbook/SearchBox.tsx` — verify: `vitest run src/pages/Cookbook/SearchBox.test.tsx` (in scope #1)
- [x] T021 Results list — `app/src/pages/Cookbook/Results.tsx` — verify: `vitest run src/pages/Cookbook/Results.test.tsx -t list` (in scope #1)
- [ ] T022 [P] Numbers match with or without the dash — `api/src/services/RecipeSearchService.ts` — verify: `vitest run src/services/RecipeSearchService.search.test.ts -t dash` (note 3)
- [ ] T023 [P] Empty and no-match states — `app/src/pages/Cookbook/Results.tsx` — verify: `vitest run src/pages/Cookbook/Results.test.tsx -t states` (in scope #3)
- [ ] T024 Keyboard support — `app/src/pages/Cookbook/SearchBox.tsx` — verify: `vitest run src/pages/Cookbook/SearchBox.test.tsx -t keyboard` (in scope #1)

Checkpoint: the page searches — `vitest run src/pages/Cookbook`

## Phase 3 — Errors

Goal: every failure has a message.
Independent check: with the API stopped, the page says search is unavailable.

- [ ] T030 API error state — `app/src/pages/Cookbook/Results.tsx` — verify: `vitest run src/pages/Cookbook/Results.test.tsx -t error` (plan: Errors and edges)
- [ ] T031 Archived recipes — `api/src/services/RecipeSearchService.ts` — verify: `vitest run src/services/RecipeSearchService.search.test.ts -t archived` (plan: Errors and edges)
- [ ] T032 One request per 250 ms — `app/src/pages/Cookbook/SearchBox.tsx` — verify: `vitest run src/pages/Cookbook/SearchBox.test.tsx -t wait` (note 1)
- [ ] T033 Short-query hint — `app/src/pages/Cookbook/Results.tsx` — verify: `vitest run src/pages/Cookbook/Results.test.tsx -t short` (plan: Errors and edges)

Checkpoint: `vitest run src/pages/Cookbook src/services`

## Phase 4 — Rollout

- [ ] T040 Update the architecture doc — `docs/ARCHITECTURE.md` — verify: `grep -q searchRecipes docs/ARCHITECTURE.md` (AGENTS.md: Documentation rules)
- [ ] T041 Write 6 story cards — `docs/features/recipe-search/run/review/story-cards.md` — verify: six cards with acceptance criteria (acceptance: Story cards)
- [ ] T042 Run acceptance — `docs/features/recipe-search/ACCEPTANCE.md` — verify: each item checked (acceptance: all)
- [ ] T043 Hand off for PR review — `docs/features/recipe-search/run/progress.md` — verify: the owner says go (spec: Scope)

## Done when

- [ ] Every in-scope behavior has a checked task
- [ ] No out-of-scope item has code

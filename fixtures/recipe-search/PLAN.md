# PLAN — Recipe search

Status: Accepted 14:52
Date: 2026-11-11
Spec: docs/features/recipe-search/SPEC.md
ADRs: 2026-11-11-search-in-postgres (Accepted)
Branch: starship/recipe-search

## Goal

Cooks find a recipe by name or number in under 5 seconds.

## In scope

1. Search by name and number
2. State filter
3. Empty, no-match and error states

## Out of scope

- Search inside PDF text
- Saved searches

An implementer does not build an out-of-scope item from this plan.

## Design rules

- Search runs in `RecipeSearchService`. The screen holds no search logic.
- One index migration. No new table.
- Typecheck and tests go through the run queue.

## Interfaces

```ts
searchRecipes(query: string, cuisine?: string, page?: number): { recipes: Recipe[]; total: number }
type SearchError = 'QUERY_TOO_SHORT' | 'SEARCH_UNAVAILABLE'
```

## Error and edge behavior

| Condition | Result |
| --- | --- |
| Empty query | All recipes, paged |
| 1 character | No search. "Type 2 or more characters." |
| No match | "No recipes match." |
| R111 or R-111 | Same results |
| API error | "Search is unavailable. Try again." |
| Typing fast | One request per 250 ms |
| Archived recipes | Open question |

## Rollout

One step. The index builds concurrently.

## Risks

- Slow query on short input — 2-character minimum.

# Acceptance — Recipe search

## Behavior

- "R-111" and "R111" return the same recipe.
- A name search matches any word in the recipe name.
- The cuisine filter narrows the results.
- 1 character runs no search.

## Errors

- No match: "No recipes match."
- API error: "Search is unavailable. Try again."

## Tests

- `vitest run src/services/RecipeSearchService.search.test.ts` passes.
- Typing 6 characters fast sends at most 2 requests.

## Story cards

- recipes-001 to recipes-006 pass on the test server.

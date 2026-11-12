Implement T022 only: recipe numbers match with or without the dash.
Files: api/src/services/RecipeSearchService.ts
Verify: vitest run src/services/RecipeSearchService.search.test.ts -t dash
R111 and R-111 return the same recipes (note 3).
Do not start T023 or later.
Ask the run queue for typecheck.

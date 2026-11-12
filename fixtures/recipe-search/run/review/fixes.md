# Fixes

- X1 Search does not trim the query, so " R-111" finds nothing. (api/src/services/RecipeSearchService.ts:42) — from F1
- X2 The empty state gives no hint to clear the filter. (app/src/RecipeSearch.tsx:18) — from F2

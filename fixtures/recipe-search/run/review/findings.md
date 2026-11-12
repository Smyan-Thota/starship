# Findings

## F1 · high · codex · api/src/services/RecipeSearchService.ts:42
Search does not trim the query, so " R-111" finds nothing.
Status: open

## F2 · low · claude · app/src/RecipeSearch.tsx:18
The empty state gives no hint to clear the filter.
Status: accepted

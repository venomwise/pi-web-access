# Auto Search Routing Design

## Summary

Add an explicit `searchIntent` parameter to `web_search` so AI agents can tell the tool whether a query is primarily reference-oriented or freshness-oriented. The first implementation only changes `provider: "auto"` behavior when `workflow: "none"` is used. Curator/UI mode keeps the existing single default provider behavior to avoid mismatches between UI state and actual per-query routing.

## Goals

- Let agents improve provider choice without requiring users to know provider strengths.
- Prefer Exa for reference and canonical-page discovery tasks.
- Prefer Perplexity, then Gemini, for fresh or fast-moving information tasks.
- Preserve existing explicit provider behavior.
- Preserve existing fallback semantics: first successful provider short-circuits the chain.
- Keep the first version local and deterministic, with no extra LLM classification request.

## Primary Users / Roles

- AI agents using `web_search` as a web access tool and choosing the best retrieval strategy from user intent.
- Pi users who expect `provider: "auto"` to work well without learning Exa, Perplexity, or Gemini trade-offs.
- Maintainers who need the provider routing logic to stay predictable and easy to evolve.

## Non-Goals

- Do not change explicit `provider: "exa"`, `"perplexity"`, or `"gemini"` behavior.
- Do not introduce per-query dynamic provider routing in curator/UI mode in this version.
- Do not add user-editable routing rules to `~/.pi/web-search.json`.
- Do not add a `searchIntent` default to `~/.pi/web-search.json`; the config schema is not extended in this version.
- Do not call an LLM to classify queries before searching.
- Do not change provider implementations or provider-specific request payloads.
- `searchIntent` and `provider` are orthogonal inputs; `searchIntent` only takes effect when `provider` resolves to `"auto"`.

## Context

- `index.ts` registers the `web_search` tool and supports `workflow: "none"` and curator-backed `summary-review`.
- `gemini-search.ts` owns provider selection and currently uses static `auto` fallback order: Exa, then Perplexity, then Gemini.
- Curator mode resolves `auto` to one concrete default provider before running queries. Changing per-query routing there would make the UI provider control less transparent.
- Exa is stronger for documentation, reference pages, pricing pages, product/company pages, and canonical or similar-page discovery.
- Perplexity and Gemini are better suited for breaking news, X/Twitter news, live sentiment, fast-moving discourse, and broad real-time synthesis.

## Discovery

### Key Discoveries

- The initial idea of keyword-only classification is weaker than letting the AI agent pass intent directly.
- The project is specifically an agent web access tool, so the calling agent can often infer user intent better than a local string matcher.
- Curator mode has a distinct interaction model: provider choice is visible and user-adjustable, so hidden per-query routing would be confusing.
- Classification mistakes should only affect provider order, not prevent fallback.

### Scope Decisions

- Add `searchIntent` with values `"auto"`, `"reference"`, and `"fresh"`.
- Treat `searchIntent` as meaningful only when `provider` resolves to `"auto"` and `workflow` is `"none"`.
- Use agent-provided `searchIntent` as the primary signal.
- Use a small local heuristic only when `searchIntent` is absent or `"auto"`.
- Keep curator/UI behavior unchanged for this iteration.

## Proposed Solution

Extend the `web_search` tool schema with:

```ts
searchIntent?: "auto" | "reference" | "fresh"
```

`reference` routes `auto` searches through:

```text
Exa -> Perplexity -> Gemini
```

`fresh` routes `auto` searches through:

```text
Perplexity -> Gemini -> Exa
```

`auto` or an omitted value uses a lightweight heuristic as a fallback. Reference-oriented hints include documentation, API/reference pages, pricing/plans, product/company pages, extracting page text, and expanding from canonical pages. Fresh-oriented hints include breaking news, X/Twitter, live sentiment, fast-moving discourse, and broad real-time synthesis across fresh sources.

### Heuristic Rules

The heuristic is deterministic, case-insensitive, and runs only when the effective intent is `"auto"` (explicit `"auto"` or omitted). Classification proceeds in order; the first matching rule wins:

1. **Fresh signals** (classify as `"fresh"`): presence of any of the tokens
   `news`, `breaking`, `latest`, `today`, `tonight`, `yesterday`, `this week`,
   `this month`, `live`, `update`, `updates`, `rumor`, `rumors`, `leak`,
   `leaked`, `announce`, `announced`, `released`, `release date`, `tweet`,
   `tweets`, `twitter`, `x.com`, `@`, or a bare 4-digit year within the last
   two calendar years (e.g. `2025`, `2026`).
2. **Reference signals** (classify as `"reference"`): presence of any of the tokens
   `docs`, `documentation`, `api`, `reference`, `manual`, `guide`, `tutorial`,
   `spec`, `specification`, `rfc`, `changelog`, `pricing`, `plans`, `pricing page`,
   `homepage`, `official site`, `github.com`, `npm`, `pypi`, `crates.io`,
   `maven`, or queries starting with `how to`, `what is`, `difference between`.
3. **Default**: classify as `"reference"`. This preserves the current auto
   ordering (Exa → Perplexity → Gemini) and avoids regression for queries
   that don't match either bucket.

The concrete token lists live in a single constant in `gemini-search.ts` so
they can evolve without touching the routing skeleton.

### Architecture

- Tool schema layer: `index.ts` exposes `searchIntent` to agents and passes it into `search()`.
- Search options layer: `gemini-search.ts` extends `FullSearchOptions` with `searchIntent`.
- Routing layer: `gemini-search.ts` maps `searchIntent` and heuristic fallback to an ordered provider list for `auto`.
- Provider execution layer: existing provider calls remain unchanged and continue to short-circuit on first successful result.

### Components

- `SearchIntent` type
  - Values: `"auto"`, `"reference"`, `"fresh"`.
  - Shared by `index.ts` and `gemini-search.ts` through exported types or local string enums.

- `normalizeSearchIntent()`
  - Converts unknown user/tool input to a safe intent.
  - Defaults to `"auto"`.

- `classifyAutoSearchIntent(query, options)`
  - Uses `searchIntent` first.
  - Falls back to local heuristics only when intent is `"auto"`.

- `getAutoProviderOrder(intent)`
  - Returns `["exa", "perplexity", "gemini"]` for reference.
  - Returns `["perplexity", "gemini", "exa"]` for fresh.
  - The caller intersects this order with runtime availability
    (`hasExaApiKey()` / `isExaAvailable()`, `isPerplexityAvailable()`,
    Gemini API key or web session) so unavailable providers are skipped
    rather than attempted as no-ops.

### Availability Intersection

Routing never invokes a provider that is not configured:

- Exa is included only when `isExaAvailable()` is true (API key or MCP fallback).
- Perplexity is included only when `isPerplexityAvailable()` is true.
- Gemini remains the terminal fallback when either the Gemini API key is
  set or a signed-in Gemini Web session is detected (mirrors current
  `searchWithGemini` behavior).
- If the intersection is empty, `search()` throws the existing
  no-provider error unchanged.

## Data Flow

1. Agent calls `web_search` with `provider: "auto"` or no provider.
2. Agent may include `searchIntent`.
3. If `workflow` is curator-backed, current behavior remains: `auto` is resolved to a default provider for the UI.
4. If `workflow: "none"`, `index.ts` passes `searchIntent` to `search()`.
5. `search()` checks resolved provider.
6. If provider is explicit, ignore `searchIntent`.
7. If provider is `auto`, determine provider order from `searchIntent` or heuristic fallback, then intersect with runtime availability.
8. Execute providers in order, returning the first successful result.
9. If all providers fail or are unavailable, return the existing aggregated error behavior.

## Observability

To make auto routing auditable without adding log noise, the `web_search`
tool result `details` object gains two fields when `provider` resolved to
`"auto"` and `workflow` was `"none"`:

- `resolvedSearchIntent`: `"reference" | "fresh"` — the intent after
  normalization and heuristic fallback.
- `autoProviderOrder`: `ResolvedSearchProvider[]` — the ordered list of
  providers that were eligible after availability intersection, in the
  order they would have been attempted.

The winning provider is already surfaced via the existing `provider` field
on `AttributedSearchResponse`, so no further change is needed there. These
fields are omitted for explicit providers and for curator workflows so
they don't leak implementation details to callers that can't act on them.

## Error Handling

- Invalid or unknown `searchIntent` values normalize to `"auto"` rather than throwing.
- Provider failures continue to be collected as fallback errors.
- Abort errors still propagate immediately.
- Exa exhaustion is treated as a fallback condition in `auto`, allowing Perplexity or Gemini to run.
- If no provider is available, the existing no-provider error remains.

## Testing

The repository currently has no automated test suite (per `AGENTS.md`),
so the following are manual verification scenarios to run against a
local Pi install before opening a PR. If a `tests/` directory is
introduced later, each scenario maps to a `*.test.ts` case.

Manual scenarios:

- `workflow: "none"`, `provider: "auto"`, `searchIntent: "reference"` tries Exa before Perplexity/Gemini.
- `workflow: "none"`, `provider: "auto"`, `searchIntent: "fresh"` tries Perplexity before Gemini and Exa.
- Explicit `provider: "exa"` ignores `searchIntent` and does not expose `resolvedSearchIntent` / `autoProviderOrder`.
- Explicit `provider: "perplexity"` ignores `searchIntent`.
- Explicit `provider: "gemini"` ignores `searchIntent`.
- Curator/UI mode does not use per-query dynamic routing and keeps the current default provider resolution; `resolvedSearchIntent` is not surfaced.
- Omitted or `"auto"` `searchIntent` uses the heuristic rules above (verify one fresh-signal query and one reference-signal query, plus one neutral query that falls through to the `"reference"` default).
- When only one provider is available (e.g. only Gemini API key set), `autoProviderOrder` contains only that provider and the chain does not attempt missing providers.
- Invalid `searchIntent` values (e.g. `"foo"`) normalize to `"auto"` and do not throw.

Release check:

- `npm pack --dry-run` succeeds.

## Open Questions

- Should curator mode later show a recommended provider per query while still letting the user override it?
- Should `searchIntent` values eventually include more granular categories such as `"code"`, `"academic"`, or `"local-business"`?
- Should the `"fresh"` order drop Exa entirely once Perplexity and Gemini are both exhausted, or keep it as a canonical-page safety net? (Kept in v1; revisit if telemetry shows Exa rarely contributes in the fresh path.)

## Resolved Decisions

- **Observability**: Resolved — `details.resolvedSearchIntent` and `details.autoProviderOrder` are exposed in v1 for `auto` + `workflow: "none"` only. See Observability section.
- **Heuristic fallback default**: Resolved — falls through to `"reference"` to match the current auto order and avoid regressions.
- **Config-driven default intent**: Resolved as a non-goal for v1.

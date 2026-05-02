# Implementation Plan: Auto Search Routing

## Overview

This implementation plan is driven by the requirements in [requirements.md](requirements.md).

The work is organized into four execution phases plus two checkpoints. Phase 1 introduces the shared `SearchIntent` type, normalization helper, and heuristic classifier in `gemini-search.ts` — the purely local, side-effect-free core. Phase 2 wires intent-driven provider ordering with availability intersection into `search()` so the `auto` chain becomes intent-aware while preserving short-circuit and abort semantics. Phase 3 exposes `searchIntent` on the `web_search` tool schema in `index.ts`, plumbs it through to `search()`, and adds the `resolvedSearchIntent` / `autoProviderOrder` observability fields. Phase 4 updates `README.md` provider-fallback documentation to reflect the new routing and records manual verification results.

Key technical decisions: stay in TypeScript ESM with explicit `.js` import suffixes (per `AGENTS.md`); keep all routing logic inside `gemini-search.ts` so feature modules don't duplicate protocol/provider checks; use `Type.Optional(StringEnum(...))` from `@sinclair/typebox` (matching existing schema style in `index.ts`) to declare the new parameter; do not extend `~/.pi/web-search.json`; no network calls in the heuristic.

## Tasks

- [✅] 1. Phase 1: SearchIntent core (types, normalization, heuristic)
  - [✅] 1.1 Introduce `SearchIntent` type and normalization
    - Modify `gemini-search.ts` to export `type SearchIntent = "auto" | "reference" | "fresh"`
    - Add `normalizeSearchIntent(value: unknown): SearchIntent` that lowercases/trims input and returns `"auto"` for anything outside the enum
    - Extend `FullSearchOptions` in `gemini-search.ts` with `searchIntent?: SearchIntent`
    - _Requirements: 1.1, 1.2, 1.3_
  - [✅] 1.2 Implement deterministic heuristic classifier
    - Add `classifyAutoSearchIntent(query: string): "reference" | "fresh"` in `gemini-search.ts`
    - Define two frozen token arrays (`FRESH_SIGNALS`, `REFERENCE_SIGNALS`) as module-level constants
    - Match case-insensitively; also detect 4-digit years within the last two calendar years as a fresh signal
    - Default to `"reference"` when no signal matches; never call network or LLM
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5_
  - [✅] 1.3 Add `getAutoProviderOrder(intent)` mapping
    - Add `getAutoProviderOrder(intent: "reference" | "fresh"): ResolvedSearchProvider[]` in `gemini-search.ts`
    - Return `["exa", "perplexity", "gemini"]` for reference, `["perplexity", "gemini", "exa"]` for fresh
    - _Requirements: 2.1, 2.2, 7.1_
  - [✅]* 1.4 Manually verify classifier behavior
    - Exercise the classifier via a short ad-hoc script (not committed) against representative queries: `"React docs"`, `"breaking news on OpenAI today"`, `"2026 election rumors"`, `"difference between REST and GraphQL"`, and a neutral query like `"tomato soup recipe"`
    - Confirm outputs match the heuristic rules
    - _Requirements: 3.2, 3.3, 3.4_

- [✅] 2. Phase 2: Intent-driven routing in `search()`
  - [✅] 2.1 Resolve effective intent inside `search()`
    - Modify `search()` in `gemini-search.ts` to compute `effectiveIntent` after confirming `provider === "auto"`
    - If `options.searchIntent` is `"reference"` or `"fresh"`, use it directly; otherwise (`"auto"` / omitted / normalized) call `classifyAutoSearchIntent(query)`
    - Leave all explicit-provider branches unchanged — no `searchIntent` usage there
    - _Requirements: 1.4, 2.1, 2.2, 3.1, 7.2_
  - [✅] 2.2 Build availability-intersected provider chain
    - Add a helper `buildAutoChain(order, availability)` in `gemini-search.ts` that preserves relative order while filtering on `isExaAvailable()`, `isPerplexityAvailable()`, and Gemini availability (API key or Gemini Web session via `isGeminiWebAvailable`-style check compatible with current fallback)
    - Replace the hardcoded Exa → Perplexity → Gemini fallback block in `search()` with a loop that iterates the intersected chain and calls the matching per-provider function
    - _Requirements: 2.1, 2.2, 2.3, 4.1, 4.2, 7.1_
  - [✅] 2.3 Preserve fallback, abort, and Exa-exhaustion semantics
    - Keep `isAbortError(err)` propagation: re-throw immediately, do not continue chain
    - Non-abort errors are pushed onto `fallbackErrors` and iteration continues
    - Exa `"exhausted"` response in `auto` is treated as a fallthrough (not thrown), allowing the next provider in the chain to run
    - If the intersected chain is empty, throw the existing no-provider error message unchanged
    - If all providers fail, throw the existing aggregated `"Auto provider search failed:\n  - ..."` error
    - _Requirements: 2.3, 2.4, 2.5, 2.6, 4.3, 4.4_
  - [✅]* 2.4 Unit-style manual verification of routing
    - Temporarily instrument `search()` (local only, revert before commit) to log the computed `effectiveIntent` and chain
    - Confirm reference intent yields Exa first, fresh yields Perplexity first, and unavailable providers are skipped
    - _Requirements: 2.1, 2.2, 4.1, 4.2_

- [✅] 3. Checkpoint - Verify routing core
  - Re-read `gemini-search.ts` end-to-end to confirm explicit-provider branches are untouched and the new chain loop only runs under `provider === "auto"`.
  - Ensure `npm pack --dry-run` succeeds.
  - Ask the user if any routing question is ambiguous before moving on.

- [ ] 4. Phase 3: Tool schema, plumbing, and observability
  - [✅] 4.1 Extend `web_search` tool schema with `searchIntent`
    - Modify the `parameters` object in the `pi.registerTool({ name: "web_search", ... })` call in `index.ts` to add `searchIntent: Type.Optional(StringEnum(["auto", "reference", "fresh"], { description: "Hints provider ordering in auto mode: 'reference' favors Exa for docs/canonical pages; 'fresh' favors Perplexity/Gemini for breaking news; 'auto' (default) uses a local heuristic." }))`
    - Update the tool `description` to briefly mention `searchIntent` and that it only affects `provider: "auto"` with `workflow: "none"`
    - _Requirements: 1.1, 1.2, 1.3_
  - [✅] 4.2 Plumb `searchIntent` into `search()` for headless workflow
    - In the `workflow: "none"` branch of the `web_search` `execute` handler in `index.ts`, pass `searchIntent: normalizeSearchIntent(params.searchIntent)` when calling `search()`
    - Do NOT pass `searchIntent` when `workflow` resolves to `"summary-review"`; the curator path keeps its existing bootstrap-driven provider resolution
    - _Requirements: 1.4, 1.5, 5.1, 5.2, 7.2_
  - [✅] 4.3 Emit observability fields in tool result
    - Modify the headless (`workflow: "none"`) return path in `index.ts` so when the resolved provider was `"auto"`, the returned `details` object includes `resolvedSearchIntent` (the final `"reference" | "fresh"` value) and `autoProviderOrder` (the intersected chain)
    - Expose the effective intent and chain from `search()` either by returning them alongside `AttributedSearchResponse` (e.g., new optional fields `resolvedSearchIntent?`, `autoProviderOrder?`) or by a small sibling function; whichever keeps the public surface minimal
    - Omit both fields for explicit providers and for `summary-review` workflows
    - Do not add a duplicate winning-provider field; continue relying on `AttributedSearchResponse.provider`
    - _Requirements: 5.3, 6.1, 6.2, 6.3, 6.4_
  - [ ]* 4.4 Manual end-to-end verification through Pi
    - Install locally with `pi install npm:.` after `npm install`
    - Run `web_search` with `provider: "auto"`, `workflow: "none"` and each of `searchIntent: "reference"`, `"fresh"`, omitted; confirm `details.resolvedSearchIntent` and `details.autoProviderOrder` reflect expectations
    - Run `web_search` with `provider: "exa"` and confirm `details` contains neither field
    - Run curator mode (default workflow) and confirm neither field appears and the provider chip matches execution
    - _Requirements: 1.4, 1.5, 5.3, 6.1, 6.2, 6.3_

- [✅] 5. Phase 4: Documentation and release readiness
  - [✅] 5.1 Update `README.md` provider/fallback section
    - Modify `README.md` to document `searchIntent` (values, scope-limited to `auto` + `workflow: "none"`) and note that explicit provider selection is unchanged
    - Describe the new `details.resolvedSearchIntent` / `details.autoProviderOrder` fields
    - Preserve the existing documented fallback chain wording elsewhere
    - _Requirements: 1.1, 6.1, 6.2, 6.3, 7.3_
  - [✅]* 5.2 Draft a Conventional Commits message
    - Propose `feat: add searchIntent routing for web_search auto mode` matching the repo's convention in `AGENTS.md`
    - Include a short body summarizing manual verification steps
    - _Requirements: 7.2, 7.3_

- [✅] 6. Checkpoint - Release sign-off
  - Confirm no changes to explicit provider paths by diff review of `gemini-search.ts`.
  - Confirm `~/.pi/web-search.json` schema is untouched (no new config key introduced).
  - Run `npm pack --dry-run` one more time.
  - Ask the user for approval before committing.

## Notes

- Tasks marked with `*` are optional and can be skipped for an MVP; they are verification and documentation wrap-up steps rather than correctness-critical work.
- Each task references one or more requirement IDs in `N.M` form for traceability back to `requirements.md`.
- Keep task numbering stable so requirement references stay valid across updates.
- Implementation language: TypeScript ESM with explicit `.js` import suffixes.
- Module boundaries: tool schema and plumbing in `index.ts`; all routing, normalization, and heuristic logic in `gemini-search.ts`; no changes to provider modules (`exa.ts`, `perplexity.ts`, `gemini-web.ts`, `gemini-api.ts`).
- Testing strategy: no formal test suite exists (per `AGENTS.md`); validate via the manual scenarios listed in `design.md` §Testing and the optional Pi-based end-to-end pass in Task 4.4.

# Requirements Document: Auto Search Routing

## Introduction

Auto Search Routing extends the `web_search` tool with an explicit `searchIntent` input so AI agents can tell the tool whether a query is reference-oriented (documentation, canonical pages) or freshness-oriented (breaking news, live discourse). The first release only affects behavior when the resolved provider is `"auto"` and `workflow` is `"none"`; curator-backed workflows keep the existing single default-provider resolution to avoid desyncing the UI provider chip from real execution. Provider choice remains deterministic and local: no extra LLM classification call is introduced, the normal short-circuit fallback chain is preserved, and unavailable providers are skipped rather than attempted as no-ops.

This capability targets AI agents integrating `web_search` as a retrieval tool, Pi users who expect `provider: "auto"` to work well without studying provider trade-offs, and maintainers who need routing logic that is predictable and easy to evolve. It is deliberately scoped to provider ordering and observability around it; provider implementations, request payloads, and curator UI semantics are out of scope.

## Glossary

- **Provider**: A concrete search backend — one of `exa`, `perplexity`, `gemini`.
- **Auto mode**: `provider: "auto"` (explicit or defaulted via `~/.pi/web-search.json`), meaning the tool picks a provider chain instead of a single backend.
- **Search Intent**: The `searchIntent` input declaring whether the query prefers reference sources or fresh sources. Values: `"auto"`, `"reference"`, `"fresh"`.
- **Reference intent**: Queries best served by canonical pages (docs, API reference, pricing, product/company pages).
- **Fresh intent**: Queries best served by real-time synthesis (breaking news, X/Twitter, live sentiment).
- **Heuristic Fallback**: A deterministic local token-match classifier used when the effective intent is `"auto"`.
- **Provider Order**: An ordered list of providers produced by `getAutoProviderOrder(intent)` and then intersected with runtime availability.
- **Availability Intersection**: The filter step that removes providers whose credentials or sessions are not configured (`isExaAvailable`, `isPerplexityAvailable`, Gemini API key or web session).
- **Curator workflow**: `workflow: "summary-review"` — the interactive browser-based curation UI that resolves `auto` to a single default provider up front.
- **Observability fields**: `details.resolvedSearchIntent` and `details.autoProviderOrder` added to the `web_search` tool result for auditing auto-mode decisions.

## Requirements

### Requirement 1: Tool Schema Exposes `searchIntent`

**User Story:** As an AI agent calling `web_search`, I want to declare the intent of my query, so that the tool can pick a provider chain better suited to reference vs fresh retrieval without me needing to know provider strengths.

#### Acceptance Criteria

1. WHEN the `web_search` tool is registered in `index.ts`, THEN the system SHALL expose an optional `searchIntent` parameter that accepts `"auto"`, `"reference"`, or `"fresh"`.
2. WHEN an agent omits `searchIntent`, THEN the system SHALL treat the effective intent as `"auto"` without throwing.
3. WHEN an agent passes an unrecognized string for `searchIntent`, THEN the system SHALL normalize it to `"auto"` rather than returning a validation error.
4. WHEN an agent passes `searchIntent` together with an explicit `provider` (`exa`, `perplexity`, or `gemini`), THEN the system SHALL ignore `searchIntent` and use the explicit provider.
5. WHEN an agent passes `searchIntent` with a curator-backed workflow (`summary-review`), THEN the system SHALL NOT apply per-query routing and SHALL preserve the existing default-provider resolution.

### Requirement 2: Intent-Driven Provider Ordering in Auto Mode

**User Story:** As an AI agent performing headless searches, I want `auto` mode to reorder providers based on declared intent, so that reference queries favor Exa and fresh queries favor Perplexity/Gemini.

#### Acceptance Criteria

1. WHEN the resolved provider is `"auto"`, `workflow` is `"none"`, and `searchIntent` is `"reference"`, THEN the system SHALL attempt providers in the order Exa → Perplexity → Gemini.
2. WHEN the resolved provider is `"auto"`, `workflow` is `"none"`, and `searchIntent` is `"fresh"`, THEN the system SHALL attempt providers in the order Perplexity → Gemini → Exa.
3. WHEN the first attempted provider returns a successful response, THEN the system SHALL short-circuit the chain and return that provider's result attributed via `AttributedSearchResponse.provider`.
4. WHEN a provider in the chain throws a non-abort error, THEN the system SHALL collect the error and continue with the next provider in the chain.
5. WHEN a provider throws an abort error, THEN the system SHALL propagate the abort immediately without falling through to remaining providers.
6. IF all providers in the effective chain fail, THEN the system SHALL throw the existing aggregated "Auto provider search failed" error listing per-provider failure reasons.

### Requirement 3: Heuristic Fallback for `auto` Intent

**User Story:** As an AI agent that forgets to set `searchIntent`, I want the tool to make a reasonable local guess, so that I still get intent-appropriate routing without an extra classification call.

#### Acceptance Criteria

1. WHEN the effective intent is `"auto"`, THEN the system SHALL run a deterministic, case-insensitive token-match classifier over the query string.
2. WHEN the query contains any fresh-signal token (e.g. `news`, `breaking`, `latest`, `today`, `twitter`, `x.com`, or a 4-digit year within the last two calendar years), THEN the classifier SHALL output `"fresh"`.
3. WHEN no fresh signal matches AND the query contains any reference-signal token (e.g. `docs`, `documentation`, `api`, `reference`, `pricing`, `how to`, `what is`), THEN the classifier SHALL output `"reference"`.
4. WHEN neither fresh nor reference signals match, THEN the classifier SHALL default to `"reference"` so the chain preserves the current Exa → Perplexity → Gemini order.
5. WHEN the classifier is invoked, THEN it SHALL NOT call any network resource or LLM.

### Requirement 4: Availability Intersection

**User Story:** As a Pi user with only some providers configured, I want the tool to skip providers I have not set up, so that auto mode does not waste attempts on no-op calls or produce misleading errors.

#### Acceptance Criteria

1. WHEN building the effective provider chain, THEN the system SHALL intersect the ordered list from `getAutoProviderOrder` with runtime availability checks (`isExaAvailable`, `isPerplexityAvailable`, Gemini API key or signed-in Gemini Web session).
2. WHEN only a subset of providers is available, THEN the system SHALL preserve the relative order of the remaining providers from the intent-driven ordering.
3. IF the intersection is empty, THEN the system SHALL throw the existing no-provider error with instructions to configure a provider.
4. WHEN Exa reports "monthly free tier exhausted" in `auto` mode, THEN the system SHALL treat it as a fallback condition and continue with the remaining chain rather than surfacing the Exa-exhausted error.

### Requirement 5: Curator Workflow Isolation

**User Story:** As a Pi user interacting with the curator UI, I want the provider chip to reflect what actually runs, so that hidden per-query routing does not make the UI misleading.

#### Acceptance Criteria

1. WHEN `workflow` resolves to `"summary-review"`, THEN the system SHALL continue to resolve `auto` to a single default provider via the existing `loadCuratorBootstrap` path.
2. WHEN `workflow` resolves to `"summary-review"`, THEN the system SHALL ignore any `searchIntent` value for provider ordering.
3. WHEN `workflow` resolves to `"summary-review"`, THEN the system SHALL NOT expose `details.resolvedSearchIntent` or `details.autoProviderOrder` on the tool result.

### Requirement 6: Observability of Auto Routing

**User Story:** As a maintainer auditing auto-mode decisions, I want the tool result to report the resolved intent and the provider order that was attempted, so that I can diagnose unexpected routing without rerunning with debug logs.

#### Acceptance Criteria

1. WHEN the resolved provider is `"auto"` AND `workflow` is `"none"`, THEN the `web_search` tool result `details` SHALL include `resolvedSearchIntent` with a value of `"reference"` or `"fresh"` (never `"auto"`).
2. WHEN the resolved provider is `"auto"` AND `workflow` is `"none"`, THEN the `details` SHALL include `autoProviderOrder` as an array of `ResolvedSearchProvider` entries reflecting the post-availability-intersection order that would have been attempted.
3. WHEN the provider is explicit (`exa`, `perplexity`, or `gemini`), THEN the system SHALL omit both `resolvedSearchIntent` and `autoProviderOrder` from `details`.
4. WHEN the winning provider is already reported via `AttributedSearchResponse.provider`, THEN the system SHALL NOT duplicate that value in a new field.

### Requirement 7: Backward Compatibility and Non-Extension

**User Story:** As an existing caller of `web_search`, I want my current invocations to behave exactly as before, so that adopting the new feature is strictly opt-in.

#### Acceptance Criteria

1. WHEN callers do not pass `searchIntent` AND the query matches no heuristic signal, THEN the effective provider order SHALL equal today's order: Exa → Perplexity → Gemini.
2. WHEN callers pass explicit `provider: "exa" | "perplexity" | "gemini"`, THEN the behavior SHALL be byte-for-byte unchanged from the current implementation.
3. WHEN `~/.pi/web-search.json` is read, THEN the system SHALL NOT parse any `searchIntent` field and SHALL NOT extend the config schema in this version.
4. WHEN provider-specific request payloads are built, THEN the system SHALL NOT inject `searchIntent` into provider HTTP requests.

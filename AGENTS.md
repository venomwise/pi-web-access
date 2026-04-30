# Repository Guidelines

## Project Structure & Module Organization
This repository is a flat TypeScript ESM package for the Pi agent. Core extension entry points live in the repository root: `index.ts` registers tools, `extract.ts` handles content fetching, and provider-specific modules such as `exa.ts`, `perplexity.ts`, `gemini-web.ts`, and `github-extract.ts` isolate integrations. Gemini API transport and protocol mapping belong in `gemini-api.ts`, with provider capability checks centralized in `gemini-capabilities.ts`. UI-related curator code lives in `curator-page.ts` and `curator-server.ts`. Shared helpers belong in focused root files like `utils.ts`, `storage.ts`, and `activity.ts`. Bundled agent skills live under `skills/`.

## Build, Test, and Development Commands
There are no npm scripts defined in `package.json`, so contributors should use direct commands:

```bash
npm install          # install dependencies
npm pack             # verify the package can be packed for npm
pi install npm:.     # install the local package into Pi for manual testing
```

Use the examples in `README.md` to exercise `web_search`, `fetch_content`, and `code_search` flows after local changes.

## Coding Style & Naming Conventions
Use TypeScript with ESM imports and explicit `.js` import suffixes, matching the current codebase. Follow the existing style: tabs for indentation, `camelCase` for functions and variables, `PascalCase` for types/interfaces, and short, single-purpose modules named with `kebab-case` when split by concern, for example `github-extract.ts`. Keep provider fallback logic and error handling local to each integration module instead of centralizing unrelated branches.

## Testing Guidelines
There is no formal automated test suite yet. Before opening a PR, run `npm pack` and manually validate the affected behavior through Pi using realistic inputs, such as a normal URL, a GitHub URL, and any provider-specific path you changed. If you add automated tests later, place them in a dedicated `tests/` directory and name files `*.test.ts` for consistency.

## Commit & Pull Request Guidelines
Recent history follows Conventional Commits, for example `fix: add promptSnippet metadata for web tools` and `feat: add Exa.ai provider with MCP fallback and code_search tool`. Continue using `feat:`, `fix:`, and `chore:` prefixes with concise subjects. PRs should include a short behavior summary, manual verification steps, linked issues when relevant, and screenshots or terminal excerpts for curator UI or workflow changes.

## Configuration & Security Tips
Do not commit API keys or browser profile data. Local credentials belong in `~/.pi/web-search.json`. When changing provider logic, preserve the documented fallback order in `README.md` and note any user-visible config changes there. Keep Gemini API protocol and capability decisions centralized in `gemini-api.ts` and `gemini-capabilities.ts` instead of duplicating protocol checks in feature modules.

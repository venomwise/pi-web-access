import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import { generateText, generateWithTools, getGeminiApiConfig } from "./gemini-api.js";
import { supportsGoogleSearchTool } from "./gemini-capabilities.js";
import { isGeminiWebAvailable, queryWithCookies } from "./gemini-web.js";
import { isPerplexityAvailable, searchWithPerplexity, type SearchResult, type SearchResponse, type SearchOptions } from "./perplexity.js";
import { hasExaApiKey, isExaAvailable, searchWithExa } from "./exa.js";

export type SearchProvider = "auto" | "perplexity" | "gemini" | "exa";
export type ResolvedSearchProvider = Exclude<SearchProvider, "auto">;

export type SearchIntent = "auto" | "reference" | "fresh";

export interface AttributedSearchResponse extends SearchResponse {
	provider: ResolvedSearchProvider;
	resolvedSearchIntent?: "reference" | "fresh";
	autoProviderOrder?: ResolvedSearchProvider[];
}

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

let cachedSearchConfig: { searchProvider: SearchProvider; searchModel?: string } | null = null;

function getSearchConfig(): { searchProvider: SearchProvider; searchModel?: string } {
	if (cachedSearchConfig) return cachedSearchConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedSearchConfig = { searchProvider: "auto", searchModel: undefined };
		return cachedSearchConfig;
	}

	const rawText = readFileSync(CONFIG_PATH, "utf-8");
	let raw: {
		searchProvider?: SearchProvider;
		provider?: SearchProvider;
		searchModel?: unknown;
	};
	try {
		raw = JSON.parse(rawText) as {
			searchProvider?: SearchProvider;
			provider?: SearchProvider;
			searchModel?: unknown;
		};
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}

	cachedSearchConfig = {
		searchProvider: normalizeSearchProvider(raw.searchProvider ?? raw.provider),
		searchModel: normalizeSearchModel(raw.searchModel),
	};
	return cachedSearchConfig;
}

function normalizeSearchModel(value: unknown): string | undefined {
	if (typeof value !== "string") return undefined;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : undefined;
}

function normalizeSearchProvider(value: unknown): SearchProvider {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "auto" || normalized === "perplexity" || normalized === "gemini" || normalized === "exa"
		? normalized
		: "auto";
}

export interface FullSearchOptions extends SearchOptions {
	provider?: SearchProvider;
	includeContent?: boolean;
	searchIntent?: SearchIntent;
}

export function normalizeSearchIntent(value: unknown): SearchIntent {
	const normalized = typeof value === "string" ? value.trim().toLowerCase() : "";
	return normalized === "reference" || normalized === "fresh" ? normalized : "auto";
}

const FRESH_SIGNALS: readonly string[] = Object.freeze([
	"news", "breaking", "latest", "today", "tonight", "yesterday",
	"this week", "this month", "live", "update", "updates",
	"rumor", "rumors", "leak", "leaked",
	"announce", "announced", "released", "release date",
	"tweet", "tweets", "twitter", "x.com", "@",
]);

const REFERENCE_SIGNALS: readonly string[] = Object.freeze([
	"docs", "documentation", "api", "reference", "manual",
	"guide", "tutorial", "spec", "specification", "rfc",
	"changelog", "pricing", "plans", "pricing page",
	"homepage", "official site",
	"github.com", "npm", "pypi", "crates.io", "maven",
	"how to", "what is", "difference between",
]);

export function classifyAutoSearchIntent(query: string): "reference" | "fresh" {
	const haystack = query.toLowerCase();

	for (const token of FRESH_SIGNALS) {
		if (haystack.includes(token)) return "fresh";
	}

	// Recent-year signal: any 4-digit year within the last two calendar years.
	const currentYear = new Date().getFullYear();
	const yearMatches = haystack.match(/\b(19|20)\d{2}\b/g);
	if (yearMatches) {
		for (const raw of yearMatches) {
			const y = Number(raw);
			if (y >= currentYear - 1 && y <= currentYear) return "fresh";
		}
	}

	for (const token of REFERENCE_SIGNALS) {
		if (haystack.includes(token)) return "reference";
	}

	return "reference";
}

export function getAutoProviderOrder(intent: "reference" | "fresh"): ResolvedSearchProvider[] {
	return intent === "fresh"
		? ["perplexity", "gemini", "exa"]
		: ["exa", "perplexity", "gemini"];
}

function buildAutoChain(order: ResolvedSearchProvider[]): ResolvedSearchProvider[] {
	return order.filter((p) => {
		if (p === "exa") return isExaAvailable();
		if (p === "perplexity") return isPerplexityAvailable();
		// Gemini availability (API key or signed-in web session) is probed lazily
		// inside searchWithGemini; treat it as always eligible to preserve the
		// existing terminal-fallback behavior.
		return true;
	});
}

function providerLabel(p: ResolvedSearchProvider): string {
	if (p === "exa") return "Exa";
	if (p === "perplexity") return "Perplexity";
	return "Gemini";
}

function errorMessage(err: unknown): string {
	return err instanceof Error ? err.message : String(err);
}

function isAbortError(err: unknown): boolean {
	return errorMessage(err).toLowerCase().includes("abort");
}

async function searchWithGemini(
	query: string,
	options: SearchOptions,
	strictErrors: boolean,
): Promise<SearchResponse | null> {
	const errors: string[] = [];

	try {
		const apiResult = await searchWithGeminiApi(query, options);
		if (apiResult) return apiResult;
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini API: ${errorMessage(err)}`);
	}

	try {
		const webResult = await searchWithGeminiWeb(query, options);
		if (webResult) return webResult;
	} catch (err) {
		if (isAbortError(err)) throw err;
		errors.push(`Gemini Web: ${errorMessage(err)}`);
	}

	if (strictErrors && errors.length > 0) {
		throw new Error(`Gemini search failed:\n  - ${errors.join("\n  - ")}`);
	}

	return null;
}

export async function search(query: string, options: FullSearchOptions = {}): Promise<AttributedSearchResponse> {
	const config = getSearchConfig();
	const provider = options.provider ?? config.searchProvider;

	if (provider === "perplexity") {
		const result = await searchWithPerplexity(query, options);
		return { ...result, provider: "perplexity" };
	}

	if (provider === "gemini") {
		const result = await searchWithGemini(query, options, true);
		if (result) return { ...result, provider: "gemini" };
		throw new Error(
			"Gemini search unavailable. Either:\n" +
			"  1. Set GEMINI_API_KEY in ~/.pi/web-search.json\n" +
			"  2. Sign into gemini.google.com in a supported Chromium-based browser"
		);
	}

	if (provider === "exa") {
		const exaApiKeyConfigured = hasExaApiKey();
		try {
			const result = await searchWithExa(query, options);
			if (result && "exhausted" in result) {
				throw new Error(
					"Exa monthly free tier exhausted (1,000 requests). Resets next month.\n" +
					"  Use provider: 'perplexity' or 'gemini', or upgrade at exa.ai/pricing"
				);
			}
			if (result && "answer" in result) return { ...result, provider: "exa" };
			if (exaApiKeyConfigured) {
				throw new Error("Exa search returned no results.");
			}
		} catch (err) {
			const message = err instanceof Error ? err.message : String(err);
			if (message.toLowerCase().includes("abort")) throw err;
			if (exaApiKeyConfigured) throw err;
			// No API key: allow provider fallback.
		}
	}

	const fallbackErrors: string[] = [];

	let effectiveIntent: "reference" | "fresh" | null = null;
	let chain: ResolvedSearchProvider[];
	if (provider === "auto") {
		effectiveIntent = options.searchIntent === "reference" || options.searchIntent === "fresh"
			? options.searchIntent
			: classifyAutoSearchIntent(query);
		chain = buildAutoChain(getAutoProviderOrder(effectiveIntent));
	} else {
		// Explicit `provider: "exa"` fell through (no API key, no result). Use the
		// historical fallback order but exclude Exa since it was already attempted.
		chain = buildAutoChain(["perplexity", "gemini"]);
	}

	const attribution = (p: ResolvedSearchProvider): Partial<AttributedSearchResponse> =>
		provider === "auto" && effectiveIntent
			? { provider: p, resolvedSearchIntent: effectiveIntent, autoProviderOrder: chain }
			: { provider: p };

	for (const p of chain) {
		try {
			if (p === "exa") {
				const result = await searchWithExa(query, options);
				if (result && "exhausted" in result) continue; // treat as fallthrough in auto
				if (result && "answer" in result) return { ...result, ...attribution("exa") } as AttributedSearchResponse;
				continue;
			}
			if (p === "perplexity") {
				const result = await searchWithPerplexity(query, options);
				return { ...result, ...attribution("perplexity") } as AttributedSearchResponse;
			}
			const geminiResult = await searchWithGemini(query, options, false);
			if (geminiResult) return { ...geminiResult, ...attribution("gemini") } as AttributedSearchResponse;
		} catch (err) {
			if (isAbortError(err)) throw err;
			fallbackErrors.push(`${providerLabel(p)}: ${errorMessage(err)}`);
		}
	}

	if (fallbackErrors.length > 0) {
		throw new Error(`Auto provider search failed:\n  - ${fallbackErrors.join("\n  - ")}`);
	}

	throw new Error(
		"No search provider available. Either:\n" +
		"  1. Set perplexityApiKey in ~/.pi/web-search.json\n" +
		"  2. Set EXA_API_KEY (or exaApiKey) in ~/.pi/web-search.json\n" +
		"  3. Set GEMINI_API_KEY in ~/.pi/web-search.json\n" +
		"  4. Sign into gemini.google.com in a supported Chromium-based browser"
	);
}

async function searchWithGeminiApi(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const config = getGeminiApiConfig();
	if (!config.geminiApiKey) return null;

	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const model = getSearchConfig().searchModel ?? config.geminiApiModel;
		if (supportsGoogleSearchTool(config)) {
			const result = await generateWithTools<GeminiSearchResponse>(
				query,
				[{ google_search: {} }],
				{ model, signal: options.signal, timeoutMs: 60000 },
			);
			activityMonitor.logComplete(activityId, result.status);

			const metadata = result.raw.candidates?.[0]?.groundingMetadata;
			const results = await resolveGroundingChunks(metadata?.groundingChunks, options.signal);
			if (!result.text && results.length === 0) return null;
			return { answer: result.text, results };
		}

		const result = await generateText(buildSearchPrompt(query, options), {
			model,
			signal: options.signal,
			timeoutMs: 60000,
		});
		activityMonitor.logComplete(activityId, result.status);

		const answer = result.text.trim();
		const results = extractSourceUrls(answer);
		if (!answer && results.length === 0) return null;
		const compatibilityNote =
			"_Native Gemini search tooling was unavailable for the configured provider; this answer used prompt-only mode, so citation quality may be reduced._";
		return { answer: `${answer}\n\n${compatibilityNote}`, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

async function searchWithGeminiWeb(query: string, options: SearchOptions = {}): Promise<SearchResponse | null> {
	const cookies = await isGeminiWebAvailable();
	if (!cookies) return null;

	const prompt = buildSearchPrompt(query, options);
	const activityId = activityMonitor.logStart({ type: "api", query });

	try {
		const text = await queryWithCookies(prompt, cookies, {
			model: "gemini-3-flash-preview",
			signal: options.signal,
			timeoutMs: 60000,
		});

		activityMonitor.logComplete(activityId, 200);

		const results = extractSourceUrls(text);
		return { answer: text, results };
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}
}

function buildSearchPrompt(query: string, options: SearchOptions): string {
	let prompt = `Search the web and answer the following question. Include source URLs for your claims.\nFormat your response as:\n1. A direct answer to the question\n2. Cited sources as markdown links\n\nQuestion: ${query}`;

	if (options.recencyFilter) {
		const labels: Record<string, string> = {
			day: "past 24 hours",
			week: "past week",
			month: "past month",
			year: "past year",
		};
		prompt += `\n\nOnly include results from the ${labels[options.recencyFilter]}.`;
	}

	if (options.domainFilter?.length) {
		const includes = options.domainFilter.filter(d => !d.startsWith("-"));
		const excludes = options.domainFilter.filter(d => d.startsWith("-")).map(d => d.slice(1));
		if (includes.length) prompt += `\n\nOnly cite sources from: ${includes.join(", ")}`;
		if (excludes.length) prompt += `\n\nDo not cite sources from: ${excludes.join(", ")}`;
	}

	return prompt;
}

function extractSourceUrls(markdown: string): SearchResult[] {
	const results: SearchResult[] = [];
	const seen = new Set<string>();
	const linkRegex = /\[([^\]]+)\]\((https?:\/\/[^)]+)\)/g;
	for (const match of markdown.matchAll(linkRegex)) {
		const url = match[2];
		if (seen.has(url)) continue;
		seen.add(url);
		results.push({ title: match[1], url, snippet: "" });
	}
	return results;
}

async function resolveGroundingChunks(
	chunks: GroundingChunk[] | undefined,
	signal?: AbortSignal,
): Promise<SearchResult[]> {
	if (!chunks?.length) return [];

	const results: SearchResult[] = [];
	for (const chunk of chunks) {
		if (!chunk.web) continue;
		const title = chunk.web.title || "";
		let url = chunk.web.uri || "";

		if (url.includes("vertexaisearch.cloud.google.com/grounding-api-redirect")) {
			const resolved = await resolveRedirect(url, signal);
			if (resolved) url = resolved;
		}

		if (url) results.push({ title, url, snippet: "" });
	}
	return results;
}

async function resolveRedirect(proxyUrl: string, signal?: AbortSignal): Promise<string | null> {
	try {
		const res = await fetch(proxyUrl, {
			method: "HEAD",
			redirect: "manual",
			signal: AbortSignal.any([
				AbortSignal.timeout(5000),
				...(signal ? [signal] : []),
			]),
		});
		return res.headers.get("location") || null;
	} catch {
		return null;
	}
}

interface GeminiSearchResponse {
	candidates?: Array<{
		content?: { parts?: Array<{ text?: string }> };
		groundingMetadata?: {
			webSearchQueries?: string[];
			groundingChunks?: GroundingChunk[];
			groundingSupports?: Array<{
				segment?: { startIndex?: number; endIndex?: number; text?: string };
				groundingChunkIndices?: number[];
			}>;
		};
	}>;
}

interface GroundingChunk {
	web?: { uri?: string; title?: string };
}

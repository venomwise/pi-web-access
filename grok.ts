import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { activityMonitor } from "./activity.js";
import { extractSourceUrls } from "./gemini-search.js";
import type { SearchOptions, SearchResponse, SearchResult } from "./perplexity.js";

export const DEFAULT_GROK_MODEL = "grok-3-mini";
export const DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1";
export const DEFAULT_MAX_SEARCH_RESULTS = 15;

const GROK_SYSTEM_PROMPT =
	"You are a real-time web research assistant. Use live web search/browsing when answering. Return ONLY a single JSON object with keys: content (string), sources (array of objects with url/title/snippet when possible). Keep content concise and evidence-backed.";

const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");

interface WebSearchConfig {
	grokApiKey?: unknown;
	grokApiModel?: unknown;
	grokApiBaseUrl?: unknown;
}

type GrokSourceType = "web" | "news" | "x";

interface GrokWebSource {
	type: "web";
	allowed_websites?: string[];
	excluded_websites?: string[];
}

interface GrokNewsSource {
	type: "news";
}

type GrokSource = GrokWebSource | GrokNewsSource | { type: GrokSourceType };

interface GrokSearchParameters {
	mode: "on";
	return_citations: true;
	max_search_results: number;
	from_date?: string;
	sources: GrokSource[];
}

interface GrokChoiceMessage {
	content?: string;
}

interface GrokChoice {
	message?: GrokChoiceMessage;
}

interface GrokResponse {
	choices?: GrokChoice[];
	citations?: unknown;
}

interface ParsedGrokContent {
	content?: unknown;
	sources?: unknown;
}

let cachedConfig: WebSearchConfig | null = null;

function loadConfig(): WebSearchConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const content = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(content) as WebSearchConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeString(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function getApiKey(): string {
	const config = loadConfig();
	const key =
		normalizeApiKey(process.env.XAI_API_KEY) ??
		normalizeApiKey(process.env.GROK_API_KEY) ??
		normalizeApiKey(config.grokApiKey);
	if (!key) {
		throw new Error(
			"Grok API key not found. Either:\n" +
			`  1. Create ${CONFIG_PATH} with { "grokApiKey": "xai-..." }\n` +
			"  2. Set XAI_API_KEY environment variable\n" +
			"  3. Set GROK_API_KEY environment variable\n" +
			"Get a key at https://console.x.ai/",
		);
	}
	return key;
}

export function hasGrokApiKey(): boolean {
	const config = loadConfig();
	return !!(
		normalizeApiKey(process.env.XAI_API_KEY) ??
		normalizeApiKey(process.env.GROK_API_KEY) ??
		normalizeApiKey(config.grokApiKey)
	);
}

export function isGrokAvailable(): boolean {
	try {
		return hasGrokApiKey();
	} catch {
		return false;
	}
}

function mapRecencyToFromDate(recency: string | undefined): string | undefined {
	if (!recency) return undefined;
	const daysByRecency: Record<string, number> = {
		day: 1,
		week: 7,
		month: 30,
		year: 365,
	};
	const days = daysByRecency[recency];
	if (!days) return undefined;
	const from = new Date();
	from.setUTCDate(from.getUTCDate() - days);
	const year = from.getUTCFullYear();
	const month = String(from.getUTCMonth() + 1).padStart(2, "0");
	const day = String(from.getUTCDate()).padStart(2, "0");
	return `${year}-${month}-${day}`;
}

function isValidDomain(domain: string): boolean {
	return /^[a-zA-Z0-9][a-zA-Z0-9-_.]*\.[a-zA-Z]{2,}$/.test(domain);
}

function splitDomainFilter(domains: string[] | undefined): { allowed: string[]; excluded: string[] } {
	const allowed: string[] = [];
	const excluded: string[] = [];
	if (!domains || domains.length === 0) return { allowed, excluded };
	for (const raw of domains) {
		if (typeof raw !== "string") continue;
		const trimmed = raw.trim();
		if (trimmed.length === 0) continue;
		const isExclude = trimmed.startsWith("-");
		const domain = isExclude ? trimmed.slice(1) : trimmed;
		if (!isValidDomain(domain)) continue;
		if (isExclude) {
			excluded.push(domain);
		} else {
			allowed.push(domain);
		}
	}
	return { allowed, excluded };
}

function buildSearchParameters(options: SearchOptions): GrokSearchParameters {
	const webSource: GrokWebSource = { type: "web" };
	const { allowed, excluded } = splitDomainFilter(options.domainFilter);
	if (allowed.length > 0) webSource.allowed_websites = allowed;
	if (excluded.length > 0) webSource.excluded_websites = excluded;

	const params: GrokSearchParameters = {
		mode: "on",
		return_citations: true,
		max_search_results: options.numResults ?? DEFAULT_MAX_SEARCH_RESULTS,
		sources: [webSource, { type: "news" }],
	};

	const fromDate = mapRecencyToFromDate(options.recencyFilter);
	if (fromDate) params.from_date = fromDate;

	return params;
}

function tryParseJson(raw: string): ParsedGrokContent | null {
	if (!raw) return null;
	try {
		const parsed = JSON.parse(raw);
		if (parsed && typeof parsed === "object" && !Array.isArray(parsed)) {
			return parsed as ParsedGrokContent;
		}
		return null;
	} catch {
		return null;
	}
}

function buildResultsFromCitations(citations: unknown[]): SearchResult[] {
	const results: SearchResult[] = [];
	for (let i = 0; i < citations.length; i++) {
		const entry = citations[i];
		if (typeof entry === "string" && entry.trim().length > 0) {
			results.push({ title: `Source ${i + 1}`, url: entry, snippet: "" });
		} else if (entry && typeof entry === "object") {
			const obj = entry as { url?: unknown; title?: unknown; snippet?: unknown };
			const url = normalizeString(obj.url);
			if (!url) continue;
			results.push({
				title: normalizeString(obj.title) ?? `Source ${i + 1}`,
				url,
				snippet: typeof obj.snippet === "string" ? obj.snippet : "",
			});
		}
	}
	return results;
}

function buildResultsFromParsedSources(sources: unknown): SearchResult[] {
	if (!Array.isArray(sources)) return [];
	const results: SearchResult[] = [];
	for (let i = 0; i < sources.length; i++) {
		const entry = sources[i];
		if (!entry || typeof entry !== "object") continue;
		const obj = entry as { url?: unknown; title?: unknown; snippet?: unknown };
		const url = normalizeString(obj.url);
		if (!url) continue;
		results.push({
			title: normalizeString(obj.title) ?? `Source ${i + 1}`,
			url,
			snippet: typeof obj.snippet === "string" ? obj.snippet : "",
		});
	}
	return results;
}

export async function searchWithGrok(query: string, options: SearchOptions = {}): Promise<SearchResponse> {
	const activityId = activityMonitor.logStart({ type: "api", query });

	const apiKey = getApiKey();
	const config = loadConfig();
	const model = normalizeString(config.grokApiModel) ?? DEFAULT_GROK_MODEL;
	const baseUrl = normalizeString(config.grokApiBaseUrl) ?? DEFAULT_GROK_BASE_URL;
	const normalizedBase = baseUrl.replace(/\/+$/, "");

	const requestBody = {
		model,
		messages: [
			{ role: "system", content: GROK_SYSTEM_PROMPT },
			{ role: "user", content: query },
		],
		search_parameters: buildSearchParameters(options),
		max_tokens: 1024,
	};

	let response: Response;
	try {
		response = await fetch(`${normalizedBase}/chat/completions`, {
			method: "POST",
			headers: {
				Authorization: `Bearer ${apiKey}`,
				"Content-Type": "application/json",
			},
			body: JSON.stringify(requestBody),
			signal: options.signal,
		});
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		if (message.toLowerCase().includes("abort")) {
			activityMonitor.logComplete(activityId, 0);
		} else {
			activityMonitor.logError(activityId, message);
		}
		throw err;
	}

	if (!response.ok) {
		const errorText = await response.text();
		activityMonitor.logComplete(activityId, response.status);
		throw new Error(`Grok API error ${response.status}: ${errorText}`);
	}

	let data: GrokResponse;
	try {
		data = (await response.json()) as GrokResponse;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		activityMonitor.logError(activityId, message);
		throw new Error(`Grok API returned invalid JSON: ${message}`);
	}

	const raw = data.choices?.[0]?.message?.content ?? "";
	const parsed = tryParseJson(raw);

	let answer: string;
	if (parsed && typeof parsed.content === "string") {
		answer = parsed.content;
	} else {
		answer = raw;
	}

	const citations = Array.isArray(data.citations) ? data.citations : [];
	let results: SearchResult[] = [];
	if (citations.length > 0) {
		results = buildResultsFromCitations(citations);
	} else if (parsed) {
		results = buildResultsFromParsedSources(parsed.sources);
	}
	if (results.length === 0) {
		results = extractSourceUrls(raw);
	}

	const limit = options.numResults ?? 5;
	if (results.length > limit) {
		results = results.slice(0, limit);
	}

	activityMonitor.logComplete(activityId, response.status);

	if (!raw && citations.length === 0 && results.length === 0) {
		return { answer: "", results: [] };
	}

	return { answer, results };
}

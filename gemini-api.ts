import { existsSync, readFileSync } from "node:fs";
import { homedir } from "node:os";
import { join } from "node:path";
import { assertGeminiCapability, type GeminiProviderCapability } from "./gemini-capabilities.js";

export type GeminiApiProtocol = "gemini" | "openai";

export const API_BASE = "https://generativelanguage.googleapis.com/v1beta";
export const DEFAULT_GEMINI_API_BASE_URL = API_BASE;
export const DEFAULT_GEMINI_API_PROTOCOL: GeminiApiProtocol = "gemini";
const CONFIG_PATH = join(homedir(), ".pi", "web-search.json");
export const DEFAULT_MODEL = "gemini-3-flash-preview";
export const DEFAULT_GEMINI_API_MODEL = DEFAULT_MODEL;
export const DEFAULT_GEMINI_API_PATHS: Record<GeminiApiProtocol, string> = {
	gemini: "/models/{model}:generateContent",
	openai: "/chat/completions",
};

interface GeminiApiConfig {
	geminiApiKey?: unknown;
	geminiApiBaseUrl?: unknown;
	geminiApiProtocol?: unknown;
	geminiApiModel?: unknown;
	geminiApiPath?: unknown;
}

export interface GeminiApiTransportConfig {
	geminiApiKey: string | null;
	geminiApiBaseUrl: string;
	geminiApiProtocol: GeminiApiProtocol;
	geminiApiModel: string;
	geminiApiPath: string;
}

let cachedConfig: GeminiApiConfig | null = null;

function loadConfig(): GeminiApiConfig {
	if (cachedConfig) return cachedConfig;
	if (!existsSync(CONFIG_PATH)) {
		cachedConfig = {};
		return cachedConfig;
	}

	const raw = readFileSync(CONFIG_PATH, "utf-8");
	try {
		cachedConfig = JSON.parse(raw) as GeminiApiConfig;
		return cachedConfig;
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Failed to parse ${CONFIG_PATH}: ${message}`);
	}
}

function withTimeout(signal: AbortSignal | undefined, timeoutMs: number): AbortSignal {
	const timeout = AbortSignal.timeout(timeoutMs);
	return signal ? AbortSignal.any([signal, timeout]) : timeout;
}

function normalizeApiKey(value: unknown): string | null {
	if (typeof value !== "string") return null;
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeNonEmptyString(value: unknown, field: string): string | null {
	if (value === undefined || value === null) return null;
	if (typeof value !== "string") {
		throw new Error(`Invalid ${field}: expected a string`);
	}
	const normalized = value.trim();
	return normalized.length > 0 ? normalized : null;
}

function normalizeProtocol(value: unknown): GeminiApiProtocol {
	const normalized = normalizeNonEmptyString(value, "geminiApiProtocol");
	if (!normalized) return DEFAULT_GEMINI_API_PROTOCOL;
	if (normalized === "gemini" || normalized === "openai") return normalized;
	throw new Error(`Invalid geminiApiProtocol: expected "gemini" or "openai", got "${normalized}"`);
}

function normalizeBaseUrl(value: unknown): string {
	const normalized = normalizeNonEmptyString(value, "geminiApiBaseUrl") ?? DEFAULT_GEMINI_API_BASE_URL;
	let parsed: URL;
	try {
		parsed = new URL(normalized);
	} catch {
		throw new Error(`Invalid geminiApiBaseUrl: expected an absolute URL, got "${normalized}"`);
	}
	if (parsed.protocol !== "https:" && parsed.protocol !== "http:") {
		throw new Error(`Invalid geminiApiBaseUrl: expected http or https URL, got "${normalized}"`);
	}
	if (parsed.search || parsed.hash) {
		throw new Error(`Invalid geminiApiBaseUrl: expected a URL without query or hash, got "${normalized}"`);
	}
	return parsed.toString().replace(/\/+$/, "");
}

function normalizePath(value: unknown, protocol: GeminiApiProtocol): string {
	const normalized = normalizeNonEmptyString(value, "geminiApiPath") ?? DEFAULT_GEMINI_API_PATHS[protocol];
	if (!normalized.startsWith("/")) {
		throw new Error(`Invalid geminiApiPath: expected a path starting with "/", got "${normalized}"`);
	}
	try {
		const parsed = new URL(normalized, "https://example.invalid");
		if (parsed.origin !== "https://example.invalid" || parsed.search || parsed.hash) {
			throw new Error("invalid path");
		}
	} catch {
		throw new Error(`Invalid geminiApiPath: expected a URL path without query or hash, got "${normalized}"`);
	}
	return normalized.replace(/\/{2,}/g, "/");
}

function normalizeModel(value: unknown): string {
	return normalizeNonEmptyString(value, "geminiApiModel") ?? DEFAULT_GEMINI_API_MODEL;
}

export function getGeminiApiConfig(): GeminiApiTransportConfig {
	const config = loadConfig();
	const protocol = normalizeProtocol(config.geminiApiProtocol);
	return {
		geminiApiKey: normalizeApiKey(process.env.GEMINI_API_KEY) ?? normalizeApiKey(config.geminiApiKey),
		geminiApiBaseUrl: normalizeBaseUrl(config.geminiApiBaseUrl),
		geminiApiProtocol: protocol,
		geminiApiModel: normalizeModel(config.geminiApiModel),
		geminiApiPath: normalizePath(config.geminiApiPath, protocol),
	};
}

export function getApiKey(): string | null {
	return getGeminiApiConfig().geminiApiKey;
}

export function isGeminiApiAvailable(): boolean {
	return getApiKey() !== null;
}

export interface GeminiApiOptions {
	model?: string;
	signal?: AbortSignal;
	timeoutMs?: number;
}

export interface GeminiApiMediaInput {
	fileUri: string;
	mimeType?: string;
}

export type GeminiApiTool = Record<string, Record<string, unknown>>;

export interface GeminiApiGenerateResult<T = unknown> {
	text: string;
	raw: T;
	status: number;
	model: string;
	protocol: GeminiApiProtocol;
}

interface GeminiGenerateContentOptions extends GeminiApiOptions {
	media?: GeminiApiMediaInput[];
	tools?: GeminiApiTool[];
}

interface GeminiRequestContext {
	config: GeminiApiTransportConfig;
	apiKey: string;
	model: string;
	signal: AbortSignal;
}

function createRequestContext(options: GeminiApiOptions): GeminiRequestContext {
	const config = getGeminiApiConfig();
	if (!config.geminiApiKey) throw new Error("GEMINI_API_KEY not configured");
	return {
		config,
		apiKey: config.geminiApiKey,
		model: options.model ?? config.geminiApiModel,
		signal: withTimeout(options.signal, options.timeoutMs ?? 60000),
	};
}

function buildUrl(baseUrl: string, path: string): URL {
	const url = new URL(baseUrl);
	const basePath = url.pathname.replace(/\/+$/, "");
	const relativePath = path.startsWith("/") ? path : `/${path}`;
	url.pathname = `${basePath}${relativePath}`.replace(/\/{2,}/g, "/");
	url.search = "";
	url.hash = "";
	return url;
}

export function buildGeminiApiUrl(path: string, apiKey?: string): URL {
	const config = getGeminiApiConfig();
	const url = buildUrl(config.geminiApiBaseUrl, path);
	if (apiKey) url.searchParams.set("key", apiKey);
	return url;
}

export function buildGeminiFilesUploadUrl(): URL {
	const config = getGeminiApiConfig();
	const url = new URL(config.geminiApiBaseUrl);
	const basePath = url.pathname.replace(/\/+$/, "");
	url.pathname = `/upload${basePath}/files`.replace(/\/{2,}/g, "/");
	url.search = "";
	url.hash = "";
	return url;
}

function buildGenerateUrl(config: GeminiApiTransportConfig, model: string, apiKey: string): URL {
	const path = config.geminiApiPath.replace("{model}", encodeURIComponent(model));
	const url = buildUrl(config.geminiApiBaseUrl, path);
	if (config.geminiApiProtocol === "gemini") {
		url.searchParams.set("key", apiKey);
	}
	return url;
}

function summarizeHttpBody(text: string): string {
	return text.replace(/\s+/g, " ").trim().slice(0, 300);
}

async function parseJsonResponse(res: Response, protocol: GeminiApiProtocol): Promise<unknown> {
	if (!res.ok) {
		const errorText = await res.text();
		const details = summarizeHttpBody(errorText);
		throw new Error(`Gemini API ${protocol} HTTP ${res.status}: ${details}`);
	}
	try {
		return await res.json();
	} catch (err) {
		const message = err instanceof Error ? err.message : String(err);
		throw new Error(`Gemini API ${protocol} response parse error: ${message}`);
	}
}

function extractGeminiText(data: unknown): string {
	if (!data || typeof data !== "object") {
		throw new Error("Gemini API protocol mismatch: gemini response was not an object");
	}
	if ("choices" in data && !("candidates" in data)) {
		throw new Error("Gemini API protocol mismatch: configured gemini protocol but response looked like chat/completions");
	}
	const response = data as GenerateContentResponse;
	return response.candidates?.[0]?.content?.parts
		?.map((p) => p.text)
		.filter(Boolean)
		.join("\n") ?? "";
}

function extractOpenAiText(data: unknown): string {
	if (!data || typeof data !== "object") {
		throw new Error("Gemini API protocol mismatch: openai response was not an object");
	}
	if ("candidates" in data && !("choices" in data)) {
		throw new Error("Gemini API protocol mismatch: configured openai protocol but response looked like generateContent");
	}
	const response = data as OpenAiChatCompletionResponse;
	const choice = response.choices?.[0];
	const content = choice?.message?.content;
	if (typeof content === "string") return content;
	if (Array.isArray(content)) {
		return content
			.map((part) => typeof part.text === "string" ? part.text : "")
			.filter(Boolean)
			.join("\n");
	}
	if (typeof choice?.text === "string") return choice.text;
	throw new Error("Gemini API protocol mismatch: openai response did not include choices[0].message.content");
}

function buildGeminiBody(prompt: string, options: GeminiGenerateContentOptions): Record<string, unknown> {
	const parts: Array<Record<string, unknown>> = [];
	for (const media of options.media ?? []) {
		const fileData: Record<string, string> = { fileUri: media.fileUri };
		if (media.mimeType) fileData.mimeType = media.mimeType;
		parts.push({ fileData });
	}
	parts.push({ text: prompt });

	const body: Record<string, unknown> = {
		contents: [{ parts }],
	};
	if (options.tools?.length) body.tools = options.tools;
	return body;
}

function getToolNames(tools: GeminiApiTool[] | undefined): string[] {
	return tools?.flatMap((tool) => Object.keys(tool)) ?? [];
}

function capabilityForTool(toolName: string): GeminiProviderCapability | null {
	if (toolName === "google_search") return "google_search";
	if (toolName === "url_context") return "url_context";
	return null;
}

function assertGenerateCapabilities(
	config: GeminiApiTransportConfig,
	options: GeminiGenerateContentOptions,
): void {
	if (options.media?.length) {
		assertGeminiCapability(config, "file_uri_media");
	}
	for (const toolName of getToolNames(options.tools)) {
		const capability = capabilityForTool(toolName);
		if (capability) assertGeminiCapability(config, capability);
	}
}

function buildOpenAiBody(prompt: string, model: string, options: GeminiGenerateContentOptions): Record<string, unknown> {
	const toolNames = getToolNames(options.tools);
	if (toolNames.length) {
		throw new Error(`Gemini API provider using openai protocol does not support Gemini tools: ${toolNames.join(", ")}`);
	}
	if (options.media?.length) {
		assertGeminiCapability("openai", "file_uri_media");
	}
	return {
		model,
		messages: [{ role: "user", content: prompt }],
	};
}

async function generateContent<T = unknown>(
	prompt: string,
	options: GeminiGenerateContentOptions = {},
): Promise<GeminiApiGenerateResult<T>> {
	const ctx = createRequestContext(options);
	assertGenerateCapabilities(ctx.config, options);
	const url = buildGenerateUrl(ctx.config, ctx.model, ctx.apiKey);
	const body = ctx.config.geminiApiProtocol === "gemini"
		? buildGeminiBody(prompt, options)
		: buildOpenAiBody(prompt, ctx.model, options);
	const headers: Record<string, string> = { "Content-Type": "application/json" };
	if (ctx.config.geminiApiProtocol === "openai") {
		headers.Authorization = `Bearer ${ctx.apiKey}`;
	}

	const res = await fetch(url, {
		method: "POST",
		headers,
		body: JSON.stringify(body),
		signal: ctx.signal,
	});

	const raw = await parseJsonResponse(res, ctx.config.geminiApiProtocol) as T;
	const text = ctx.config.geminiApiProtocol === "gemini"
		? extractGeminiText(raw)
		: extractOpenAiText(raw);

	return {
		text,
		raw,
		status: res.status,
		model: ctx.model,
		protocol: ctx.config.geminiApiProtocol,
	};
}

export function generateText<T = unknown>(
	prompt: string,
	options: GeminiApiOptions = {},
): Promise<GeminiApiGenerateResult<T>> {
	return generateContent<T>(prompt, options);
}

export function generateWithTools<T = unknown>(
	prompt: string,
	tools: GeminiApiTool[],
	options: GeminiApiOptions = {},
): Promise<GeminiApiGenerateResult<T>> {
	return generateContent<T>(prompt, { ...options, tools });
}

export function generateWithMedia<T = unknown>(
	prompt: string,
	media: GeminiApiMediaInput[],
	options: GeminiApiOptions = {},
): Promise<GeminiApiGenerateResult<T>> {
	return generateContent<T>(prompt, { ...options, media, timeoutMs: options.timeoutMs ?? 120000 });
}

export interface GeminiApiVideoOptions extends GeminiApiOptions {
	mimeType?: string;
}

export async function queryGeminiApiWithVideo(
	prompt: string,
	videoUri: string,
	options: GeminiApiVideoOptions = {},
): Promise<string> {
	const { text } = await generateWithMedia(prompt, [{ fileUri: videoUri, mimeType: options.mimeType }], options);
	if (!text) throw new Error("Gemini API returned empty response");
	return text;
}

interface GenerateContentResponse {
	candidates?: Array<{
		content?: {
			parts?: Array<{ text?: string }>;
		};
	}>;
}

interface OpenAiChatCompletionResponse {
	choices?: Array<{
		message?: {
			content?: string | Array<{ type?: string; text?: string }>;
		};
		text?: string;
	}>;
}

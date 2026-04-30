import type { GeminiApiProtocol } from "./gemini-api.js";

export type GeminiProviderCapability =
	| "google_search"
	| "url_context"
	| "file_uri_media"
	| "files_api"
	| "openai_chat_content_parts";

export type GeminiProviderCapabilities = Readonly<Record<GeminiProviderCapability, boolean>>;

export class ProviderCapabilityError extends Error {
	readonly protocol: GeminiApiProtocol;
	readonly capability: GeminiProviderCapability;

	constructor(protocol: GeminiApiProtocol, capability: GeminiProviderCapability, message?: string) {
		super(message ?? `Configured Gemini API provider using ${protocol} protocol does not support ${capability}`);
		this.name = "ProviderCapabilityError";
		this.protocol = protocol;
		this.capability = capability;
	}
}

const CAPABILITIES: Record<GeminiApiProtocol, GeminiProviderCapabilities> = {
	gemini: {
		google_search: true,
		url_context: true,
		file_uri_media: true,
		files_api: true,
		openai_chat_content_parts: false,
	},
	openai: {
		google_search: false,
		url_context: false,
		file_uri_media: false,
		files_api: false,
		openai_chat_content_parts: true,
	},
};

function protocolOf(input: GeminiApiProtocol | { geminiApiProtocol: GeminiApiProtocol }): GeminiApiProtocol {
	return typeof input === "string" ? input : input.geminiApiProtocol;
}

export function getGeminiProviderCapabilities(
	input: GeminiApiProtocol | { geminiApiProtocol: GeminiApiProtocol },
): GeminiProviderCapabilities {
	return CAPABILITIES[protocolOf(input)];
}

export function supportsGeminiCapability(
	input: GeminiApiProtocol | { geminiApiProtocol: GeminiApiProtocol },
	capability: GeminiProviderCapability,
): boolean {
	return getGeminiProviderCapabilities(input)[capability];
}

export function assertGeminiCapability(
	input: GeminiApiProtocol | { geminiApiProtocol: GeminiApiProtocol },
	capability: GeminiProviderCapability,
): void {
	const protocol = protocolOf(input);
	if (!supportsGeminiCapability(protocol, capability)) {
		throw new ProviderCapabilityError(protocol, capability);
	}
}

export function supportsGoogleSearchTool(input: GeminiApiProtocol | { geminiApiProtocol: GeminiApiProtocol }): boolean {
	return supportsGeminiCapability(input, "google_search");
}

export function supportsUrlContextTool(input: GeminiApiProtocol | { geminiApiProtocol: GeminiApiProtocol }): boolean {
	return supportsGeminiCapability(input, "url_context");
}

export function supportsFileUriMedia(input: GeminiApiProtocol | { geminiApiProtocol: GeminiApiProtocol }): boolean {
	return supportsGeminiCapability(input, "file_uri_media");
}

export function supportsFilesApi(input: GeminiApiProtocol | { geminiApiProtocol: GeminiApiProtocol }): boolean {
	return supportsGeminiCapability(input, "files_api");
}

export function isProviderCapabilityError(err: unknown): err is ProviderCapabilityError {
	return err instanceof ProviderCapabilityError;
}

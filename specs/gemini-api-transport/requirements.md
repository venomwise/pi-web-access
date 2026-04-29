# Requirements Document: Gemini API Transport

## Introduction

Gemini API Transport 为 `pi-web-access` 中所有基于 Gemini API 的能力提供统一的配置与请求适配层。它允许用户通过单一全局配置指定 API key、自定义 `base URL`、默认模型与请求协议，并将这些设置统一应用到现有的 `web_search`、URL 分析、视频分析与文件分析路径。该模块需要兼容 Google 官方 Gemini `generateContent` 协议，同时支持 `OpenAI` 兼容 `chat/completions` 协议，以便对接第三方 provider。

本设计的边界仅限于当前的 `gemini-api` 路径，不包括 `gemini-web` 的 cookie 认证与网页私有端点模拟，也不试图把整个仓库重构为通用多 provider 框架。系统必须在第三方 provider 不支持 Gemini 专属能力时提供显式降级或清晰错误，并保持现有 fallback 链可以继续工作。

## Glossary

- **Gemini API**: Google 官方 `generateContent` 风格接口及其数据模型。
- **OpenAI protocol**: 指 `chat/completions` 风格的请求与响应格式，用于兼容第三方 provider。
- **Transport**: 负责读取配置、构造 HTTP 请求、解析响应和暴露统一调用接口的适配层。
- **Capability**: 某个 provider 或协议是否支持特定功能的声明，例如 `google_search`、`url_context` 或多模态输入。
- **Fallback**: 当首选能力失败或不兼容时，系统继续尝试其他现有路径的机制。
- **ProviderCapabilityError**: 用于表示“当前 provider 不支持该能力”而非普通网络失败的错误类型。
- **Base URL**: API 请求的根地址，可为 Google 官方地址或第三方兼容服务地址。
- **Path override**: 对默认 API path 的高级覆盖配置，用于适配非标准兼容端路径。

## Requirements

### Requirement 1: Unified Gemini API Configuration

**User Story:** As a Pi 用户, I want a single global Gemini API configuration, so that all Gemini API-backed features use the same provider settings consistently.

#### Acceptance Criteria

1. WHEN the system loads `~/.pi/web-search.json`, THEN it SHALL read Gemini API transport settings from a single global configuration block or equivalent top-level fields without requiring per-feature provider settings.
2. WHEN `geminiApiBaseUrl`, `geminiApiProtocol`, `geminiApiModel`, or `geminiApiPath` are absent, THEN the system SHALL apply documented defaults that preserve current official Gemini behavior.
3. WHEN `GEMINI_API_KEY` is set in the environment, THEN the system SHALL continue to prioritize it over config-file API key values.
4. IF `geminiApiProtocol` is not one of the supported values, THEN the system SHALL reject the configuration with a descriptive error before issuing API requests.
5. IF the configured `geminiApiBaseUrl` or `geminiApiPath` is malformed, THEN the system SHALL return a descriptive configuration error identifying the invalid field.

### Requirement 2: Protocol-Aware Request Transport

**User Story:** As a maintainer, I want a protocol-aware transport layer, so that feature modules can request Gemini-powered behavior without embedding protocol details.

#### Acceptance Criteria

1. WHEN a Gemini API-backed feature issues a text generation request, THEN the system SHALL route the request through a shared transport interface instead of constructing raw protocol-specific HTTP requests in feature modules.
2. WHEN `geminiApiProtocol` is `gemini`, THEN the transport SHALL build requests compatible with the official `generateContent` endpoint and payload structure.
3. WHEN `geminiApiProtocol` is `openai`, THEN the transport SHALL build requests compatible with `chat/completions` style payloads and parse the corresponding response format.
4. WHEN a feature supplies an explicit model override, THEN the transport SHALL honor that override while using the shared base URL, protocol, and authentication settings.
5. IF an HTTP request fails, THEN the transport SHALL surface an error including the HTTP status and a truncated portion of the response body for diagnosis.

### Requirement 3: Capability Detection And Degradation

**User Story:** As a Pi 用户, I want unsupported provider capabilities to degrade predictably, so that switching to a third-party provider does not create silent behavioral regressions.

#### Acceptance Criteria

1. WHEN the active protocol does not support a Gemini-specific capability, THEN the system SHALL detect that mismatch before or during request construction and avoid sending an invalid protocol payload.
2. WHEN the system can safely degrade behavior, THEN it SHALL continue with the degraded path and provide an explicit indication that the result is from a reduced-capability mode.
3. WHEN the system cannot safely degrade behavior, THEN it SHALL raise `ProviderCapabilityError` or an equivalent descriptive error that identifies the unsupported capability.
4. WHEN the protocol is `openai`, THEN the system SHALL assume a conservative default capability set rather than inferring support for Gemini-specific tools automatically.
5. IF a future provider-specific enhancement is added, THEN the capability checks SHALL remain centralized rather than duplicated across feature modules.

### Requirement 4: Search Compatibility

**User Story:** As a user running `web_search`, I want Gemini-backed search to remain usable across provider protocols, so that changing the transport does not break the search workflow.

#### Acceptance Criteria

1. WHEN `web_search` uses the Gemini API path with `gemini` protocol, THEN the system SHALL preserve the current `google_search` tool-based behavior.
2. WHEN `web_search` uses the Gemini API path with a protocol or provider that does not support native search tooling, THEN the system SHALL fall back to a prompt-only answer path instead of failing silently.
3. WHEN search falls back to a prompt-only answer path, THEN the system SHALL include an explicit indication that native search tooling was unavailable and citation quality may be reduced.
4. IF the degraded search path still returns no usable answer and no sources, THEN the system SHALL allow existing provider fallback behavior to continue.
5. WHEN multiple search requests execute concurrently, THEN the transport changes SHALL not alter existing abort and timeout behavior for individual requests.

### Requirement 5: URL, File, And Video Analysis Compatibility

**User Story:** As a user analyzing URLs, files, or videos, I want Gemini API transport changes to preserve existing feature behavior where possible and fail clearly where not possible.

#### Acceptance Criteria

1. WHEN URL analysis runs with `gemini` protocol, THEN the system SHALL preserve the current `url_context` tool-based path.
2. WHEN URL analysis runs with a protocol that does not support `url_context`, THEN the Gemini API URL-context path SHALL return control to the existing extraction fallback chain instead of blocking the request.
3. WHEN file or video analysis runs with a provider that supports the required media input format, THEN the transport SHALL map the request into that protocol's compatible multi-modal structure.
4. WHEN file or video analysis runs with a provider that does not support the required media input format, THEN the system SHALL fail with a descriptive unsupported-capability error rather than pretending the analysis succeeded.
5. WHEN a Gemini API path fails for capability reasons, THEN the existing higher-level fallback order, including `gemini-web` where already present, SHALL remain intact.

### Requirement 6: Documentation And Operator Guidance

**User Story:** As a repository user, I want the new transport options documented clearly, so that I can configure custom providers without reading source code.

#### Acceptance Criteria

1. WHEN the feature is released, THEN `README.md` SHALL document the new Gemini API transport configuration fields, their defaults, and their scope.
2. WHEN `openai` protocol is documented, THEN the documentation SHALL explain that Gemini-specific capabilities may degrade or become unavailable depending on the provider.
3. WHEN `geminiApiPath` is documented, THEN it SHALL be described as an advanced override rather than the default configuration path for typical users.
4. WHEN the configuration examples are updated, THEN they SHALL show at least one official Gemini example and one third-party compatible example.

### Requirement 7: Error Resilience And Backward Compatibility

**User Story:** As an existing user of the package, I want the default Gemini behavior to remain stable and failures to be diagnosable, so that transport extensibility does not regress current workflows.

#### Acceptance Criteria

1. WHEN no new Gemini transport fields are configured, THEN the system SHALL behave the same as the current official Gemini API implementation by default.
2. WHEN a request is aborted or times out, THEN the system SHALL preserve existing abort and timeout semantics for search, extraction, and analysis flows.
3. WHEN the response payload from a third-party provider does not match the configured protocol, THEN the system SHALL return a descriptive parsing or protocol mismatch error.
4. WHEN a Gemini API-backed feature encounters a transport-level failure, THEN the system SHALL log or surface enough detail for debugging without exposing unrelated internal stack noise to end users.

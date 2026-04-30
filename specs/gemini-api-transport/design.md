# Gemini API Transport Design

## Summary

为当前项目中的 `gemini-api` 路径增加一层统一的 transport 配置与协议适配能力，使用户可以通过单一全局配置指定第三方 provider 的 `base URL`，并在 `gemini` 官方 `generateContent` 协议与 `OpenAI` 兼容 `chat/completions` 协议之间切换。该设计仅覆盖 Gemini API 路径，不修改 `gemini-web` cookie 模拟链路；目标是在 `search`、`video`、`file`、`url analysis` 等现有能力上尽量保持一致体验，并在第三方 provider 不支持某些 Gemini 专属能力时显式降级并提示。

## Goals

- 支持通过全局配置为 Gemini API 指定自定义 `base URL`。
- 支持在 `gemini` 与 `openai` 两种请求协议之间切换。
- 让当前所有走 Gemini API 的功能复用同一套 transport 配置。
- 保持现有 fallback 链路可用，不因第三方 provider 能力不足破坏整体工作流。
- 在能力不兼容时提供显式降级或明确错误，而不是静默失败。

## Primary Users / Roles

- 使用第三方 Gemini 兼容 provider 的 Pi 用户，希望把现有 Gemini API 能力接到自定义服务端。
- 使用官方 Gemini API 的现有用户，需要默认行为不回归。
- 维护该仓库的开发者，需要在不重构 `gemini-web` 的前提下扩展协议适配能力。

## Non-Goals

- 不覆盖 `gemini-web` 的 cookie 认证与网页私有协议。
- 不把整个仓库重构为通用多 LLM provider 框架。
- 不保证所有 `OpenAI` 兼容 provider 都能完全等价支持 Gemini 专属能力。
- 不按 `search`、`video`、`url analysis` 分别提供独立 provider 配置。

## Context

- 当前 [gemini-api.ts](/Users/venom/Workspace/AI/pi-web-access/gemini-api.ts:1) 将 `API_BASE` 固定为 Google 官方 `https://generativelanguage.googleapis.com/v1beta`，并直接构造 `generateContent` 请求。
- [gemini-search.ts](/Users/venom/Workspace/AI/pi-web-access/gemini-search.ts:1) 使用 Gemini API 的 `google_search` tool 进行搜索。
- [gemini-url-context.ts](/Users/venom/Workspace/AI/pi-web-access/gemini-url-context.ts:1) 使用 Gemini API 的 `url_context` tool 进行 URL 分析。
- `video` / `YouTube` 相关能力会复用 Gemini API 做多模态分析，但当前假设的是官方 Gemini 请求结构。
- [extract.ts](/Users/venom/Workspace/AI/pi-web-access/extract.ts:1) 已有完整 fallback 链，可以在 Gemini API 能力不足时继续尝试其他提取路径。
- `gemini-web` 与 `gemini-api` 在功能上存在部分重叠，但协议和认证模型完全不同，不适合合并抽象。

## Discovery (recommended for non-trivial or ambiguous requirements)

### Key Discoveries

- 用户明确要求只覆盖 `gemini-api` 路径，不覆盖 `gemini-web`。
- 用户明确选择单一全局配置，而不是按能力分别配置 provider。
- 用户接受在第三方 provider 不支持某项能力时显式降级并提示。
- 当前真正需要抽象的不是“模型名称”，而是“协议格式 + base URL + 能力差异”。
- `OpenAI` 兼容协议只能保证基本请求格式兼容，不能假设其支持 Gemini 的 `google_search`、`url_context`、Files API 等专属能力。

### Scope Decisions

- 纳入范围：Gemini API transport 配置、协议适配、能力探测、降级策略、错误提示、README 配置说明更新。
- 排除范围：`gemini-web` 适配、全局 provider 重构、每种能力独立配置、对任意第三方 provider 的完全等价支持承诺。
- 保留现有调用方的局部 `model` override 能力，但新增一个全局 Gemini API 默认模型配置。

## Proposed Solution

在 [gemini-api.ts](/Users/venom/Workspace/AI/pi-web-access/gemini-api.ts:1) 之上引入统一的 Gemini API transport 层，由该层负责读取配置、规范化协议、构造请求、解析响应、声明能力矩阵，并向上游暴露协议无关的调用接口。现有 `search`、`url analysis`、`video`、`file` 等功能不再直接拼接 Gemini 官方 URL 和请求体，而是统一表达为“文本生成”“带 media 的生成”“带 tool 的生成”等意图，由 transport 层负责映射到 `gemini` 或 `openai` 协议。

该方案与当前仓库结构最契合，因为它只扩大 `gemini-api` 的职责边界，不影响 `gemini-web` 独立 fallback 的存在，也不要求仓库整体重构成通用多 provider 框架。

### Architecture

核心结构分为四层：

1. Config 层
   - 读取 `~/.pi/web-search.json` 中的 Gemini API 相关字段。
   - 归一化 `apiKey`、`baseUrl`、`protocol`、`path`、`defaultModel`。

2. Capability 层
   - 为当前 protocol 声明支持能力，例如：
   - `supportsGoogleSearchTool`
   - `supportsUrlContextTool`
   - `supportsInlineMediaParts`
   - `supportsRemoteFileUri`
   - `supportsOpenAIChatContentParts`
   - 对 `openai` 协议默认采用保守能力集，避免错误假设。

3. Transport 层
   - 对上暴露协议无关接口：
   - `generateText()`
   - `generateWithMedia()`
   - `generateWithTooling()`
   - 对下根据 protocol 映射为具体 HTTP 请求与响应解析逻辑。

4. Feature 调用层
   - `gemini-search.ts`
   - `gemini-url-context.ts`
   - `video` / `youtube` 相关 Gemini API 调用路径
   - 这些模块通过 transport 访问 Gemini API，而不是持有协议细节。

### Components

- [gemini-api.ts](/Users/venom/Workspace/AI/pi-web-access/gemini-api.ts:1)
  - 升级为 transport 中心。
  - 负责配置解析、URL/path 拼接、请求构造、响应抽取、错误归类。

- `gemini-capabilities.ts`
  - 新增模块。
  - 负责维护协议能力矩阵和降级判断，避免业务层散落大量 protocol 判断。

- [gemini-search.ts](/Users/venom/Workspace/AI/pi-web-access/gemini-search.ts:1)
  - 搜索时优先查询 capability。
  - 支持原生 `google_search` tool 时走 tool。
  - 不支持时降级为 prompt-only 搜索回答，并在答案或错误里注明当前是弱兼容模式。

- [gemini-url-context.ts](/Users/venom/Workspace/AI/pi-web-access/gemini-url-context.ts:1)
  - 支持原生 `url_context` 时继续使用。
  - 不支持时返回 `null`，交由 [extract.ts](/Users/venom/Workspace/AI/pi-web-access/extract.ts:1) 现有 fallback 链处理。

- `video` / `youtube` 相关 Gemini API 调用模块
  - 通过统一 media generation 接口提交视频或文件输入。
  - 若 provider 不支持该输入格式，则抛出清晰的 capability 错误，让上层继续 fallback。

### Data Flow

主路径如下：

1. 读取 `~/.pi/web-search.json` 中的 Gemini API transport 配置。
2. 归一化配置，得到：
   - `geminiApiKey`
   - `geminiApiBaseUrl`
   - `geminiApiProtocol`
   - `geminiApiPath`
   - `geminiApiModel`
3. 上层功能模块发起意图型调用：
   - 搜索：`generateWithTooling(search)`
   - URL 分析：`generateWithTooling(url_context)` 或 `generateText(extractedContent)`
   - 视频 / 文件：`generateWithMedia(...)`
4. transport 层根据 `protocol` 生成请求：
   - `gemini`：
     - 默认 path 为 `/models/{model}:generateContent`
     - 请求体保持官方 `contents` / `parts` / `tools` 结构
   - `openai`：
     - 默认 path 为 `/chat/completions`
     - 请求体映射为 `model` + `messages`
     - 多模态输入映射为 `content parts`
     - 不原生支持的 Gemini tool 默认不注入
5. transport 层解析响应并返回统一结果。
6. 若 capability 缺失：
   - 可以降级时返回降级结果并附加说明
   - 不能降级时抛出 `ProviderCapabilityError`
7. 上层根据当前模块已有的 fallback 顺序继续尝试后备路径。

## Error Handling

重点处理以下失败模式：

- 配置错误
  - `protocol` 非法、`baseUrl` 非法、JSON 解析失败时，抛出清晰配置错误。

- HTTP 错误
  - 保留状态码和截断后的响应文本，便于定位第三方 provider 返回格式问题。

- 协议能力不兼容
  - 引入 `ProviderCapabilityError`，用于区分“服务不可用”和“服务不支持此能力”。
  - 示例：
    - `Configured Gemini API provider does not support google_search tooling`
    - `Configured Gemini API provider does not support video/file inputs`
    - `Configured Gemini API provider does not support url_context`

- 显式降级
  - `search` 在 `openai` 协议下如果不支持原生搜索 tool，则降级为 prompt-only 搜索回答，并附加说明。
  - `url analysis` 在 `openai` 协议下如果不支持 `url_context`，则返回 `null`，让网页提取逻辑继续走 `Readability -> RSC -> Jina -> Gemini Web` 链路。
  - `video` / `file` 在 provider 不支持 media 输入时，不伪装成功，直接抛出能力错误，让上层 fallback。

- Abort / timeout
  - 保持现有超时与 abort 语义，避免引入协议切换后中断处理回归。

## Testing

关键验证场景如下：

- 官方 Gemini 默认配置下，现有 `gemini-api` 功能无行为回归。
- 自定义 `geminiApiBaseUrl` + `gemini` 协议时，请求可正常指向第三方 Gemini 兼容端。
- 自定义 `geminiApiBaseUrl` + `openai` 协议时：
  - 基本文本生成可用。
  - `search` 在无原生 search tool 时会显式降级。
  - `url analysis` 不会卡死，会回退到现有内容提取链。
  - `video` / `file` 在不支持时给出清晰错误。
- 非法配置值会产出可理解的错误。
- README 中新增的配置示例与行为说明准确反映实际实现。
- 手动验证覆盖：
  - 一个普通 URL
  - 一个需要 `url_context` fallback 的 URL
  - 一个视频或文件分析场景
  - 一个 `web_search` 场景

## Open Questions

- 是否需要为 `openai` 协议额外暴露一个“高级能力声明”配置，让用户手动声明 provider 支持搜索或多模态，以减少过度保守的降级。
- 某些第三方 provider 可能使用 `Authorization: Bearer` 以外的认证头，当前设计默认沿用单一 API key 语义；若后续遇到不兼容 provider，可能需要再扩展认证配置。
- `geminiApiPath` 是否仅作为内部高级覆盖项记录在 README，还是正式公开为推荐配置字段；当前建议是公开但弱化宣传，避免普通用户误配。

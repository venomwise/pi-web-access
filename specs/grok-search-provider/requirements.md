# Requirements Document: Grok Search Provider

## Introduction

本项目为 `pi-web-access` 扩展的 `web_search` 工具新增 `grok` 作为第四个搜索 provider，基于 xAI 的 `/chat/completions` 接口启用原生 `search_parameters` Live Search 能力（`mode=on`、`return_citations=true`、`sources=web+news`），将 `SearchOptions` 的 `numResults` / `recencyFilter` / `domainFilter` 映射为 xAI 硬参数，并从响应的原生 `citations` 数组构建 `SearchResult[]`。新增独立 `grok.ts` 模块隔离 xAI 接入细节，扩展 `gemini-search.ts` 的 `SearchProvider` 联合类型与 `search()` 路由，在 auto 回退链中置于 Perplexity 之后、Gemini 之前，并同步更新 `index.ts` 的 provider 白名单、`ProviderAvailability` 结构、`web_search` 工具参数描述与错误提示。

系统边界：仅覆盖 `web_search` 场景；`code_search` / `fetch_content` / URL 提取 / YouTube / 视频分析等链路均不引入 Grok，也不复用 `gemini-api.ts` 的 `openai` 协议分支。模块只处理 xAI Live Search 原生能力与配置读取，不新增 `grokApiProtocol` / `grokApiPath` 等高级覆盖字段，不暴露 X(Twitter) source 为独立 `web_search` 入参。

## Glossary

- **Grok Provider**：`web_search` 的新搜索通道，透过 xAI API 调用 Grok 模型完成联网搜索。
- **xAI Live Search**：xAI `/chat/completions` 顶层 `search_parameters` 字段启用的服务端联网检索能力，响应附带 `citations` URL 数组。
- **`search_parameters`**：xAI 请求体中的 Live Search 配置对象，字段含 `mode`、`sources`、`from_date`、`to_date`、`max_search_results`、`return_citations`。
- **`sources`**：`search_parameters` 子字段，数组元素为 `{ type: "web" | "news" | "x", allowed_websites?, excluded_websites?, country? }`。
- **`citations`**：xAI 响应顶层的 URL 字符串数组，列出模型检索并引用的来源。
- **`SearchProvider`**：`gemini-search.ts` 导出的联合类型 `"auto" | "exa" | "perplexity" | "gemini" | "grok"`。
- **`SearchOptions`**：`perplexity.ts` 定义的通用搜索入参（`numResults` / `recencyFilter` / `domainFilter` / `signal`）。
- **`SearchResult`**：`{ title, url, snippet }`，所有 provider 统一的结果条目结构。
- **`SearchResponse`**：`{ answer, results, inlineContent? }`，所有 provider 统一的响应结构。
- **`ProviderAvailability`**：`index.ts` 用于向工具调用方声明 provider 可用性的结构体。
- **auto 回退链**：`provider="auto"` 时的 provider 尝试顺序（Exa → Perplexity → Grok → Gemini API → Gemini Web）。
- **`GROK_SYSTEM_PROMPT`**：`grok.ts` 内部的固定 system 消息文本，用于约束语气与循证输出。
- **`activityMonitor`**：`activity.ts` 导出的观测器，统一记录请求起止、状态码与错误信息。

## Requirements

### Requirement 1: Grok Provider 模块

**User Story:** As a Pi Agent 终端用户，I want 一个独立的 `grok.ts` 模块负责 xAI Key 探测与搜索请求，so that Grok provider 的可用性与实现细节与其他 provider 严格隔离。

#### Acceptance Criteria

1. WHEN `grok.ts` 首次被加载，THEN 系统 SHALL 声明常量 `DEFAULT_GROK_MODEL = "grok-3-mini"`、`DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1"`、`DEFAULT_MAX_SEARCH_RESULTS = 15`、`GROK_SYSTEM_PROMPT`（固定文案，与 `design.md` 一致）。
2. WHEN 调用 `loadConfig()`，THEN 系统 SHALL 从 `~/.pi/web-search.json` 读取 `grokApiKey` / `grokApiModel` / `grokApiBaseUrl` 字段并缓存（`cachedConfig` 模式）。
3. WHEN 调用 `getApiKey()`，THEN 系统 SHALL 按 `process.env.XAI_API_KEY > process.env.GROK_API_KEY > config.grokApiKey` 顺序取 Key，空白字符串视为未配置。
4. WHEN 调用 `isGrokAvailable()`，THEN 系统 SHALL 在 Key 可取到时返回 true，否则返回 false，且不抛异常。
5. IF 显式调用 `searchWithGrok` 但 Key 全部缺失，THEN 系统 SHALL 抛出错误，消息同时列出 `grokApiKey` / `XAI_API_KEY` / `GROK_API_KEY` 三种配置途径。
6. WHEN 模块对外导出符号时，THEN 系统 SHALL 至少导出 `isGrokAvailable` / `hasGrokApiKey` / `searchWithGrok` / `DEFAULT_GROK_MODEL` / `DEFAULT_GROK_BASE_URL`。

### Requirement 2: SearchOptions 到 search_parameters 的硬参数映射

**User Story:** As a Pi Agent 终端用户，I want `numResults` / `recencyFilter` / `domainFilter` 对 Grok 走硬参数而非 prompt 软约束，so that 过滤结果可被 xAI 服务端强制执行。

#### Acceptance Criteria

1. WHEN `options.numResults` 有值，THEN 系统 SHALL 将其传入 `search_parameters.max_search_results`；未提供时使用 `DEFAULT_MAX_SEARCH_RESULTS`（15）。
2. WHEN `options.recencyFilter === "day"`，THEN 系统 SHALL 设置 `from_date = 今日-1 日 (YYYY-MM-DD)`；`"week"` → 7 日；`"month"` → 30 日；`"year"` → 365 日；未提供或值非法时不注入 `from_date`。
3. WHEN `options.domainFilter` 非空，THEN 系统 SHALL 将以 `-` 开头的条目去前缀后放入 `sources[web].excluded_websites`，其余条目放入 `sources[web].allowed_websites`；两者任一为空数组时相应字段省略。
4. WHEN 构造 `search_parameters`，THEN 系统 SHALL 始终设置 `mode = "on"`、`return_citations = true`，并包含默认 `sources = [{ type: "web", ...过滤 }, { type: "news" }]`。
5. WHEN 请求体组装完成，THEN `messages` SHALL 为 `[{ role: "system", content: GROK_SYSTEM_PROMPT }, { role: "user", content: <原始 query> }]`，不再把 recency/domain 嵌入 user message。
6. IF `domainFilter` 条目包含非法域名（无点号、含非法字符），THEN 系统 SHALL 静默过滤该条目，不抛错、不报错日志。

### Requirement 3: 响应解析与结果构建

**User Story:** As a Pi Agent 终端用户，I want Grok 返回的引用稳定可用，so that 即使 `citations` 字段缺失也能拿到尽量完整的结果。

#### Acceptance Criteria

1. WHEN 响应顶层 `citations` 为非空 URL 数组，THEN 系统 SHALL 构建 `SearchResult[]`，每条 `{ title: "Source N", url, snippet: "" }`，并优先使用此来源。
2. WHEN `citations` 缺失或为空数组，THEN 系统 SHALL 尝试 `JSON.parse(choices[0].message.content)`，若解析成功且 `parsed.sources` 为对象数组，则用其 `url`（必填）、`title`（缺失回填 `"Source N"`）、`snippet`（缺失回填 `""`）构建结果。
3. IF JSON 解析失败或结构不符，THEN 系统 SHALL 调用 `extractSourceUrls(raw)`（从 `gemini-search.ts` 导出）作为最终兜底。
4. WHEN 解析得到的 `results` 长度超过 `options.numResults ?? 5`，THEN 系统 SHALL 裁剪至该上限。
5. WHEN `answer` 来源时，THEN 系统 SHALL 优先取 `JSON.parse(raw).content`（若有效），否则直接使用 `raw` 原文。
6. WHEN 本 provider 成功返回时，THEN 系统 SHALL **不**在 `answer` 尾部追加任何 prompt-only compatibility note（Live Search 已激活）。
7. IF `choices[0].message.content` 为空且 `citations` 为空，THEN 系统 SHALL 返回 `{ answer: "", results: [] }`，允许 `search()` auto 链继续回退。

### Requirement 4: search() 路由与 auto 回退链扩展

**User Story:** As a 扩展维护者，I want Grok provider 接入现有 `gemini-search.ts#search()` 路由，so that `provider` 参数与 auto 模式都能一致地驱动 Grok。

#### Acceptance Criteria

1. WHEN `gemini-search.ts` 加载后，THEN `SearchProvider` 联合类型 SHALL 包含 `"grok"`，且 `normalizeSearchProvider` 白名单同步接受 `"grok"`。
2. WHEN 显式调用 `search(query, { provider: "grok" })`，THEN 系统 SHALL 直接调用 `searchWithGrok` 并返回 `{ ...result, provider: "grok" }`；Key 缺失时上抛 Requirement 1.5 的错误。
3. WHEN `provider = "auto"` 或未指定时，THEN 系统 SHALL 按 `Exa → Perplexity → Grok → Gemini API → Gemini Web` 顺序尝试，且仅在 `isGrokAvailable()` 为 true 时进入 Grok 分支。
4. WHEN Grok 抛出非 abort 异常，THEN 系统 SHALL 将错误消息追加到 `fallbackErrors` 并继续尝试下游 provider，不中断链。
5. IF Grok 被 abort（signal 取消），THEN 系统 SHALL 立即重抛 abort 错误，不触发后续 provider。
6. WHEN `extractSourceUrls` 被 `grok.ts` 复用，THEN 系统 SHALL 将其在 `gemini-search.ts` 中改为 `export`，且不更改其行为或签名。
7. WHEN 所有 auto 候选失败，THEN "No search provider available" 错误消息 SHALL 同时提示 Grok 配置方式（`grokApiKey` / `XAI_API_KEY` / `GROK_API_KEY`）。

### Requirement 5: index.ts 工具注册与声明同步

**User Story:** As a Pi Agent 终端用户，I want `web_search` 工具的参数提示与可用 provider 声明反映 Grok 的加入，so that 工具调用方能正确发现与选用 Grok。

#### Acceptance Criteria

1. WHEN `index.ts` 的 `normalizeProviderInput` 校验 `provider` 入参，THEN 白名单 SHALL 接受 `"grok"`（与 `auto/exa/perplexity/gemini` 并列）。
2. WHEN 构造 `ProviderAvailability`，THEN 接口 SHALL 新增 `grok: boolean` 字段，值由 `isGrokAvailable()` 提供。
3. WHEN `defaultProvider` 推导 auto 实际指向，THEN 顺序 SHALL 对齐 Requirement 4.3 的回退链。
4. WHEN 注册 `web_search` 工具 schema，THEN `provider` 描述文本 SHALL 列出 `auto / exa / perplexity / grok / gemini`。
5. IF 用户传入不在白名单内的 provider 值，THEN 系统 SHALL 返回现有的非法值错误，不因 Grok 加入而降低校验严格度。

### Requirement 6: 观测与错误处理

**User Story:** As a 扩展维护者，I want Grok 的请求链路与现有 provider 一致接入 `activityMonitor`，so that 线上可观测性无缝扩展。

#### Acceptance Criteria

1. WHEN 进入 `searchWithGrok`，THEN 系统 SHALL 立即调用 `activityMonitor.logStart({ type: "api", query })` 取得 `activityId`。
2. WHEN 请求正常结束（含 2xx 与业务空结果），THEN 系统 SHALL 调用 `activityMonitor.logComplete(activityId, response.status)`。
3. WHEN 请求抛 abort 错误，THEN 系统 SHALL 调用 `activityMonitor.logComplete(activityId, 0)` 再重抛，不触发 `logError`。
4. WHEN 请求遇到网络异常或 JSON.parse(response) 失败（响应体本身），THEN 系统 SHALL 调用 `activityMonitor.logError(activityId, message)` 并上抛。
5. IF HTTP 响应非 2xx，THEN 系统 SHALL 读取 `response.text()`，调用 `logComplete(activityId, status)`，并抛 `Grok API error <status>: <body>` 错误。
6. WHEN 响应 `content` 非 JSON（不符合 Requirement 3.2 结构），THEN 系统 SHALL **不**抛错，按 Requirement 3.3 兜底。
7. IF xAI 返回 400 表示 `search_parameters` 不被识别，THEN 系统 SHALL 依 Requirement 6.5 抛出并让 `search()` 上层处理，**不**自动降级到无 `search_parameters` 的再请求。

### Requirement 7: 文档与配置同步

**User Story:** As a Pi Agent 终端用户，I want `README.md` 与配置示例同步反映 Grok 的能力与配置项，so that 首次接入时能按官方文档完成配置。

#### Acceptance Criteria

1. WHEN 更新 `README.md` 的 "Install" / "Configuration" 段，THEN 配置 JSON 示例 SHALL 新增 `grokApiKey`、`grokApiModel`、`grokApiBaseUrl` 字段。
2. WHEN 更新 "Tools > web_search > provider" 表格/说明，THEN `grok` SHALL 作为合法取值列入。
3. WHEN 更新 "How It Works" 搜索回退流程图/文字，THEN 顺序 SHALL 改为 `Exa → Perplexity → Grok → Gemini API → Gemini Web`。
4. WHEN 描述 Grok 的能力，THEN 文档 SHALL 说明走 xAI Live Search、`recencyFilter` / `domainFilter` / `numResults` 为原生硬参数、默认 `sources = web + news`、citations 来自 xAI 原生字段。
5. WHEN 描述环境变量，THEN 文档 SHALL 列出 `XAI_API_KEY`（官方）与 `GROK_API_KEY`（别名）且说明优先级高于配置文件。
6. IF 未来需要暴露 X source 或调整默认模型，THEN 文档 SHALL **不**在当前版本提及（保持 scope 聚焦）。

### Requirement 8: 手动冒烟验证清单

**User Story:** As a 扩展维护者，I want 一份可复用的手动冒烟步骤，so that 每次 Grok provider 相关改动发 PR 前有一致的验证基线。

#### Acceptance Criteria

1. WHEN PR 描述撰写时，THEN 验证人 SHALL 覆盖：显式 Grok Key 路径、Key 缺失报错、auto 回退命中 Grok、auto 跳过 Grok、abort 取消。
2. WHEN 验证硬过滤参数，THEN 验证人 SHALL 分别构造 `recencyFilter` / `domainFilter`（含 `-` 排除语法）/ `numResults` 用例并人工抽查响应 citations 是否满足约束。
3. WHEN 验证兜底解析，THEN 验证人 SHALL 至少一次观察到 `citations` 存在的正常路径与构造一次无 `citations` 响应的兜底路径。
4. WHEN 验证配置覆盖，THEN 验证人 SHALL 通过 `grokApiBaseUrl` 指向替代端点（或打印请求 URL）确认地址覆盖生效。
5. IF 手动验证发现实际行为与 Acceptance Criteria 不符，THEN 本次改动 SHALL 不被合入，需回到实现或设计阶段修复。

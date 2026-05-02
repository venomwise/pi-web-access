# Implementation Plan: Grok Search Provider

## Overview

This implementation plan is driven by the requirements in [requirements.md](requirements.md).

按 **6 个主阶段 + 2 个 Checkpoint** 推进，执行顺序围绕"先落底座、再拼接入、后同步外部界面"的依赖链：① 先实现独立的 `grok.ts`（Key 探测 / `search_parameters` 构造 / 响应解析），不触碰其他文件；② 改造 `gemini-search.ts`（export `extractSourceUrls`、扩 `SearchProvider`、插 auto 回退分支），让搜索路由可调用到新模块；③ 同步 `index.ts` 的工具 schema、`ProviderAvailability`、`defaultProvider` 与错误提示，使 `web_search` 工具层可对外暴露 Grok；④ 更新 `README.md` 使文档与实际行为一致；⑤ Checkpoint 集中审视代码与文档的自洽性；⑥ 按 AGENTS.md 执行 `npm pack` 与手动冒烟验证。

关键技术决策：TypeScript ESM（import 带 `.js` 后缀、tab 缩进）、独立 provider 模块（不复用 `gemini-api.ts` 的 openai 分支）、`~/.pi/web-search.json` + `cachedConfig` 模式读取配置、Key 优先级 `XAI_API_KEY > GROK_API_KEY > config.grokApiKey`、启用 `search_parameters` 原生 Live Search（`mode=on` / `return_citations=true` / 默认 `sources=web+news`）、响应 citations 优先 + JSON.parse 次之 + `extractSourceUrls` 兜底的三段式解析。无自动化测试框架，测试任务全部使用 `- [ ]*` 标注为可选手动步骤。

## Tasks

- [✅] 1. Phase 1: 新增 grok.ts provider 模块
  - [✅] 1.1 建立模块骨架与常量
    - 在仓库根新增 `grok.ts`，ESM 风格，import 所需依赖使用 `.js` 后缀（`./activity.js`、`./perplexity.js`、`./gemini-search.js`）
    - 声明模块常量 `DEFAULT_GROK_MODEL = "grok-3-mini"`、`DEFAULT_GROK_BASE_URL = "https://api.x.ai/v1"`、`DEFAULT_MAX_SEARCH_RESULTS = 15`
    - 定义 `GROK_SYSTEM_PROMPT` 常量，文案与 `specs/grok-search-provider/design.md` 中的 Components 节保持一致
    - 定义 `CONFIG_PATH = join(homedir(), ".pi", "web-search.json")` 与 `WebSearchConfig` 本地接口（仅含 `grokApiKey` / `grokApiModel` / `grokApiBaseUrl`）
    - _Requirements: 1.1, 1.2_
  - [✅] 1.2 实现配置与 Key 探测
    - 实现 `loadConfig()`：沿用 `perplexity.ts` 的 `cachedConfig` 缓存模式，仅解析上述三个字段，JSON 解析失败时抛同风格错误
    - 实现 `normalizeApiKey(value: unknown): string | null` 私有辅助
    - 实现 `getApiKey()`：按 `process.env.XAI_API_KEY → process.env.GROK_API_KEY → config.grokApiKey` 顺序取值，Key 缺失时抛包含三种配置途径的错误消息
    - 导出 `hasGrokApiKey()` 与 `isGrokAvailable()`：均为非抛错布尔判断
    - _Requirements: 1.2, 1.3, 1.4, 1.5_
  - [✅] 1.3 实现 search_parameters 组装辅助函数
    - 实现私有 `mapRecencyToFromDate(recency: string | undefined): string | undefined`：`day=1 / week=7 / month=30 / year=365` 日回溯至 `YYYY-MM-DD`，其他值返回 undefined
    - 实现私有 `splitDomainFilter(domains: string[] | undefined): { allowed: string[]; excluded: string[] }`：`-` 前缀归 excluded，其余归 allowed，并复用 `perplexity.ts` 同风格的域名合法性过滤（复制最小逻辑，**不**引入循环依赖）
    - 实现私有 `buildSearchParameters(options: SearchOptions)`：始终设 `mode: "on"`、`return_citations: true`、`max_search_results: options.numResults ?? DEFAULT_MAX_SEARCH_RESULTS`；按 Requirement 2.2/2.3 注入 `from_date`；按拆分结果构造 `sources[0] = { type: "web", allowed_websites?, excluded_websites? }`，并在末尾追加 `{ type: "news" }`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.6_
  - [✅] 1.4 实现 searchWithGrok 主函数
    - 导出 `async function searchWithGrok(query, options): Promise<SearchResponse>`，参数类型复用 `perplexity.ts` 的 `SearchOptions` 与 `SearchResponse`
    - 进入函数立即 `const activityId = activityMonitor.logStart({ type: "api", query })`
    - 组装请求体：`model = config.grokApiModel ?? DEFAULT_GROK_MODEL`、`baseUrl = config.grokApiBaseUrl ?? DEFAULT_GROK_BASE_URL`、`messages = [{ role: "system", content: GROK_SYSTEM_PROMPT }, { role: "user", content: query }]`、顶层 `search_parameters = buildSearchParameters(options)`、`max_tokens: 1024`
    - `fetch(`${baseUrl}/chat/completions`, { method:"POST", headers:{ Authorization:`Bearer ${apiKey}`, "Content-Type":"application/json" }, body: JSON.stringify(...), signal: options.signal })`
    - 网络异常分支：按 abort 判断调 `logComplete(activityId, 0)` 或 `logError(activityId, message)` 再抛
    - _Requirements: 1.6, 2.5, 6.1, 6.2, 6.3, 6.4_
  - [✅] 1.5 实现响应解析与结果构建
    - 非 2xx：读 `response.text()` → `logComplete(activityId, status)` → 抛 `Grok API error <status>: <body>`
    - 成功响应：`data = await response.json()`，捕获 JSON 失败并 `logError` 后抛
    - `raw = data.choices?.[0]?.message?.content ?? ""`
    - 解析 answer：先尝试 `JSON.parse(raw)`，若成功且 `parsed.content` 为 string 则 `answer = parsed.content`，否则 `answer = raw`
    - 解析 results 三段式兜底：
      1. `Array.isArray(data.citations) && data.citations.length > 0` → 映射为 `{ title: "Source N", url, snippet: "" }`
      2. 否则如 JSON 解析成功且 `parsed.sources` 为对象数组 → 映射 url/title/snippet（缺失回填）
      3. 最后 `results = extractSourceUrls(raw)`（来自 `gemini-search.ts` 的导出）
    - 统一对 `results` 裁剪至 `Math.min(len, options.numResults ?? 5)`
    - `content` 为空且 `citations` 为空 → 返回 `{ answer: "", results: [] }`
    - 成功路径 `logComplete(activityId, response.status)` 返回 `{ answer, results }`
    - _Requirements: 3.1, 3.2, 3.3, 3.4, 3.5, 3.6, 3.7, 6.5, 6.6, 6.7_
  - [ ]* 1.6 对 grok.ts 做手动 TypeScript 语法检查
    - 在仓库根执行 `npx tsc --noEmit grok.ts`（或 IDE LSP 诊断）确认类型、import、ESM 后缀无误
    - 检查所有对外导出符号与 Requirement 1.6 清单一致
    - _Requirements: 1.1, 1.6_

- [✅] 2. Phase 2: gemini-search.ts 路由扩展
  - [✅] 2.1 扩展类型与白名单
    - 在 `gemini-search.ts` 的 `SearchProvider` 联合类型追加 `"grok"`
    - `normalizeSearchProvider` 白名单同步接受 `"grok"`
    - 将现有私有函数 `extractSourceUrls` 改为 `export`，保持签名与行为不变
    - 新增 `import { isGrokAvailable, searchWithGrok } from "./grok.js"`
    - _Requirements: 4.1, 4.6_
  - [✅] 2.2 新增显式 grok 分支
    - 在 `search()` 函数中，于现有 `provider === "exa"` 分支之后、auto 回退之前，新增 `if (provider === "grok") { ... }` 分支
    - 分支内直接调 `searchWithGrok(query, options)`，返回 `{ ...result, provider: "grok" }`
    - Key 缺失情况依赖 `searchWithGrok` 内部 `getApiKey()` 抛错上传，无需本层重复校验
    - _Requirements: 4.2_
  - [✅] 2.3 插入 auto 回退分支
    - 在 auto 回退链的 Perplexity 段之后、Gemini 段之前插入：`if (provider !== "grok" && isGrokAvailable()) { try { const result = await searchWithGrok(query, options); return { ...result, provider: "grok" }; } catch (err) { if (isAbortError(err)) throw err; fallbackErrors.push(`Grok: ${errorMessage(err)}`); } }`
    - 更新底部 "No search provider available" 错误消息，追加 Grok 配置提示（`grokApiKey` / `XAI_API_KEY` / `GROK_API_KEY`）
    - _Requirements: 4.3, 4.4, 4.5, 4.7_
  - [ ]* 2.4 回归 gemini-search.ts 诊断
    - `npx tsc --noEmit gemini-search.ts` 确认改动无类型错误
    - 人工搜索 `provider === "` 与 `fallbackErrors` 相关片段，确认未误删/误改 Exa/Perplexity/Gemini 既有路径
    - _Requirements: 4.1, 4.2, 4.3_

- [✅] 3. Phase 3: index.ts 工具与可用性同步
  - [✅] 3.1 扩展 provider 白名单与可用性结构
    - `normalizeProviderInput` 白名单追加 `"grok"`（保持返回值类型为 `SearchProvider | undefined`）
    - `ProviderAvailability` 接口新增 `grok: boolean`
    - 组装 `availableProviders` 对象时加 `grok: isGrokAvailable()`，并 `import { isGrokAvailable } from "./grok.js"`
    - _Requirements: 5.1, 5.2, 5.5_
  - [✅] 3.2 更新 defaultProvider 与工具 schema
    - 若 `defaultProvider` 推导依赖顺序表/优先级数组，将 `grok` 插入 Perplexity 之后、Gemini 之前
    - 更新 `web_search` 工具注册位置的 `provider` 参数 description / enum 文案，列为 `auto / exa / perplexity / grok / gemini`
    - _Requirements: 5.3, 5.4_
  - [ ]* 3.3 校验 index.ts 诊断
    - `npx tsc --noEmit index.ts`（或整仓 `npx tsc --noEmit`）确认无错
    - 人工确认未破坏现有 `web_search` / `code_search` / `fetch_content` 工具注册
    - _Requirements: 5.1, 5.2, 5.3, 5.4_

- [✅] 4. Phase 4: Checkpoint - 源代码自洽性审视
  - 串读 `grok.ts` → `gemini-search.ts` → `index.ts` 三处改动，确认：`SearchProvider` 值域在三处一致；`isGrokAvailable` 只在 `gemini-search.ts#search()` auto 分支与 `index.ts#availableProviders` 被调用；`searchWithGrok` 的错误消息格式能被 auto 链 `fallbackErrors` 正常捕获；`extractSourceUrls` 的 export 未被其它模块意外引用
  - 若发现问题，回到对应 Phase 修复；否则进入 Phase 5
  - _Requirements: 1.6, 4.1, 4.6, 5.1, 5.2_

- [✅] 5. Phase 5: README 与配置文档同步
  - [✅] 5.1 更新配置 JSON 示例
    - `## Install` 下的首个配置 JSON 追加 `"grokApiKey": "xai-..."`
    - `## Configuration` 的完整示例追加 `grokApiKey / grokApiModel / grokApiBaseUrl` 字段（保持字段顺序与现有 `geminiApi*` 分组呼应）
    - _Requirements: 7.1_
  - [✅] 5.2 更新工具与回退链说明
    - `## Tools > web_search` 的 provider 取值表格追加 `grok`
    - `## How It Works` 的 `web_search` 流程图更新为 `Exa → Perplexity → Grok → Gemini API → Gemini Web`
    - "Smart Fallbacks" 段（Why Pi Web Access）同步更新 fallback 顺序描述
    - _Requirements: 7.2, 7.3_
  - [✅] 5.3 新增 Grok Live Search 能力小节与环境变量说明
    - 在合适位置（如 `## Configuration` 结尾或新建 "### Grok Live Search" 子节）说明：走 xAI Live Search、`recencyFilter` / `domainFilter` / `numResults` 为原生硬参数、默认 `sources = web + news`、citations 来自原生 `citations` 字段
    - 在环境变量说明段落追加 `XAI_API_KEY` / `GROK_API_KEY` 并注明优先级高于配置文件
    - _Requirements: 7.4, 7.5, 7.6_

- [ ] 6. Phase 6: 手动冒烟与发布准备
  - [ ] 6.1 执行 `npm pack` 打包验证
    - 仓库根运行 `npm pack`，确认无错误、产物 tarball 中包含新文件 `grok.ts`
    - _Requirements: 8.5_
  - [ ]* 6.2 手动冒烟：provider=grok 主路径
    - 配置 `~/.pi/web-search.json` 的 `grokApiKey`，用 Pi 调用 `web_search({ query: "TypeScript 5.6 release notes", provider: "grok" })`
    - 确认：返回 `answer` 无 compatibility note；`results` 至少 1 条；activity 面板显示 200；返回体 `provider === "grok"`
    - _Requirements: 3.1, 3.5, 3.6, 6.1, 6.2, 8.1_
  - [ ]* 6.3 手动冒烟：Key 缺失与 abort
    - 移除 Grok Key，显式 `provider: "grok"` → 错误消息包含 `grokApiKey / XAI_API_KEY / GROK_API_KEY`
    - 触发 abort 信号（例如提前取消），确认活动状态码 0 且抛 abort 错误
    - _Requirements: 1.5, 6.3, 8.1_
  - [ ]* 6.4 手动冒烟：auto 回退路径
    - 场景 A：仅留 Grok Key（移除 Exa/Perplexity Key），`web_search({ query })` auto → 实际 `provider === "grok"`
    - 场景 B：移除 Grok Key 保留其他，auto → 跳过 Grok 命中 Gemini 或前置 provider，行为不变
    - _Requirements: 4.3, 4.4, 8.1_
  - [ ]* 6.5 手动冒烟：硬过滤参数
    - `recencyFilter: "week"`：人工抽查 `citations` 对应页面发布时间集中在近 7 日
    - `domainFilter: ["github.com"]`：所有 citations URL 来自 github.com
    - `domainFilter: ["-reddit.com"]`：无 reddit.com
    - `domainFilter: ["github.com", "-reddit.com"]`：仅 github.com 且无 reddit.com
    - `numResults: 3`：`results.length <= 3`
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 3.4, 8.2_
  - [ ]* 6.6 手动冒烟：兜底解析与 baseUrl 覆盖
    - 观察一次正常 citations 路径；构造一次无 `citations` 场景（例如使用不支持 Live Search 的模型或在本地 mock 代理去掉字段），确认降级为 `extractSourceUrls(raw)` 时 `results.length >= 0` 且无异常
    - 设置 `grokApiBaseUrl` 指向自建 OpenAI 兼容代理（或通过网络抓包/日志验证），确认请求 URL 使用覆盖地址
    - _Requirements: 3.3, 8.3, 8.4_
  - [ ]* 6.7 PR 描述 & 验证清单撰写
    - 按 AGENTS.md PR 规范汇总：behavior summary、manual verification steps（引用本 Phase 的冒烟结果）、linked issues（如有）、涉及 curator UI 改动时附截图
    - 若任何 Acceptance Criteria 未通过，按 Requirement 8.5 停止合入并回溯
    - _Requirements: 8.1, 8.2, 8.3, 8.4, 8.5_

## Notes

- Tasks marked with `*` are optional and can be skipped for an MVP.
- Each task should reference one or more requirement IDs for traceability.
- Keep task numbering stable so requirement references stay valid.
- 实现语言：TypeScript ESM；关键依赖：仓库内 `activity.ts` / `perplexity.ts`（类型复用）/ `gemini-search.ts`（路由集成）；不引入新的第三方包。
- 模块边界：`grok.ts` 仅暴露 `isGrokAvailable` / `hasGrokApiKey` / `searchWithGrok` 及必要常量；xAI 协议细节（`search_parameters` / `citations`）不外泄。
- 无自动化测试框架，所有验证通过 Phase 6 手动冒烟完成；若后续引入 `tests/` 目录，应将 Phase 6 的场景转译为 `*.test.ts` 用例。

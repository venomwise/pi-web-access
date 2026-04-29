# Implementation Plan: Gemini API Transport

## Overview

This implementation plan is driven by the requirements in [requirements.md](requirements.md).

实现分为 4 个阶段。首先收敛统一配置与 transport 接口，因为后续 `search`、`url_context`、`video/file` 都依赖这一层；然后分别接入搜索与分析路径，最后补充文档与手动验证。整体沿用当前 TypeScript ESM 结构，不引入新依赖，尽量在 `gemini-api.ts` 附近集中协议映射与错误处理，避免业务模块重复判断 `protocol`。

## Tasks

- [ ] 1. Phase 1: 建立统一 Gemini API transport
  - [ ] 1.1 扩展 Gemini API 配置读取与归一化
    - 修改 `gemini-api.ts` 中的配置解析逻辑，新增 `geminiApiBaseUrl`、`geminiApiProtocol`、`geminiApiModel`、`geminiApiPath` 字段及其默认值
    - 保留 `GEMINI_API_KEY` 对 `geminiApiKey` 的优先级，并为非法 `protocol`、`baseUrl`、`path` 提供描述性错误
    - 导出统一配置类型与读取入口，供 `gemini-search.ts`、`gemini-url-context.ts` 与 video 相关模块复用
    - _Requirements: 1.1, 1.2, 1.3, 1.4, 1.5, 7.1_
  - [ ] 1.2 在 `gemini-api.ts` 中实现协议无关 transport 接口
    - 重构 `API_BASE` 常量式调用，新增统一请求入口，如文本生成、带 tool 的生成、带 media 的生成
    - 为 `gemini` 协议实现 `generateContent` 请求构造与响应解析
    - 为 `openai` 协议实现 `chat/completions` 请求构造与响应解析
    - 保留显式 `model` override，并统一处理 HTTP 错误、响应截断与协议不匹配错误
    - _Requirements: 2.1, 2.2, 2.3, 2.4, 2.5, 7.3, 7.4_
  - [ ] 1.3 新增集中式 capability 判定模块
    - 创建 `gemini-capabilities.ts`，封装 `google_search`、`url_context`、多模态输入等能力矩阵
    - 在 capability 层定义 `ProviderCapabilityError` 或等价错误类型，避免在业务模块散落协议判断
    - 对 `openai` 协议采用保守默认能力集，并暴露调用方可用的判定函数
    - _Requirements: 3.1, 3.3, 3.4, 3.5_
  - [ ]* 1.4 为 transport 核心流程补充单元或局部验证
    - 验证默认配置保持官方 Gemini 行为
    - 验证 `openai` 协议请求映射、协议不匹配错误和配置错误路径
    - _Requirements: 1.2, 2.2, 2.3, 2.5, 7.1, 7.3_

- [ ] 2. Phase 2: 接入搜索与 URL 分析路径
  - [ ] 2.1 重构 `gemini-search.ts` 使用统一 transport 和 capability
    - 替换当前直接拼接 Gemini API URL 的搜索调用，改为调用 `gemini-api.ts` 暴露的 transport 接口
    - 在支持 `google_search` 时保留现有 tool 搜索行为
    - 在不支持时实现 prompt-only 降级，并在结果中追加弱兼容提示文本
    - 保持现有 abort、timeout 与 provider fallback 顺序不变
    - _Requirements: 2.1, 3.1, 3.2, 4.1, 4.2, 4.3, 4.4, 4.5, 7.2_
  - [ ] 2.2 重构 `gemini-url-context.ts` 使用统一 transport 和 capability
    - 替换当前直接调用官方 `url_context` 请求的逻辑，改为通过 transport + capability 判定
    - 在支持 `url_context` 时保留现有路径
    - 在不支持时返回 `null`，确保 `extract.ts` 中既有 `Readability -> RSC -> Jina -> Gemini Web` fallback 链继续执行
    - 对协议不匹配和能力不支持场景使用清晰错误或显式回退
    - _Requirements: 2.1, 3.1, 3.2, 3.3, 5.1, 5.2, 5.5, 7.2_
  - [ ]* 2.3 为搜索和 URL 降级路径补充验证
    - 验证 `gemini` 协议下保留原生 search 与 `url_context`
    - 验证 `openai` 协议下 search 降级提示与 URL 回退链正常工作
    - _Requirements: 4.1, 4.2, 4.3, 5.1, 5.2, 7.2_

- [ ] 3. Phase 3: 接入 video / file 分析路径
  - [ ] 3.1 识别并重构 Gemini API 的 media 调用入口
    - 修改 `video-extract.ts`、`youtube-extract.ts` 或其实际使用的 Gemini API 调用点，统一接入 `generateWithMedia()` 风格接口
    - 保留现有 `preferredModel` / 调用级 `model` override 语义，同时复用全局 base URL、protocol 与认证配置
    - _Requirements: 2.1, 2.4, 5.3, 5.5, 7.1_
  - [ ] 3.2 实现 media 能力映射与失败策略
    - 在 `gemini-api.ts` 中为支持的协议映射多模态输入结构
    - 在 provider 不支持文件或视频输入时抛出 `ProviderCapabilityError` 或等价错误
    - 确保上层现有 fallback 可继续执行，而不是将不支持能力误判为成功
    - _Requirements: 3.1, 3.3, 5.3, 5.4, 5.5, 7.4_
  - [ ]* 3.3 为 media 场景补充验证
    - 验证支持多模态输入时的正常请求路径
    - 验证不支持时的错误提示与 fallback 延续
    - _Requirements: 5.3, 5.4, 5.5, 7.2_

- [ ] 4. Checkpoint - 验证核心 Gemini transport 集成
  - 确认 `gemini-api.ts`、`gemini-search.ts`、`gemini-url-context.ts` 与 media 相关模块全部改为统一 transport
  - 核对所有能力不兼容路径都已实现“显式降级或明确错误”，没有静默失败
  - 复查 `requirements.md` 中的 1-7 号需求是否均有实现任务覆盖
  - _Requirements: 1.1, 2.1, 3.1, 4.1, 5.1, 6.1, 7.1_

- [ ] 5. Phase 4: 文档与发布前验证
  - [ ] 5.1 更新 `README.md` 的 Gemini 配置与行为说明
    - 在配置示例中新增 `geminiApiBaseUrl`、`geminiApiProtocol`、`geminiApiModel`、`geminiApiPath`
    - 说明默认官方 Gemini 行为、第三方 provider 用法，以及 `openai` 协议下的降级限制
    - 将 `geminiApiPath` 标注为高级覆盖项，避免普通用户误用
    - _Requirements: 6.1, 6.2, 6.3, 6.4, 7.1_
  - [ ]* 5.2 执行手动回归验证
    - 使用官方 Gemini 默认配置验证 `web_search`、普通 URL、需要 fallback 的 URL、video/file 场景
    - 使用第三方兼容配置验证 `openai` 协议下的文本生成、search 降级、URL 回退与 media 错误提示
    - 记录无法在本地自动化覆盖的验证步骤，便于 PR 或发布说明复用
    - _Requirements: 4.1, 4.2, 5.1, 5.2, 5.4, 6.4, 7.1, 7.2, 7.3_
  - [ ]* 5.3 整理实现备注与残余风险
    - 记录已知第三方 provider 兼容性边界，例如 search tool、`url_context`、media 输入的不等价性
    - 为后续是否增加高级 capability 声明配置保留实现注记
    - _Requirements: 3.4, 6.2, 7.4_

## Notes

- Tasks marked with `*` are optional and can be skipped for an MVP.
- Each task should reference one or more requirement IDs for traceability.
- Keep task numbering stable so requirement references stay valid.
- 实现阶段优先保持现有 fallback 顺序与默认官方 Gemini 行为不变，再逐步增加第三方兼容能力。

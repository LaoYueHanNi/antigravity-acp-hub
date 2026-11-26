# DR: 采用复合会话 ID（<harness>:<nativeSessionId>）作为跨后端路由主键

Status: implemented

## Problem

多后端连接池需要同时维护 Claude Code、Codex CLI、Gemini CLI、OpenCode、Goose 及自定义 Agent 等多个独立 ACP 子进程。不同 Harness 各自独立生成 `sessionId`（如递增短 ID 或 UUID），若直接透传给 MCP 调用方，存在跨后端 ID 碰撞风险；且调用 `acp_prompt`、`acp_cancel`、`acp_close_session`、`acp_load_session` 时若缺乏归属标识，将迫使调用方每次重复传入 `harness` 参数或在子进程重启后无法识别归属。

## Decision

`server/acp-hub.mjs` 对外统一采用 `<harnessId>:<nativeSessionId>` 复合会话 ID（例如 `claude:cc206423-...`）：

- `acp_new_session`、`acp_load_session` 与 `acp_list_sessions` 返回的 `sessionId` 均携带 `<harnessId>:` 前缀。
- 向底层 ACP 子进程发起 JSON-RPC 请求或通知前自动剥离前缀，并通过内部 `nativeIndex`（`harnessId + nativeSessionId -> compositeSessionId`）将 `session/update`、`session/request_permission`、`elicitation/create` 回调准确路由回对应会话状态。
- `acp_prompt`、`acp_cancel`、`acp_close_session` 仅凭 `session_id` 即可完成唯一路由；`acp_load_session` 同时兼容传入复合 ID 或原生 ID 搭配显式 `harness` 参数。
- 每个复合会话持有独立串行锁（`#withSessionLock`），确保同会话多轮调用严格串行不串线，同时不同会话与不同 Harness 之间可完全并发执行。

## Alternatives considered

- **直接透传原生 `sessionId` + 纯内存路由表** —— 两个不同 Harness 理论上可能产出相同的短 ID 造成路由冲突；一旦子进程崩溃重建或加载历史持久化会话，内存表失效后无法仅凭 ID 恢复归属。
- **桥接层重新生成完全独立的随机 UUID 映射** —— 增加额外状态映射复杂度，排查底层 ACP 日志或用历史原生 ID 执行 `acp_load_session` 时不够直观。

## Consequences

- 代价：对外暴露的 `session_id` 比原生 ID 多了一段 `<harness>:` 前缀，桥接层需要在出入口执行前缀拼接与解析校验。
- 换来：跨 Harness 全局绝对唯一、接口参数更简洁、日志与工具输出自带后端标识，且历史会话恢复与崩溃重建时归属信息不丢失。

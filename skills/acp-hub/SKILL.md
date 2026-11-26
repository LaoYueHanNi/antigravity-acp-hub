---
name: acp-hub
description: >-
  通过标准 ACP（Agent Client Protocol）协议统一调度本地或自定义的各类编程 Agent / Harness（如 Claude Code、Codex CLI、Gemini CLI、OpenCode、Goose 等），支持多后端连接池、有状态多轮会话、跨 Harness 协同及每次调用动态权限策略。当用户要求调用外部编程 Agent 协助分析、规划、编码、交叉 Review 或管理 ACP 会话时使用。
---

# ACP Hub 通用调度指南

本插件（`acp-hub`）通过内置 MCP 服务维护多后端常驻 ACP 连接池。所有对外会话 ID 均采用复合格式 `<harness>:<nativeSessionId>`，跨 Harness 唯一且自动路由。

## 可用工具

- `acp_list_harnesses`：列出全部已配置 Harness（内置预设 + `~/.gemini/config/acp-harnesses.json` 覆盖）、本机安装状态、连接状态与协商能力；传入 `probe: true` 可主动执行 ACP `initialize` 握手诊断。
- `acp_new_session`：在指定 `harness` 与工作目录（绝对路径 `cwd`）创建有状态会话，可附带 `initial_prompt` 首轮直达。
- `acp_prompt`：向已有 `session_id` 发送后续指令，保持多轮上下文，并可单次覆盖 `mode`、`approval_policy`、`model`、`config_options`。
- `acp_load_session`：在声明了 `loadSession` 能力的 Harness 上恢复历史持久化会话。
- `acp_list_sessions`：查看全部或指定 Harness 的活跃会话，可选 `include_history: true` 查询持久化历史。
- `acp_cancel`：中断正在运行的回合。
- `acp_close_session`：释放会话及相关客户端代理资源。

## 多 Harness 选派与协同工作流

1. **先探测再调度**：首次使用或不确定环境时，先调用 `acp_list_harnesses`，仅选择 `enabled: true && runnable: true` 的 Harness；若目标 Harness 未安装，向用户转达返回的 `installHint`，不要猜测命令。
2. **合理分工与交叉协同**：
   - **独立深度调研 / 方案对比**：可同时对不同 Harness 创建独立 `read_only` 会话并行分析同一问题，汇总各自观点与盲区。
   - **实现 + 独立 Review**：用一个 Harness 完成代码修改后，另起一个只读会话交给另一个 Harness 做独立 Code Review，避免单一模型盲点。
   - **多轮接力**：同一子任务尽量复用同一个 `session_id` 连续追问，减少重复读库成本。
3. **优雅应对能力差异**：不同 Harness 对 `mode`、`model`、`config_options`、`loadSession`、`session/list` 的支持各异。首次创建会话后参考返回的 `availableModes` / `configOptions` / `capabilities`，出现 `warnings` 时如实向用户说明。

## 动态权限策略矩阵（每次调用按需传入）

桥接层依据 ACP 标准 `toolCall.kind` 执行跨 Harness 一致的 Fail-Closed 权限审批：

| 场景 | 推荐 `approval_policy` | 可选 `mode` 示例 | 放行范围 |
| :--- | :--- | :--- | :--- |
| 只读调研 / 架构分析 / Code Review（默认） | `"read_only"` | Claude 可传 `"plan"` / `"default"` | 仅放行只读、搜索、抓取、思考类操作；拦截所有写入、删改与命令执行 |
| 明确允许修改代码（不跑命令、不删文件） | `"accept_edits"` | Claude 可传 `"acceptEdits"` | 放行只读 + 文件编辑；仍拦截 `delete`、`move` 与 `execute`（Shell 命令） |
| 用户明确授权全自动改代码并运行测试 | `"allow_all"` | 按目标 Harness 支持模式传入 | 放行本次回合的全部权限请求（优先选 `allow_once` 避免污染后续回合） |
| 严格审计 / 仅对话不执行工具 | `"reject_all"` | — | 拦截全部工具权限请求并记录 |

## 安全红线与交互原则

- **绝不私自提权**：如果返回结果包含 `denied_permissions`，说明外部 Agent 尝试了超出当前 `approval_policy` 的操作并已被拦截。必须先向用户列出被拦截的工具、类型与参数摘要，**经用户明确同意后**，再决定是否用更高权限调用 `acp_prompt` 重试。
- **及时转达提问**：如果返回结果包含 `agent_questions`，先将问题转达给用户，拿到答复后再发回同一 `session_id`。
- **善后清理**：阶段性协作结束后，调用 `acp_close_session` 释放不再需要的会话与资源。

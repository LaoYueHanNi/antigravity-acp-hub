---
name: acp-hub
description: >-
  通过标准 ACP（Agent Client Protocol）协议统一调度本地或自定义的各类编程 Agent / Harness（如 Claude Code、Codex CLI、Gemini CLI、OpenCode、Goose 等），支持多后端连接池、异步任务派发与右侧「ACP 任务台」实时预览、交互式权限审批、有状态多轮会话与跨 Harness 协同。当用户要求调用外部编程 Agent 协助分析、规划、编码、交叉 Review、分发后台任务或管理 ACP 会话时使用。
---

# ACP Hub 通用调度指南

本插件（`acp-hub`）通过内置 MCP 服务维护多后端常驻 ACP 连接池，并提供 **“左配置、右执行”** 双交互面板：
- **左侧全局页「ACP Hub」**：配置与诊断面板（查看启用/禁用状态、安装状态、连接探活、设默认）。
- **右侧扩展栏「ACP 任务台」**：执行监控与副驾工作台（实时流式预览、Plan 步骤、工具时间线、点击文件在侧栏预览、可视化权限审批、直接追问与一键回传主对话）。

所有对外会话 ID 均采用复合格式 `<harness>:<nativeSessionId>`，跨 Harness 唯一且自动路由。

## 可用工具

- `acp_dispatch_task`（推荐主入口，关联右侧「ACP 任务台」）：
  - 传入 `prompt`（及 `cwd` 或已有 `session_id`/`task_id`）→ **异步派发**后台 ACP 任务并立刻返回 `taskId` 与 `sessionId`，同时**自动在右侧打开或更新「ACP 任务台」**进行实时流式预览与交互式审批（默认 `approval_policy: "interactive"`）；
  - 传入空参数 `{}`（或仅传 `task_id`/`session_id`）→ 直接打开或聚焦右侧「ACP 任务台」查看现有任务。
- `acp_wait_task`：阻塞等待指定 `task_id` 进入终态（`completed`/`failed`/`cancelled`）并返回结构化汇报与涉及文件清单；默认 `timeout_seconds: 120`（上限 `150` 以避开宿主 MCP 传输超时），超时仍运行时会明确提示继续调用；可选 `return_on_approval: true` 在进入 `waiting_approval` 时提前返回提醒。
- `acp_open_dashboard`：打开左侧栏「ACP Hub」配置面板并返回全部 Harness 状态快照（所有写配置操作仅对面板 UI 开放）。
- `acp_list_harnesses`：列出全部已配置 Harness、本机安装状态、连接状态与协商能力；传入 `probe: true` 执行 ACP `initialize` 诊断。
- `acp_new_session` / `acp_prompt`：同步创建会话与发送单轮指令（同样自动记录到右侧「ACP 任务台」，适合简短同步任务）。
- `acp_load_session` / `acp_list_sessions` / `acp_cancel` / `acp_close_session`：会话恢复、查询、取消与资源回收。

## 子代理式任务委派工作流（默认推荐）

当用户要求把调研、代码分析、实现、重构或 Review 任务“像子代理一样转给 Claude Code / 其他外部 Agent，并在右侧实时预览、等待回报与持续交互”时，按以下双轨编排执行：

1. **先查状态（若未确认）**：不确定目标 Harness 是否已启用/可用时，先调用 `acp_list_harnesses`，仅选择 `enabled: true && runnable: true` 的 Harness；未安装则转达 `installHint`。
2. **主 Agent 异步派发并拉起右侧任务台**：
   - 在当前主对话直接调用 `acp_dispatch_task`（推荐传入简短清晰的 `title`、绝对路径 `cwd`、`prompt`；除非用户明确要求只读/全自动，保持默认 `approval_policy: "interactive"`）；
   - 工具毫秒级返回 `taskId` 和 `sessionId`，同时自动在当前对话右侧栏打开「ACP 任务台」直播进展。
3. **后台守候自动唤醒回报（需要自动回报主 Agent 时）**：
   - 紧接着通过 `define_subagent`（`EnableMCPTools: true`）或复用已定义的 ACP 守候子代理，使用 `invoke_subagent`（`Model: "flash"`）在后台调用 `acp_wait_task(task_id, timeout_seconds: 120)`（若返回 `wait=timed_out` 且仍在运行则继续循环等待）；
   - **降低转交延迟**：要求守候子代理拿到终态后**直接原样透传** `acp_wait_task` 返回的结构化结果与正文（不要花时间重新改写/二次润色长报告），把唤醒主 Agent 的延迟压至最短；
   - 主 Agent **立刻结束当前轮并将对话交还用户**（主对话完全不阻塞）；用户在右侧任务台可实时围观、随时展开吸顶的「任务计划 / 涉及文件」抽屉预览源码、一键审批权限或直接追问；
   - 任务结束后，守候子代理自动触发 Reactive Wakeup 唤醒主 Agent，交回结构化结论与涉及文件清单；若用户希望零延迟立刻唤醒主对话，也可直接点击右侧底部的 **「回报给主对话」**。
4. **历史任务持久化与重启续聊**：
   - 任务历史自动原子持久化至 `~/.gemini/config/acp-tasks.json`（兼容 `ACP_HUB_TASKS_PATH`），重启 Antigravity 后历史记录、Plan 与涉及文件仍在右侧任务台可见；对支持 ACP `loadSession` 的 Harness（如 Claude Code），在历史任务底部直接追问时服务端会自动恢复会话上下文继续交互。
4. **轻量独立模式（无需后台守候时）**：
   - 若用户只想在右侧自主和外部 Agent 多轮交互，仅调用 `acp_dispatch_task` 即可；用户随时可在右侧任务台点 **「回报给主对话」** 或 **「附为下条上下文」** 将最新成果带回主线。

## 动态权限策略矩阵（每次调用按需传入）

桥接层依据 ACP 标准 `toolCall.kind` 执行跨 Harness 一致的 Fail-Closed 权限审批：

| 场景 | 推荐 `approval_policy` | 放行范围与行为 |
| :--- | :--- | :--- |
| 常规委派 / 右侧副驾协作（`acp_dispatch_task` 默认） | `"interactive"` | 只读/搜索/抓取静默放行；写入、删改与命令执行自动挂起并在右侧「ACP 任务台」置顶弹出审批卡片，由用户人工放行或拒绝（超时自动 Fail-Closed 拒绝） |
| 纯只读调研 / 架构分析 / Code Review（同步调用默认） | `"read_only"` | 仅放行只读、搜索、抓取、思考类操作；直接拦截所有写入、删改与命令执行 |
| 明确允许修改代码（不跑命令、不删文件） | `"accept_edits"` | 放行只读 + 文件编辑；仍拦截 `delete`、`move` 与 `execute` |
| 用户明确授权全自动改代码并运行测试 | `"allow_all"` | 放行本次回合的全部权限请求（优先选 `allow_once` 避免污染后续回合） |
| 严格审计 / 仅对话不执行工具 | `"reject_all"` | 拦截全部工具权限请求并记录 |

## 安全红线与交互原则

- **绝不私自提权**：`interactive` 模式下的人工审批工具 `acp_ui_resolve_approval` 仅对面板 UI 开放（`visibility: ["app"]`），大模型无法代用户点同意。若返回 `denied_permissions`，须先向用户展示被拦截详情，经明确同意后再调整策略重试。
- **及时转达提问**：返回结果包含 `agent_questions` 时，先转达用户或引导用户在右侧任务台追问框回复。
- **善后清理**：阶段性协作完成后，可通过右侧任务台「关闭会话」或调用 `acp_close_session` 释放不再需要的会话资源。

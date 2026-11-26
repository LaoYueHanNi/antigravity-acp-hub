# DR: 采用右侧任务台（aux_pane）与异步任务分发实现子代理式 ACP 协作

Status: implemented

## Problem

在 V1 完成左侧栏全局配置面板后，`acp-hub` 已支持可视化管理 Harness，但任务执行仍停留在 `acp_new_session` / `acp_prompt` 的同步黑盒模式：主 Agent 调用后被阻塞数十秒至数分钟；ACP 实时回传的 `plan`、思考流、工具调用时间线与涉及文件路径全部堆积到回合结束才以纯文本输出；权限控制仅有静态枚举（`read_only` / `accept_edits` / `allow_all` / `reject_all`），缺乏副驾式实时人工审批；也无法像 Antigravity 原生右侧子代理那样完成「分发 → 实时预览与介入 → 持续追问 → 自动或手动回传主对话」的协作闭环。

## Decision

确立“左配置、右执行”的双 MCP App 面板架构，在现有 `acp-hub_bridge` MCP Server 内补齐异步任务管线与交互式权限审批通道：

- **单入口右侧 `aux_pane` 工具（`acp_dispatch_task`）**：注册 `ui://acp-hub/task-pane.html`（`text/html;profile=mcp-app`）并仅由 `acp_dispatch_task` 声明 `entrypoints: [{ type: "aux_pane", title: "ACP 任务台" }]`。全部入参均为可选：从侧栏 `+` 菜单以 `{}` 调用时仅打开/聚焦任务台；携带 `prompt` 调用时后台启动 ACP 回合并立刻返回 `taskId` / `sessionId` 与首屏快照，一步触发右侧面板自动弹出或更新，避免 `+` 菜单出现重复入口。
- **统一 `TaskManager` 与持久化任务历史**：新增 `server/task-manager.mjs` 维护最近 30 个任务的多轮时间线、Plan、涉及文件聚合与单调版本号 `seq`，并通过防抖 + 关键节点原子落盘持久化至 `~/.gemini/config/acp-tasks.json`（兼容 `ACP_HUB_TASKS_PATH`）。重启 Antigravity 后自动恢复历史任务并将未完成回合收敛为 `cancelled`，用户在历史任务追问时若目标 Harness 支持 ACP `loadSession` 则自动恢复会话续聊；旧同步工具 `acp_new_session` / `acp_prompt` 也共用同一录制管线。
- **双轨回报机制与侧栏文件预览**：新增 `acp_wait_task`（默认超时 120s、上限 150s 以避开宿主 MCP 客户端 180s 传输层超时）供轻量后台守候子代理（`EnableMCPTools: true`）分段守候并原样透传终态结果，借助 Antigravity 子代理原生 Reactive Wakeup 自动唤醒主 Agent；同时右侧面板提供吸顶固定「任务计划 / 涉及文件」抽屉、`com.google.antigravity/toggle-aux-pane`（`fileView`）点击文件直达预览、工具调用整组折叠、思考过程持久节点平滑流式贴底、块级增量 Markdown 帧追赶流式渲染（350ms 活跃轮询），以及 `app.sendMessage` / `app.updateModelContext` 一键回传主对话。
- **交互式权限审批与人机隔离（`interactive` / `interactive_edits` 策略）**：`APPROVAL_POLICIES` 新增 `"interactive"` 作为 `acp_dispatch_task` 默认策略：只读工具静默放行，写/删/执行与未知工具将 ACP `session/request_permission` 异步挂起并在右侧面板置顶弹出审批卡片（支持允许本次、本轮放行编辑、本轮全部放行与拒绝）；其中「本轮放行编辑」升级为内部策略 `interactive_edits`，放行同轮后续编辑但仍对命令执行与删除弹窗询问；审批决议工具 `acp_ui_resolve_approval` 与追问/中断/关闭会话工具全部标记 `visibility: ["app"]` 对大模型严格隐藏，挂起审批设置 180 秒 Fail-Closed 超时兜底并在取消/关会话/断连时立即清理。
- **多面板两阶段单文件构建**：升级 `server/scripts/build.mjs` 循环内联打包 `dashboard` 与 `task-pane` 两套前端为静态模块，再统一打包为单一零依赖产物 `dist/mcp-server.mjs`，延续 [基于 MCP Apps 构建左侧栏全局 Harness 管理面板](./2026-11-26-mcp-app-harness-dashboard.md) 的分发架构。

## Alternatives considered

- **把 `acp_dispatch_task` 与 `acp_open_task_pane` 拆成两个工具** —— 若只给 `acp_open_task_pane` 声明 `aux_pane`，主 Agent 派发任务需连续调用两次工具才能打开侧栏；若两者都声明 `aux_pane`，右侧 `+` 菜单会出现重复入口。采用单一 `acp_dispatch_task` 兼容空参数可一次调用完成派发与自动弹栏。
- **引入本地 WebSocket / HTTP Sidecar 推送流** —— 需额外监听端口、处理鉴权与跨平台进程清理。采用 MCP App 内建 `app.callServerTool` + `since_seq` 游标串行轮询（活跃 350ms / 审批等待 900ms / 空闲 4500–10000ms，隐藏暂停）配合前端帧追赶流式缓冲，零端口依赖且严格遵守 `max 4 in-flight` 约束。
- **让 `interactive` 对只读工具也弹窗确认** —— 外部编程 Agent 调研阶段常连续触发数十次 `Read` / `Glob` / `Grep`，逐次弹窗会严重打断体验。采用「只读静默放行 + 非只读强制挂起人工审批」兼顾安全边界与交互流畅度。

## Consequences

- 代价：`dist/mcp-server.mjs` 内嵌双面板自包含 HTML（`dashboard` 604.5 KB、`task-pane` 634.9 KB，总产物 2437.0 KB / 约 2.38 MB，远低于 MCP App 10 MiB 资源上限；进一步压缩面板冷启动耗时的方案已建档于 [深度优化左侧与右侧 MCP App 面板冷启动耗时](../proposed/2026-11-26-mcp-app-panel-startup-performance.md)）；需维护 `~/.gemini/config/acp-tasks.json` 持久化文件的原子读写与最近 30 任务裁剪上限。
- 换来：用户获得对标 Antigravity 原生右侧子代理的外部 ACP Agent 委派体验——主对话不阻塞、右侧实时直播与文件预览、可视化交互审批与直接多轮追问、以及自动唤醒与手动一键回传双轨闭环。

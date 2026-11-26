# DR: 基于 MCP Apps 构建左侧栏全局 Harness 管理面板并实施 App-Only 写权限隔离

Status: implemented

## Problem

用户在日常使用 `acp-hub` 时需要频繁确认本机哪些 ACP Harness 已启用、哪些未安装、当前默认是哪一个，以及随时停用或启用某个 Harness。此前只能手动编辑 `~/.gemini/config/acp-harnesses.json` 或让对话模型调用 `acp_list_harnesses` 查看原始 JSON，既不直观，也无法在不经过模型介入的前提下安全启停 Harness 与即时回收残留子进程。

## Decision

在现有 `acp-hub_bridge` MCP Server 内直接通过标准 **MCP Apps（SEP-1865）** 协议提供可视化管理面板，不额外引入独立后台进程或外部 Web 服务：

- **资源与入口**：注册 `ui://acp-hub/dashboard.html` 资源（MIME：`text/html;profile=mcp-app`）与无必填参数的入口工具 `acp_open_dashboard`，通过 `_meta["com.google.antigravity/ui"].entrypoints` 挂载到 Antigravity 左侧栏全局页（`type: "global"`, `title: "ACP Hub"`）。
- **人机写权限隔离**：将所有修改配置与控制运行态连接的后台工具（`acp_ui_get_state`、`acp_ui_set_harness_enabled`、`acp_ui_set_default_harness`、`acp_ui_probe_harness`、`acp_ui_disconnect_harness`）标记为 `_meta.ui.visibility = ["app"]`。大模型无法发现也无法调用这些工具，从协议层杜绝 AI 私自重新启用被禁用 Harness 或篡改默认项。
- **配置原子持久化与联动断连**：在 `server/harness-registry.mjs` 中新增串行写队列与 `tmp + rename` 原子写回机制，直接读写 `~/.gemini/config/acp-harnesses.json`（兼容 `ACP_HUB_CONFIG` 环境变量），完整保留用户手写的其他字段；当现有文件 JSON 非法时拒绝覆盖以防数据损坏；当用户通过面板禁用某个 Harness 时，同步关闭其活跃会话并销毁常驻连接。
- **两阶段单文件零依赖构建**：在 `server/package.json` 的 `devDependencies` 中引入 `@modelcontextprotocol/ext-apps`（仅构建期使用，不污染运行态依赖），由 `server/scripts/build.mjs` 先用 `esbuild` 将前端打包并内联进 `server/generated/dashboard-html.mjs`，再与服务端一并打入单一产物 `dist/mcp-server.mjs`，延续 [单文件自包含分发](../implemented/2026-11-26-self-contained-plugin-bundle.md) 方案。

## Alternatives considered

- **新增独立 Sidecar Web 服务进程** —— 需要维护额外 HTTP 监听端口、自定义前后端鉴权与插件生命周期管理，增大安装与跨平台排障复杂度，且无法直接复用现有 MCP 连接池与 SEP-1865 标准宿主主题注入能力。
- **把启停配置工具也暴露给大模型（`visibility` 包含 `"model"`）** —— 虽然能让用户口头要求 AI 开关 Harness，但存在提示词注入或模型误操作擅自开启禁用 Harness 的风险；将配置写权收敛为面板人工点击更符合最小权限原则。
- **前端 HTML 作为外部静态文件放在 `dist/dashboard.html` 运行时读取** —— 破坏了 `dist/mcp-server.mjs` 单文件可脱离目录独立运行的极简分发边界；内联嵌入后仅增加数十 KB 体积，隔离目录单文件依然完整可用。
- **首版同时开放 `aux_pane` 对话侧边栏与自定义表单** —— 首版聚焦高频的全局总览、启停开关、默认切换与单卡探测，先仅挂 `global` 入口保持交互简洁，后续可按需扩展 `aux_pane` 与策略编辑抽屉。

## Consequences

- 代价：构建流程从单阶段升级为前端内联 + 服务端打包两阶段，`server/package.json` 的 `devDependencies` 增加 `@modelcontextprotocol/ext-apps`，内联面板 HTML 约 680 KB，使 `dist/mcp-server.mjs` 从约 1.49 MB 增至约 2.18 MB（仍远低于 MCP App 10 MiB 资源上限）；需同步维护 `server/generated/dashboard-html.mjs` 并在修改 UI 后运行 `npm run build`。
- 换来：用户在 Antigravity 左侧栏即可获得跟随宿主亮/暗主题的原生 Harness 管理控制台，零额外进程、零运行态外部依赖、离线可用，并且配置写权限与大模型对话路径严格隔离。

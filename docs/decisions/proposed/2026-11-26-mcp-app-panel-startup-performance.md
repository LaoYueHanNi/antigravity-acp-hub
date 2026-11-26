# DR: 深度优化左侧与右侧 MCP App 面板冷启动耗时

Status: proposed

## Problem

在完成第一轮启动优化（PATH 60s 缓存与启动预热、剔除 `@modelcontextprotocol/client` 无关死代码、0ms 静态骨架屏、砍掉首屏 250ms 空等、`dist/mcp-server.mjs` 压缩瘦身至 2437.0 KB）后，服务端工具与资源读取响应已降至毫秒级（实测 `acp_open_dashboard` 4.3 ms、`acp_dispatch_task` 0.9 ms、`resources/read` 7.7–10.8 ms），但用户在 Antigravity 中实际打开左侧「ACP Hub」全局页与右侧「ACP 任务台」时，体感冷启动仍然明显偏慢。

当前已知但尚未彻底解决的两大结构性因素：

1. **前端单页 HTML 仍高达 604.5 KB / 634.9 KB**：业务代码本身仅占约 25–40 KB，其余约 **585 KB** 全部来自 `@modelcontextprotocol/ext-apps` v2.0.4 静态引入的 `zod/v4` 与 `@modelcontextprotocol/core/schemas` 全量协议校验定义；每次打开面板均需经 stdio 搬运、序列化/反序列化，并在隔离源 iframe 中冷解析与初始化大量 Zod Schema。
2. **缺乏端到端分段耗时基线**：尚未在真实 Antigravity 宿主内对「点击入口 → 宿主创建隔离 iframe → `resources/read` 注入 HTML → JS 冷解析与 `zod` 初始化 → `ui/initialize` 握手 → 首屏数据渲染」各阶段做精确毫秒打点，无法确认瓶颈主要落在 JS 包体解析还是宿主创建隔离 WebView/iframe 本身。

本提案先将深度优化建档搁置，待核心任务台功能复测与收敛后再专题推进。

## Proposal

分四步开展有数据支撑的冷启动深度优化：

1. **补齐端到端分段打点（诊断先行）**：在面板内通过 `performance.now()` / `PerformanceNavigationTiming` 采集 `scriptStart`、`connectStart`、`connectDone`、`firstToolResult`、`firstMeaningfulRender` 五个关键时间戳（仅调试开关开启时在界面角标或控制台展示），明确区分「插件包体解析耗时」与「Antigravity 宿主创建隔离 iframe 固有耗时」。
2. **攻克 ~585 KB SDK 体积瓶颈**：
   - 跟踪 `@modelcontextprotocol/ext-apps` 上游轻量化发布（去 `zod/v4` 强依赖或按需拆包）；
   - 若上游短期未瘦身且打点证实 JS 冷解析占启动大头，评估在遵循 SEP-1865 规范前提下，于构建期对未使用的 Zod Schema 做裁剪或封装经合约测试覆盖的极简校验适配层，目标将单页 HTML 从 ~620 KB 压至 `< 100 KB`。
3. **验证首屏数据与 HTML 同帧直出**：调研 Antigravity 打开 `global` / `aux_pane` 时 `resources/read` 与入口工具调用的先后时序，在确保不引入陈旧状态回滚的前提下，评估 `resources/read` 内联轻量首屏快照以消除额外握手后 RPC 往返。
4. **评估双面板共享打包结构**：结合 [采用右侧任务台（aux_pane）与异步任务分发实现子代理式 ACP 协作](../implemented/2026-11-26-acp-task-pane-and-async-delegation.md) 与 [基于 MCP Apps 构建左侧栏全局 Harness 管理面板](../implemented/2026-11-26-mcp-app-harness-dashboard.md)，评估当插件拥有多个 MCP App 视图时，通过单 HTML 多视图路由或更轻运行时避免在 `dist/mcp-server.mjs` 中重复内联多份完整 SDK。

## Alternatives considered

- **立即手写 `postMessage` 桥接替换 `@modelcontextprotocol/ext-apps`** —— 虽能立刻将单页 HTML 降至 ~30–50 KB，但违背 Antigravity MCP App 开发规范，容易在宿主升级 SEP-1865 协议版本、`ping` 心跳、主题变量注入或 `toggle-aux-pane` 扩展时产生隐蔽兼容问题；在尚未打点确认 JS 解析确为主要瓶颈前贸然手写桥接风险收益比不佳。
- **改用独立本地 Sidecar HTTP 服务承载面板** —— 可利用浏览器缓存避免重复传输 HTML，但需维护本地端口、前后端鉴权与跨平台进程生命周期，破坏零额外进程与单文件零依赖分发架构，见 [基于 MCP Apps 构建左侧栏全局 Harness 管理面板](../implemented/2026-11-26-mcp-app-harness-dashboard.md)。
- **在首轮优化阶段继续盲目微调 CSS 或轮询间隔** —— 服务端与业务脚本耗时已低于 15 ms，继续微调业务层边际收益接近零，必须先用真实宿主分段打点锁定根因。

## Acceptance criteria

- 在真实 Antigravity 宿主中取得左右两面板冷启动各阶段毫秒级耗时分解数据，明确「宿主框架开销」与「插件自身开销」占比；
- 插件自身可优化的冷启动耗时较当前基线下降 ≥ 50%（若确认为 SDK 体积瓶颈，单页 HTML 体积降至 `< 100 KB`）；
- `cd server && npm run check && npm run build && npm test` 全量通过，且左右两面板在 Antigravity 亮/暗主题切换、App-Only 工具调用、`toggle-aux-pane` 文件预览与 `sendMessage` / `updateModelContext` 均无协议回归。

## Risks

- **宿主物理天花板风险**：若分段打点证实主要耗时来自 Antigravity 每次打开 MCP App 时创建独立隔离源 WebView/iframe 进程本身，则插件侧优化空间存在硬上限，需接受该基线或向平台侧反馈。
- **上游升级兼容风险**：若采用构建期对 `@modelcontextprotocol/ext-apps` 做深度裁剪，升级 SDK 版本时可能破坏构建插件假设，必须以端到端 MCP App 握手测试兜底。
- **主动放弃项**：本阶段暂不为了追求极限首屏速度而放弃标准 MCP Apps 架构或引入常驻 HTTP Sidecar 进程。

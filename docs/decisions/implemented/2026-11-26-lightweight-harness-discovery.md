# DR: 核心包不捆绑厂商适配器，采用跨平台自动发现与用户配置覆盖

Status: implemented

## Problem

原型阶段在 `server/package.json` 中直接依赖 `@agentclientprotocol/claude-agent-acp`，实际测得其传递依赖 `@anthropic-ai/claude-agent-sdk` 高达 409.91 MB（总 `server/node_modules` 达 436.39 MB）。本项目计划开源并演进为通用多 Harness ACP 调度插件，如果继续把各家厂商的 ACP 适配器（如 Claude、Codex 等）内嵌进核心依赖，会导致插件安装包膨胀、与单厂商发布周期强绑定，且迫使不需要某款 CLI 的用户承担冗余下载。

## Decision

核心服务端（`server/package.json`）仅保留轻量的协议层依赖（`@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`zod`），将 `server/node_modules` 控制在约 21.6 MB。

在 `server/harness-registry.mjs` 中实现厂商中立的预设注册表与多级自动发现机制：

- 内置 `claude`、`codex`、`gemini`、`opencode`、`goose` 五个预设，不硬编码任何单机绝对路径。
- 启动解析顺序为：用户配置显式 `command`/`args` → 本机 PATH 命令或可选本地 `server/node_modules` 包 → 仅当用户显式设置 `allowNpxFallback: true` 时回退到 `npx -y`。
- 支持 `~/.gemini/config/acp-harnesses.json`（可通过环境变量 `ACP_HUB_CONFIG` 覆盖）按 `harnessId` 深度合并并按文件 mtime 热重载，允许用户覆盖预设参数、禁用预设或新增任意自定义 ACP Agent。
- 针对 Windows 平台的 npm 全局 `.cmd` shim，优先提取真实 JS 入口并直接以 `node` 拉起，避免 `cmd.exe` 包装带来的参数转义与残留进程问题。

## Alternatives considered

- **全量内嵌主流厂商适配器** —— 仅内嵌一家即引入 400 MB+ 体积，多家并存将迅速膨胀且每次厂商 CLI 升级都需要同步发布插件版本，违背轻量开源定位。
- **未安装本地命令时默认静默走 `npx -y`** —— 首次调用可能在无网或弱网环境下静默下载数百 MB 依赖导致长时间挂起，体验不可控；因此改为默认返回明确 `installHint`，仅允许用户在配置中主动开启 `allowNpxFallback`。

## Consequences

- 代价：用户需要自行通过包管理器或官方渠道安装所选 Harness 的 CLI / ACP 适配器（如 `npm i -g @agentclientprotocol/claude-agent-acp` 或 `@agentclientprotocol/codex-acp`），`acp_list_harnesses` 需承担安装诊断与引导职责。
- 换来：插件核心体积缩小约 95%（436.39 MB → 21.64 MB），完全不绑定特定本机环境，用户可随时独立升级各家 CLI 或零改代码接入任意自定义 ACP Agent。

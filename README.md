# ACP Hub for Antigravity (`antigravity-acp-hub`)

本项目是一个轻量、开源、厂商中立的 Antigravity 插件（插件名 `acp-hub`），通过标准 **Agent Client Protocol (ACP)** 协议作为通用桥接层，让 Antigravity 能够以**有状态、多轮会话、多后端连接池、跨 Harness 统一权限控制**的方式，统一调度本机或自定义的各类兼容 ACP 的编程 Agent / Harness（如 Claude Code、Codex CLI、Gemini CLI、OpenCode、Goose 等）。

## 快速安装（开箱即用，无需 `npm install`）

本仓库已内置由 `esbuild` 构建的零依赖自包含服务端产物 `dist/mcp-server.mjs`，终端用户只需本机已安装 Node.js (≥ 20)，即可通过 Antigravity 官方方式直接安装：

### 方式一：通过 Antigravity CLI 从 GitHub 一键安装（推荐）

```bash
agy plugin install https://github.com/<你的用户名>/antigravity-acp-hub
```

### 方式二：从本地目录安装或开发联调

```bash
# 使用 Antigravity CLI
agy plugin install ./antigravity-acp-hub

# 或使用仓库自带的校验与安装脚本（Windows 默认目录联接 junction，可选 --mode copy）
node scripts/install-plugin.mjs
```

### 方式三：团队项目级共享

将插件目录放置于项目 `.agents/plugins/acp-hub/` 或在 `.agents/plugins.json` 中引用，团队成员打开仓库即可自动加载。

---

## 核心特性

- **零依赖开箱分发**：发布产物 `dist/mcp-server.mjs` 已打包核心协议依赖（`@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`zod`），`mcp_config.json` 使用 `${PLUGIN_ROOT}` 定位，在只读插件目录下直接启动。
- **厂商中立、不捆绑重量级适配器**：内置 5 个主流 Harness 预设并通过 PATH 自动发现本机已安装的适配器/CLI，不捆绑数百 MB 的厂商私有 SDK。
- **配置化 Harness 注册表**：支持 `~/.gemini/config/acp-harnesses.json`（或环境变量 `ACP_HUB_CONFIG`）热加载，自由覆盖预设参数、禁用预设或注册任意自定义本地 ACP Agent。
- **多后端常驻连接池与复合路由**：不同 Harness 各自维护惰性常驻进程，统一使用 `<harness>:<nativeSessionId>` 复合会话 ID 自动路由；同会话串行锁防并发串线，跨会话/跨 Harness 完全并行。
- **协议能力协商与优雅降级**：支持 `acp_list_harnesses(probe=true)` 握手诊断，自动缓存各 Harness 的 `agentCapabilities`，对不支持 `loadSession`、`session/list`、`additionalDirectories`、`set_mode` 等能力的后端返回清晰提示。
- **跨 Harness 一致的 Fail-Closed 权限控制**：优先依据 ACP 标准 `toolCall.kind` 判定，支持每次调用动态指定 `read_only`（默认）、`accept_edits`、`allow_all`、`reject_all`，并将所有拦截操作汇报给 Antigravity 交由用户确认。
- **可选 Client 端 `fs` / `terminal` 代理**：默认对自带工具链的预设关闭；可为极简自定义 ACP Agent 按需开启，严格受工作区路径白名单与 `approval_policy` 双重约束。

## 目录结构

```text
antigravity-acp-hub/
├── assets/
│   └── logo.svg                   # 1:1 方形插件图标
├── dist/
│   └── mcp-server.mjs             # 零依赖自包含单文件构建产物（由 npm run build 生成）
├── docs/
│   ├── 现状与开发规划.md            # 架构说明与演进记录
│   └── decisions/                 # 架构决策记录（ADR）与校验脚本
├── scripts/
│   └── install-plugin.mjs         # 本地校验与安装脚本（junction / symlink / copy）
├── server/
│   ├── package.json               # 服务端依赖与构建/测试脚本
│   ├── scripts/build.mjs          # esbuild 单文件打包脚本
│   ├── index.mjs                  # MCP Server 入口与 7 个 acp_* 工具定义
│   ├── acp-hub.mjs                # 多后端连接池与复合会话路由器
│   ├── acp-connection.mjs         # 单 Harness ACP 子进程连接与能力缓存
│   ├── harness-registry.mjs       # 内置预设、用户配置合并与跨平台命令解析
│   ├── permission-policy.mjs      # 跨 Harness 通用权限判定与路径白名单
│   ├── client-capabilities.mjs    # 可选 Client 端 fs / terminal 安全代理
│   └── test/                      # Mock ACP Agent 自动化单测 + 真实冒烟脚本
├── skills/
│   └── acp-hub/
│       └── SKILL.md               # Antigravity 多 Harness 调度指南
├── plugin.json                    # Antigravity 插件清单（name: acp-hub）
├── mcp_config.json                # Antigravity 插件 MCP 启动配置（使用 ${PLUGIN_ROOT}）
└── README.md
```

## 内置 Harness 预设与安装提示

插件开箱内置以下 5 个预设（自动检测本机 PATH；未安装时会通过 `acp_list_harnesses` 返回安装提示）：

| Harness ID | 目标 Agent | 默认自动发现命令 / 适配器 | 安装参考 |
| :--- | :--- | :--- | :--- |
| `claude` | Claude Code | `claude-agent-acp` → 本地包 → `claude-code-acp` | `npm i -g @agentclientprotocol/claude-agent-acp` |
| `codex` | Codex CLI | `codex-acp` → 本地包 | `npm i -g @agentclientprotocol/codex-acp` |
| `gemini` | Gemini CLI | `gemini --acp` | `npm i -g @google/gemini-cli` |
| `opencode` | OpenCode | `opencode acp` | https://opencode.ai |
| `goose` | Goose | `goose acp` | https://block.github.io/goose |

## 用户级自定义配置（可选）

创建 `~/.gemini/config/acp-harnesses.json`（或通过 `ACP_HUB_CONFIG` 指定路径），支持热重载：

```json
{
  "defaultHarness": "claude",
  "harnesses": {
    "codex": {
      "allowNpxFallback": true
    },
    "goose": {
      "enabled": false
    },
    "my-custom-acp": {
      "displayName": "我的自定义 ACP Agent",
      "command": "node",
      "args": ["/abs/path/to/my-acp-agent.mjs"],
      "env": { "LOG_LEVEL": "info" },
      "defaultApprovalPolicy": "read_only",
      "clientCapabilities": {
        "fs": true,
        "terminal": false
      }
    }
  }
}
```

## 开发者构建与验证

```bash
# 1. 安装开发与构建依赖
cd server
npm install

# 2. 语法检查、重新打包 dist/mcp-server.mjs 并运行全套测试（含无 node_modules 隔离启动测试）
npm run check
npm run build
npm test

# 3. 决策记录与本地插件校验
cd ..
node docs/decisions/check.mjs
node scripts/install-plugin.mjs --dry-run

# 4. 本机真实 Harness 只读冒烟测试（可选指定 HARNESS=claude）
cd server && node test/smoke-real-harness.mjs
```

详细架构与迭代进度请参见 [现状与开发规划](docs/现状与开发规划.md)。

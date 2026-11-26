# Antigravity ACP 通用调度插件（`antigravity-acp-hub`）

本项目是一个轻量、开源、厂商中立的 Antigravity 插件，通过标准 **Agent Client Protocol (ACP)** 协议作为通用桥接层，让 Antigravity 能够以**有状态、多轮会话、多后端连接池、跨 Harness 统一权限控制**的方式，统一调度本机或自定义的各类兼容 ACP 的编程 Agent / Harness（如 Claude Code、Codex CLI、Gemini CLI、OpenCode、Goose 等）。

## 核心特性

- **极简轻量、厂商中立**：核心服务端仅依赖 `@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk` 与 `zod`，不捆绑数百 MB 的厂商私有适配器；内置 5 个主流 Harness 预设并通过 PATH 自动发现本机已安装的适配器/CLI。
- **配置化 Harness 注册表**：支持 `~/.gemini/config/acp-harnesses.json`（或环境变量 `ACP_HUB_CONFIG`）热加载，自由覆盖预设参数、禁用预设或注册任意自定义本地 ACP Agent。
- **多后端常驻连接池与复合路由**：不同 Harness 各自维护惰性常驻进程，统一使用 `<harness>:<nativeSessionId>` 复合会话 ID 自动路由；同会话串行锁防并发串线，跨会话/跨 Harness 完全并行。
- **协议能力协商与优雅降级**：支持 `acp_list_harnesses(probe=true)` 握手诊断，自动缓存各 Harness 的 `agentCapabilities`，对不支持 `loadSession`、`session/list`、`additionalDirectories`、`set_mode` 等能力的后端返回清晰提示。
- **跨 Harness 一致的 Fail-Closed 权限控制**：优先依据 ACP 标准 `toolCall.kind` 判定，支持每次调用动态指定 `read_only`（默认）、`accept_edits`、`allow_all`、`reject_all`，并将所有拦截操作汇报给 Antigravity 交由用户确认。
- **可选 Client 端 `fs` / `terminal` 代理**：默认对自带工具链的预设关闭；可为极简自定义 ACP Agent 按需开启，严格受工作区路径白名单与 `approval_policy` 双重约束。

## 目录结构

```text
antigravity-acp-hub/
├── docs/
│   └── 现状与开发规划.md          # 架构说明与演进记录
├── scripts/
│   └── install-plugin.mjs        # 一键校验与本地安装脚本（junction / copy）
├── server/
│   ├── package.json              # 轻量核心依赖声明
│   ├── index.mjs                 # MCP Server 入口与 7 个 acp_* 工具定义
│   ├── acp-hub.mjs               # 多后端连接池与复合会话路由器
│   ├── acp-connection.mjs        # 单 Harness ACP 子进程连接与能力缓存
│   ├── harness-registry.mjs      # 内置预设、用户配置合并与跨平台命令解析
│   ├── permission-policy.mjs     # 跨 Harness 通用权限判定与路径白名单
│   ├── client-capabilities.mjs   # 可选 Client 端 fs / terminal 安全代理
│   └── test/
│       ├── mock-acp-agent.mjs    # 可配置 Mock ACP Agent（测试替身）
│       ├── acp-hub.test.mjs      # 单元 + MCP 端到端自动化测试套件
│       └── smoke-real-harness.mjs # 本机真实 Harness 只读冒烟测试
├── skills/
│   └── acp-hub/
│       └── SKILL.md              # Antigravity 多 Harness 调度指南
├── plugin.json                   # Antigravity 插件清单
├── mcp_config.json               # Antigravity 插件 MCP 启动配置
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

## 开发验证与安装

```bash
# 1. 安装核心依赖（极简轻量）
cd server
npm install

# 2. 语法检查与全套自动化测试（Mock ACP Agent + MCP 端到端）
npm run check
npm test

# 3. 本机真实 Harness 只读冒烟测试（可选指定 HARNESS=claude）
node test/smoke-real-harness.mjs

# 4. 校验并安装到 Antigravity 本地插件目录（默认 junction 联接，或 --mode copy）
cd ..
node scripts/install-plugin.mjs
```

详细架构与迭代进度请参见 [现状与开发规划](docs/现状与开发规划.md)。

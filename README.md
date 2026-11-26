# ACP Hub for Antigravity (`antigravity-acp-hub`)

本项目是一个轻量、开源、厂商中立的 Antigravity 插件（插件名 `acp-hub`，当前版本 `v2.1.0`），通过标准 **Agent Client Protocol (ACP)** 协议作为通用桥接层，结合 MCP Apps 交互面板，让 Antigravity 以 **“左配置、右执行”** 的子代理级体验，统一调度本机或自定义的各类兼容 ACP 的编程 Agent / Harness（如 Claude Code、Codex CLI、Gemini CLI、OpenCode、Goose 等）。

## 快速安装（开箱即用，无需 `npm install`）

本仓库已内置由 `esbuild` 构建的零依赖自包含服务端产物 `dist/mcp-server.mjs`（内联协议依赖与双面板 UI），终端用户只需本机已安装 Node.js (≥ 20)，即可通过 Antigravity 官方方式直接安装：

### 方式一：通过 Antigravity CLI 从 GitHub 一键安装（推荐）

```bash
agy plugin install https://github.com/LaoYueHanNi/antigravity-acp-hub
```

### 方式二：从本地目录安装或开发联调

```bash
# 使用 Antigravity CLI
agy plugin install ./antigravity-acp-hub

# 或使用仓库自带的校验与安装脚本（默认物理拷贝 copy，自动排除 node_modules 与 .git）
node scripts/install-plugin.mjs
```

### 方式三：团队项目级共享

将插件目录放置于项目 `.agents/plugins/acp-hub/` 或在 `.agents/plugins.json` 中引用，团队成员打开仓库即可自动加载。

---

## 核心特性

### 1. 左配置、右执行：原生 MCP Apps 双面板体验

- **左侧全局页「ACP Hub」**（`ui://acp-hub/dashboard.html`）：
  - 一览所有内置预设与自定义 Harness 的本机安装状态、连接状态与协商能力。
  - 支持直接启用/禁用 Harness、切换默认调度目标、一键执行 ACP `initialize` 协议握手探测。
- **右侧扩展栏「ACP 任务台」**（`ui://acp-hub/task-pane.html`）：
  - **异步派发与流式预览**：支持后台异步启动任务并自动唤起右侧任务台，实时流式呈现外部 Agent 的思考过程、工具调用记录与 Markdown 回复。
  - **吸顶任务计划与文件直达预览**：顶部固定汇总任务计划（Plan）与涉及文件列表，点击文件可直接调用 Antigravity 侧栏源码预览。
  - **人机交互式审批（Human-in-the-Loop）**：使用 `interactive` 权限策略时，只读操作静默放行，写文件/执行命令等敏感动作自动挂起并置顶弹出审批卡片（支持「允许本次 / 本轮放行编辑 / 本轮全部放行 / 拒绝」与倒计时自动 Fail-Closed）。
  - **多轮直接追问与一键回传**：用户可在右侧面板直接对任一外部 Agent 连续追问、取消或结束会话，并一键「回报给主对话」或「附为下条上下文」。
  - **本地任务历史持久化与跨重启续聊**：任务状态原子持久化至 `~/.gemini/config/acp-tasks.json`，宿主重启后自动恢复历史轨迹，并在继续派发/追问时自动通过 ACP `loadSession` 断点续聊。

### 2. 轻量中立的多后端 ACP 桥接核心

- **零依赖开箱分发**：发布产物 `dist/mcp-server.mjs` 已打包核心协议依赖（`@agentclientprotocol/sdk`、`@modelcontextprotocol/sdk`、`zod`）与双面板静态资源，`mcp_config.json` 使用 `${PLUGIN_ROOT}` 定位，在只读插件目录下直接运行。
- **厂商中立、不捆绑重量级适配器**：内置 5 个主流 Harness 预设并通过 PATH 自动发现本机已安装的适配器/CLI（内置 60s 缓存与启动后台预热），不捆绑数百 MB 的厂商私有 SDK。
- **多后端常驻连接池与复合路由**：不同 Harness 各自维护惰性常驻进程，统一使用 `<harness>:<nativeSessionId>` 复合会话 ID 自动路由；同会话串行锁防并发串线，跨会话/跨 Harness 完全并行。
- **跨 Harness 一致的 Fail-Closed 权限控制**：优先依据 ACP 标准 `toolCall.kind` 判定，支持每次调用动态指定 `read_only`（默认）、`interactive`、`accept_edits`、`allow_all`、`reject_all`；全部 11 个面板控制工具严格限定 `visibility: ["app"]`，防止模型绕过人工审批。
- **可选 Client 端 `fs` / `terminal` 代理**：默认对自带工具链的预设关闭；可为极简自定义 ACP Agent 按需开启，严格受工作区路径白名单与 `approval_policy` 双重约束。

---

## MCP 工具概览

服务端共提供 **10 个主模型可见工具**（及 11 个仅面板可见的 `acp_ui_*` App-Only 内部控制工具）：

| 工具名 | 作用 |
| :--- | :--- |
| `acp_open_dashboard` | 打开左侧全局页「ACP Hub」管理面板 |
| `acp_dispatch_task` | 异步派发外部 Harness 任务并唤起右侧「ACP 任务台」（支持复用已有任务跨重启续聊） |
| `acp_wait_task` | 分段阻塞等待异步任务完成或挂起等待审批（默认 120s，上限 150s） |
| `acp_list_harnesses` | 列出所有已配置 Harness、安装状态、连接状态与能力协商结果 |
| `acp_new_session` | 在指定 Harness 中创建新的有状态 ACP 会话 |
| `acp_prompt` | 在已有会话中同步发送一轮消息并返回结构化结果 |
| `acp_load_session` | 在支持 `loadSession` 的 Harness 中恢复历史会话 |
| `acp_list_sessions` | 列出当前活跃会话（可选查询后端持久化会话） |
| `acp_cancel` | 中断正在运行中的 ACP 会话回合 |
| `acp_close_session` | 关闭会话并回收关联终端资源 |

---

## 目录结构

```text
antigravity-acp-hub/
├── assets/
│   └── logo.svg                   # 1:1 方形插件图标
├── dist/
│   └── mcp-server.mjs             # 零依赖自包含单文件构建产物（由 npm run build 生成）
├── docs/
│   ├── 现状与开发规划.md            # 架构说明与阶段演进记录
│   └── decisions/                 # 架构决策记录（ADR）与零依赖校验脚本
├── scripts/
│   └── install-plugin.mjs         # 本地校验与安装脚本（copy / junction / symlink）
├── server/
│   ├── package.json               # 服务端依赖与构建/测试脚本
│   ├── scripts/build.mjs          # esbuild 多面板内联 + 单文件打包脚本
│   ├── index.mjs                  # MCP Server 入口与全部 acp_* 工具定义
│   ├── acp-hub.mjs                # 多后端连接池、复合会话路由器与异步任务协同
│   ├── acp-connection.mjs         # 单 Harness ACP 子进程连接与能力缓存
│   ├── task-manager.mjs           # 异步任务状态机、原子持久化与审批挂起队列
│   ├── harness-registry.mjs       # 内置预设、用户配置合并与跨平台命令解析（带缓存）
│   ├── permission-policy.mjs      # 跨 Harness 通用权限判定、Diff 预览提取与路径白名单
│   ├── client-capabilities.mjs    # 可选 Client 端 fs / terminal 安全代理
│   ├── dashboard-resource.mjs     # 左侧「ACP Hub」MCP App 资源与 App-Only 工具
│   ├── task-pane-resource.mjs     # 右侧「ACP 任务台」MCP App 资源与 App-Only 工具
│   ├── ui/                        # 左侧管理面板与右侧任务台前端源码（HTML/JS）
│   ├── generated/                 # 构建生成的单文件内联 HTML 模块
│   └── test/                      # Mock ACP Agent 自动化单测 + 真实冒烟脚本
├── skills/
│   └── acp-hub/
│       └── SKILL.md               # Antigravity 多 Harness 调度与子代理协同指南
├── plugin.json                    # Antigravity 插件清单（name: acp-hub）
├── mcp_config.json                # Antigravity 插件 MCP 启动配置（使用 ${PLUGIN_ROOT}）
├── LICENSE                        # MIT 开源许可证
└── README.md
```

## 内置 Harness 预设与安装提示

插件开箱内置以下 5 个预设（自动检测本机 PATH；未安装时会在左侧面板与 `acp_list_harnesses` 中给出安装提示）：

| Harness ID | 目标 Agent | 默认自动发现命令 / 适配器 | 安装参考 |
| :--- | :--- | :--- | :--- |
| `claude` | Claude Code | `claude-agent-acp` → 本地包 → `claude-code-acp` | `npm i -g @agentclientprotocol/claude-agent-acp` |
| `codex` | Codex CLI | `codex-acp` → 本地包 | `npm i -g @agentclientprotocol/codex-acp` |
| `gemini` | Gemini CLI | `gemini --acp` | `npm i -g @google/gemini-cli` |
| `opencode` | OpenCode | `opencode acp` | https://opencode.ai |
| `goose` | Goose | `goose acp` | https://block.github.io/goose |

## 用户级自定义配置（可选）

除了通过左侧「ACP Hub」面板可视化开关外，也可以直接编辑 `~/.gemini/config/acp-harnesses.json`（或通过 `ACP_HUB_CONFIG` 指定路径），支持热重载：

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

> 任务历史默认持久化在 `~/.gemini/config/acp-tasks.json`（可通过环境变量 `ACP_HUB_TASKS_PATH` 覆盖）。

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

详细架构与迭代进度请参见 [现状与开发规划](docs/现状与开发规划.md) 及 [架构决策记录](docs/decisions/README.md)。

## 开源许可

本项目采用 [MIT License](LICENSE) 开源。

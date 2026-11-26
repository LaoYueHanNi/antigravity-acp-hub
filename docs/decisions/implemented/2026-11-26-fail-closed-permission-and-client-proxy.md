# DR: 跨 Harness Fail-Closed 权限判定与默认关闭的受限 Client 代理

Status: implemented

## Problem

原原型中的权限审批回调强依赖 Claude Code 私有字段 `_meta.claudeCode.toolName` 与硬编码的 Claude 工具名集合，迁移到多 Harness 环境后会失效或误判。此外，绝大多数主流 CLI（Claude Code、Codex CLI、Gemini CLI、OpenCode、Goose）自带完整的文件与终端工具链，但部分极简自定义 ACP Agent 可能依赖 Client 端提供 `fs/*` 与 `terminal/*` 能力；如何在支持异构 Harness 的同时确保跨后端一致的最小权限边界，避免越权修改、误删文件或路径穿越，是通用化的核心安全命题。

## Decision

在 `server/permission-policy.mjs` 中实现厂商中立的 Fail-Closed 权限判定：

- 权限审批（`decideApprovalOption`）以 ACP 标准 `toolCall.kind` 为第一优先级；仅当 `kind` 缺失或为 `other` 时，才回退到跨 Harness 的保守只读/编辑工具名白名单，所有未知类型与未知工具一律默认拒绝。
- 四档 `approval_policy` 行为跨后端保持一致：`read_only`（默认）仅放行 `read`/`search`/`fetch`/`think`；`accept_edits` 在此基础上放行 `edit`，仍拦截 `delete`、`move` 与 `execute` 并写入 `deniedPermissions` 交由用户确认；`allow_all` 放行全部请求且优先选择 `allow_once` 而非 `allow_always`，防止单次提权固化并污染后续回合；`reject_all` 全部拦截。

在 `server/client-capabilities.mjs` 中实现按需开启的受限 Client 代理：

- 所有内置预设默认关闭 `clientCapabilities.fs` 与 `clientCapabilities.terminal`，仅当用户在 Harness 配置中显式开启时才在 `initialize` 阶段声明并挂载处理器。
- `fs/read_text_file`、`fs/write_text_file` 与 `terminal/*` 均受双层门禁约束：`approval_policy`（`fs_read` 需非 `reject_all`、`fs_write` 需 `accept_edits`/`allow_all`、`terminal` 仅 `allow_all`）以及基于 `realpathSync` 符号链接解析的工作区路径白名单（`session.cwd` + `additionalDirectories`）；会话关闭或连接断开时自动清理所有残留终端进程。

## Alternatives considered

- **为每个 Harness 单独维护私有工具名与 `_meta` 映射表** —— 每接入一款新 Agent 都需要硬编码维护规则，且上游工具改名即可导致静默失效或越权放行。
- **在 `accept_edits` 策略下同时放行 `delete` 与 `move`** —— 删除文件与批量移动目录属于高风险破坏性变更，误操作恢复成本高于单文件编辑，保留给用户二次确认更符合最小权限原则。
- **对所有 Harness 默认开启 Client 端 `fs`/`terminal` 代理** —— 自带工具链的 Harness 可能在本地工具与 Client 代理之间产生行为歧义或扩大攻击面，默认关闭、按需开启更安全清晰。

## Consequences

- 代价：若某个自定义 ACP Agent 既未按标准填写 `toolCall.kind` 又使用了非常规只读工具名，在 `read_only` 下会被保守拦截，需经用户确认后放行；极简 Agent 需在配置中显式声明 `clientCapabilities` 才能使用 Client 代理。
- 换来：所有兼容 ACP 的 Harness 共享同一套可预测的安全边界与拦截汇报格式，杜绝单次提权泄漏与工作区路径逃逸。

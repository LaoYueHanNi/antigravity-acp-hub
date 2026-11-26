# DR: 插件分发采用 esbuild 单文件自包含构建与 ${PLUGIN_ROOT} 路径变量

Status: implemented

## Problem

Antigravity 通过 `agy plugin install <GitHub URL>` 或 Marketplace 安装插件时，会将插件直接解包到只读目录 `~/.gemini/config/plugins/<plugin-name>/`，且**不会**替用户执行 `npm install`。如果 `mcp_config.json` 指向依赖 `server/node_modules/` 的源码入口 `server/index.mjs`（且仓库 `.gitignore` 排除了 `node_modules/`），终端用户安装后会立刻因找不到 `@modelcontextprotocol/sdk` 与 `@agentclientprotocol/sdk` 而无法启动。同时，使用裸相对路径在 MCP 启动目录不固定时也存在路径解析风险；且官方 Marketplace 命名规范禁止插件 `name` / `displayName` 以 `"Antigravity"` 开头。

## Decision

建立面向 GitHub 与 Marketplace 一键安装的零依赖分发机制：

- 在 `server/package.json` 的 `devDependencies` 中引入 `esbuild`，新增 `server/scripts/build.mjs`（`npm run build`），将 `server/index.mjs` 及其轻量协议依赖打包为单个自包含 ESM 文件 `dist/mcp-server.mjs`（内嵌 `createRequire` 垫片兼容间接 CJS 调用）并随仓库分发。
- `mcp_config.json` 的服务键设为 `bridge`，通过 Antigravity 官方路径变量 `${PLUGIN_ROOT}/dist/mcp-server.mjs` 启动，确保在只读插件目录及任意工作目录下都能零依赖离线运行。
- `plugin.json` 按官方 JSON Schema 与预发布规范收敛为 `name: "acp-hub"`、`displayName: "ACP Hub for Antigravity"`，补充 `$schema`、`license`、`keywords` 与 1:1 矢量图标 `assets/logo.svg`。
- 在 `server/test/acp-hub.test.mjs` 中新增隔离目录端到端测试，把 `dist/mcp-server.mjs` 拷贝至不含任何 `node_modules` 的临时目录并完整验证 MCP 启动与会话调用。

## Alternatives considered

- **将服务端发布到 npm 并在 `mcp_config.json` 使用 `npx -y`** —— 虽无需在仓库提交构建产物，但首次启动强依赖外网访问与 npm 下载速度，在离线或受限企业网络下体验不佳，且增加额外的 npm 发布维护链路。
- **把整个 `server/node_modules/` 提交进 Git 仓库** —— 产生数千个碎片文件、约 21 MB 冗余体积与平台相关噪声，严重污染代码评审与克隆速度。
- **保留原始相对路径并要求用户手动 `git clone` + `npm install`** —— 违背 Antigravity 插件 `agy plugin install` 与 Marketplace 一键安装体验。

## Consequences

- 代价：修改 `server/` 源码后需要执行 `cd server && npm run build` 同步更新 `dist/mcp-server.mjs`（已在 `AGENTS.md` 中固化为提交前必跑检查），仓库内新增约 1 MB 左右的单文件构建产物。
- 换来：用户通过 `agy plugin install <GitHub URL>` 或 Marketplace 安装后无需 `npm install`、无需联网下载即可离线秒启，同时满足 Antigravity 官方插件校验与上架规范。

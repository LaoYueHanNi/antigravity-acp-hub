# 项目协作规范

- 核心服务端位于 `server/`，分发产物由 `cd server && npm run build` 生成至 `dist/mcp-server.mjs`；提交前执行 `cd server && npm run check && npm run build && npm test` 与 `node docs/decisions/check.mjs`。
- 禁止在 `server/package.json` 的 `dependencies` 中重新引入重量级单厂商 ACP 适配器硬依赖，保持开源核心轻量中立。
- 修改 `server/` 代码后须同步重建 `dist/mcp-server.mjs`，保证 `agy plugin install` 直接安装仓库即可零依赖运行。
- 非平凡变更须在同一个提交里新增或更新 docs/decisions/ 下的决策记录，规范见 docs/decisions/README.md

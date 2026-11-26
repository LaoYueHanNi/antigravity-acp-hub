# 项目协作规范

- 核心服务端位于 `server/`，提交前执行 `cd server && npm run check && npm test` 与 `node docs/decisions/check.mjs`。
- 禁止在 `server/package.json` 中重新引入重量级单厂商 ACP 适配器硬依赖，保持开源核心轻量中立。
- 非平凡变更须在同一个提交里新增或更新 docs/decisions/ 下的决策记录，规范见 docs/decisions/README.md

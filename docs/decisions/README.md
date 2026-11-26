# 决策记录（Decision Records）

本目录记录本项目所有"维护者将来可能合理重审"的决策：为什么这样设计、放弃了什么。
Git 回答"怎么做"，决策记录回答"为什么不那样做"。

## 目录与状态

- `proposed/` — 未实施的提案，评审后再做
- `implemented/` — 已落地；随代码同步更新事实
- `rejected/` — 被否决；仅保留理由仍能阻止再次踩坑的
- `archived/` — 已归档并永久冻结的历史快照

文件名：`yyyy-mm-dd-slug.md`，日期为**首次提出**日。状态编码在路径里，`Status:` 行须与所在目录一致（`check.mjs` 交叉校验）。
禁止在 `docs/decisions/` 根部创建集中式 `INDEX.md`：它会重复路径元数据并在并发变更时制造冲突，直接按状态目录浏览或全文搜索即可。

## 何时写

非平凡变更必须在同一个提交里新增或更新至少一条。非平凡 = 改变行为、架构、跨文件契约、工具链、测试策略、磁盘或线上格式。纯机械局部编辑与微小 UI 调整豁免。
先做**取代检查**：搜索同主题活跃记录，优先更新已有记录；若部分取代则双向链接；若完全取代，须把旧记录全部独特理由、被否决方案、代价与验证要求迁移到新记录后再删除旧记录并修复入链。

## 格式

头部固定四行（第 1 行为 `# DR:` 标题，第 2 行为空行，第 3 行为唯一 `Status:` 行，第 4 行为空行）：

```
# DR: <标题>

Status: <状态>

```

`Status` 取值：`proposed` / `implemented` / `rejected — 一行理由`（rejected 的理由写在 Status 行，那是读者要的判决）。

所有记录正文的第一个二级标题必须是 `## Problem`（动机，不看方案也能懂）。

### proposed 骨架

`## Problem` → `## Proposal`（打算做什么，可用将来时）→ `## Alternatives considered` → `## Acceptance criteria`（什么可观察状态算完成）→ `## Risks`（可能出什么问题 + 主动放弃了什么）。

### implemented 骨架

`## Problem` → `## Decision`（现在时，描述实际落地的样子）→ `## Alternatives considered` → `## Consequences`（代价与所得，两边都要写）。禁止出现 `## Proposal`、`## Plan`、`## Migration plan`、`## Acceptance criteria` 等规划性段落。

### rejected

提案原样冻结（保留 `## Problem`、`## Proposal` 等提案期段落），判决只写在 `Status` 行。

## 规则

1. **Alternatives considered 强制**：每个真实考虑过的替代方案一段加粗开头，写清为什么输。记录而非发明——确实没有就写"无"。没有记录打败了什么的决策，就是在邀请它被重新争论一遍。
2. **推翻决策 = 新开一条 + 双向链接**；禁止把 `implemented` 原地改写成相反决定。旧条目被完全取代时可合并删除，但须先迁移全部独特理由并修复所有入链。
3. **implemented 随代码更新事实**：路径、名称、默认值变了，同一提交里同步更新；只改事实，不改决策。
4. **删除 vs 归档（按未来决策指导价值判断，不按字数或时间）**：
   - 纯机械重构、微小 UI 调整的 `implemented` 记录，以及已失去防踩坑意义的 `rejected` 记录 → **直接删除并清理入链**，不要归档。
   - 已完整落地、不再指导未来工作但有历史价值的 `implemented` 记录 → 移入 `archived/`，在 `Status: implemented` 下紧接着加一行 `Archived: yyyy-mm-dd`，此后永久冻结、永不改动，也不作为当前权威引用。`proposed` 永不归档。
5. **交叉引用用相对 markdown 链接**（如 `[主题](../implemented/2026-01-01-xxx.md)`），禁止裸编号引用——编号会因删除失效，路径加死链检查不会。`archived/` 作为冻结快照豁免出站死链检查，活跃记录仍可引用归档记录。

## 提交前自查

```sh
node docs/decisions/check.mjs
```

校验目录规范、文件名、头部格式与唯一性、Status 与目录一致、骨架段落齐全、implemented 禁词、归档标记及活跃记录相对链接无死链。

# 治理

治理结构文档化于 [`GOVERNANCE.md`](https://github.com/genspark-ai/genoffice/blob/main/GOVERNANCE.md)。本页是文档读者的快照。

## 指导委员会

来自 GenOffice 团队的 3-5 位 maintainer。决策：

- 发布节奏。
- RFC 审批。
- 安全策略。

## 工作组

| 工作组 | 范围 | Maintainer |
|---|---|---|
| `@genoffice/editors` | docs · sheets · slides · pdf · markdown · html | docs + sheets lead |
| `@genoffice/ai` | Provider 插件 + Skills + KB / TM + Agent Loop | AI lead |
| `@genoffice/sdk` | Web SDK + REST API + iframe 嵌入 + IPC 文档 | SDK lead |
| `@genoffice/skills` | Skill 市场 + 编写指南 | 市场 lead |
| `@genoffice/infra` | 构建 / 测试 / 发布 / Docker / npm publish | 基础设施 lead |

## RFC 流程

1. 开 PR 添加 `docs/rfcs/0001-<slug>.md`，状态 **Proposed**。
2. PR 内讨论至少 14 天。
3. 工作组投票 → maintainer 批准 → 状态改为 **Accepted**。
4. 实现跟随 PR 落地。
5. RFC 归档到 `docs/rfcs/accepted/`。

## 投票

- 工作组成员各一票。
- Maintainer 可打破平局。
- 非平凡变更要求 50% + 1 法定人数。

## 如何加入工作组

- 6 个月内至少合入 3 个工作组范围内的 PR。
- 工作组成员提名，maintainer 确认。
- 不活跃成员（12 个月无 commit）会被温和轮换掉。

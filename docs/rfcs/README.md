# RFC 流程

> GenOffice 公开 RFC（Request For Comments）流程 — 用于跨越大半年的、影响 SDK / API / 协议层稳定性的设计变更。

## 状态机

| 状态 | 含义 |
|---|---|
| **draft** | 作者还在写，未提交。任何人可发起。 |
| **proposed** | 已通过 PR 提交，进入评审窗口（默认 **14 天**）。需要至少 2 个 maintainer `approve`。 |
| **accepted** | 评审通过、合并到 `docs/rfcs/accepted/`。从下个 minor 版本起成为行为契约。 |
| **rejected** | 评审未通过，原作者可修订后重新提交为新 RFC。 |
| **withdrawn** | 作者主动撤回。 |
| **superseded** | 被更新的 RFC 取代，链接指向继承者。 |

## 文件命名

```
docs/rfcs/
├── 0000-template.md              # 本目录自带的模板，**不要**修改
├── README.md                     # 本文件
├── 0001-open-plan.md             # 状态：proposed → accepted
├── 0002-…-…md
└── accepted/
    └── 0001-open-plan.md         # 与上面 0001 内容相同，是其 "快照"
```

- `0000-` 是模板。
- 编号严格按 PR 合并顺序递增；删除的 RFC 编号**不重用**。
- 文件名 slug 用 kebab-case，描述主题。

## 提交流程

1. **复制 `0000-template.md`** → 命名为 `NNNN-slug.md`，放到 `docs/rfcs/`。
2. **填写所有必填小节**（Summary / Motivation / Detailed Design / Drawbacks / Alternatives / Unresolved Questions）。
3. **开 PR**，标签 `rfc`，指定至少 2 个 maintainer 评审。
4. 在 14 天评审窗口内收集反馈；如有重大分歧，作者可修订并 `force-push`。
5. 评审通过后合并 → 状态 `accepted`，文件镜像一份到 `accepted/`。
6. 关联的代码变更可以跟在 PR 之后实现，但**实现 PR 不强制依赖 RFC**（如紧急修复可走 hotfix）。

## 评审标准

- **向后兼容**：是否破坏现有用户？给出迁移路径。
- **范围**：是否超出 RFC 主题？如有"夹带"，应拆为独立 RFC。
- **可回滚**：出问题能否回滚到上一个 minor 版本？
- **测试覆盖**：是否包含新行为的端到端 / 单元测试？
- **文档**：是否同步更新了 `docs/guide/*` 与 API 参考？

## 当前活跃 RFC

| 编号 | 标题 | 状态 | 提案人 | 更新日期 |
|---|---|---|---|---|
| [0001](accepted/0001-open-plan.md) | GenOffice 开放计划 v1 | accepted | louloulin | 2026-09-22 |

## 与 issue / discussion 的边界

- **issue** = bug / 小幅增强（影响 < 1 周的工程量）。
- **discussion** = 方向性探讨，无明确实施计划。
- **RFC** = 涉及 SDK / API / 协议层的契约变更，影响 > 1 周。

一句话：能在 issue 里讨论清楚的，就不开 RFC。

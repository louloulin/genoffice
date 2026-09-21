# 社区 Skills

第三方 Skill 在各自的仓库里维护。提交 PR 把你的 Skill 加进本列表。

## 投稿清单

- [ ] npm 包发布在 `@genoffice/skill-<name>` 命名空间下（开启 provenance）。
- [ ] 默认导出实现 `SkillPackage`（`packages/agent-skills/src/skill-protocol.ts`）。
- [ ] 仓库里包含 `README.md`、`LICENSE`（与 Apache-2.0 兼容）、`CHANGELOG.md`。
- [ ] `tests/` 下至少有一个集成测试。
- [ ] 触发短语不与官方 Skill 重叠。
- [ ] Skill manifest 里文档化了所需权限。

## 投稿流程

1. 给 `genspark-ai/genoffice` 开 PR，修改 `docs/skills/community.md` 与 `docs/skills/.well-known/skills.json`。
2. Maintainer 评审 —— 通常 5 个工作日。
3. 合并后自动同步到 `genoffice.app/skills`。

## 精选 Skills

_（尚无社区投稿 —— 来当第一个！）_

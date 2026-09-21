# GenOffice Governance

## Steering Committee

维护者团队（3-5 人）负责：

- 发版节奏与版本策略
- RFC 最终批准
- 安全策略与漏洞披露
- 跨 WG 协调

## Working Groups

| WG | 范围 | Maintainer |
|---|---|---|
| `@genoffice/editors` | 6 编辑器对齐（docs / sheets / slides / pdf / markdown / html） | TBD |
| `@genoffice/ai` | AI 能力 + Provider 插件 | TBD |
| `@genoffice/sdk` | Web SDK + REST API + iframe Embed | TBD |
| `@genoffice/skills` | Skill 仓库 + KB/TM 分享 | TBD |
| `@genoffice/infra` | 构建 / 测试 / 部署 | TBD |

每个 PR 通过 CODEOWNERS 自动路由到对应 WG maintainer。

## RFC 流程

`docs/rfcs/` 目录接受 RFC 提案：

1. **提议**：以 `rfcs/NNNN-short-name.md` 创建文件
2. **讨论期**：≥ 14 天（紧急情况可缩短到 7 天）
3. **投票**：相关 WG 投票，maintainer 最终批准
4. **合并**：移动到 `docs/rfcs/accepted/`
5. **实施**：带 milestone 跟踪

## 版本发布

- 主版本（v1.x → v2.0）：保留 6 个月过渡期
- 次版本（v1.0 → v1.1）：新增功能，向后兼容
- 修订版本（v1.0.0 → v1.0.1）：bug 修复
- LTS：每 6 个月一个 LTS 版本，支持 18 个月
- 安全补丁：永久支持

## 行为准则

所有参与者必须遵守 [CODE_OF_CONDUCT.md](./CODE_OF_CONDUCT.md)。

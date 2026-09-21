# 常见问题

## GenOffice 与 Google Docs / WPS / OnlyOffice 的差别

|  | GenOffice | Google Docs | WPS | OnlyOffice |
|---|---|---|---|---|
| 开源核心 | ✅ Apache-2.0 | ❌ | ❌（AI 封闭） | ✅ AGPL |
| iframe 嵌入 | ✅ | ❌ | ❌ 仅企业版 | ⚠️ 企业版 |
| 内置 AI | ✅ 12 家 provider | ⚠️ 仅 Gemini | ⚠️ 仅 WPS AI | ⚠️ 插件 |
| 可自部署 | ✅ 单二进制 | ❌ | ❌ | ✅ Docker |
| Provider 插件 | ✅ | ❌ | ❌ | ❌ |
| Skill 生态 | ✅ | ❌ | ❌ | ❌ |

## 如何从 OnlyOffice 迁移？

1. 导出 OnlyOffice 文档（DOCX / XLSX / PPTX 双向兼容）。
2. 启动 GenOffice web-server（Docker 镜像或 `npx`）。
3. 通过 `POST /api/v1/files` 上传。
4. 用 `GET /embed/:docId?token=…` 嵌入，或调用 SDK。

## 能不能离线运行 GenOffice？

可以。自带 web-server 没有任何出站依赖。AI provider 需要出站访问（或自部署 LLM 端点）。

## 许可证？

核心 monorepo、Web SDK、REST API、所有文档化的公开接口都是 Apache-2.0。Docker 镜像与 npm 包同许可证。

## 如何上报安全漏洞？

发邮件到 **security@genoffice.app** —— 见 [`SECURITY.md`](https://github.com/genspark-ai/genoffice/blob/main/SECURITY.md)。

## 如何新增 LLM provider？

实现 `AiProviderPlugin`，把 npm 包发布到 `@genoffice/provider-<name>`。见 [Provider 插件](/zh/api/provider-plugins)。

## 如何新增 AI Skill？

实现 `SkillDefinition`，把 npm 包发布到 `@genoffice/skill-<name>`。见 [AI Skills 协议](/zh/api/ai-skills-protocol)。

## 文件存储格式？

GenOffice 产出的开放格式是 `.docx`、`.xlsx`、`.pptx`、`.pdf`、`.md`、`.html`。KB / TM 使用开放的 `.genkb` 和 `.gentm` 归档（见 [KB / TM 格式](/zh/api/kb-tm-format)）。

## 有 SaaS 托管版吗？

在路线图（M3）上。在此之前，GenOffice 只能自部署。

# Skill 市场

按类别浏览 GenOffice 团队发布的 11 个独立 Skill。每个条目链接到对应的 npm 包、源码位置与文档。

> 完整的逐 Skill 参考（manifest / 触发短语 / 输入 / 输出）见 [官方 Skills](/zh/skills/official)。编写自己的 Skill 用到的契约见 [Skill 编写指南](/zh/skills/authoring)。投稿社区 Skill 见 [社区 Skills](/zh/skills/community)。

## 分类

### 📄 文档（Document）— 7 个

| Skill | npm | 用途 |
|---|---|---|
| `genoffice.skill.markdown-format` | `@genoffice/skill-markdown-format` | 规范化 Markdown（标题、列表、代码块、链接、空白）。 |
| `genoffice.skill.doc-format` | `@genoffice/skill-doc-format` | 对 `.docx` 应用统一的标题、列表、代码块样式。 |
| `genoffice.skill.text-summarize` | `@genoffice/skill-text-summarize` | 通过宿主 LLM 生成 `short` / `medium` / `long` / `bullets` 摘要。 |
| `genoffice.skill.text-diff` | `@genoffice/skill-text-diff` | 计算两段文本之间的 unified-diff 风格变更列表（Myers LCS）。 |
| `genoffice.skill.json-validate` | `@genoffice/skill-json-validate` | 用小型 JSON-schema 风格规则集校验 JSON。 |
| `genoffice.skill.yaml-validate` | `@genoffice/skill-yaml-validate` | 用小型 JSON-schema 风格规则集校验 YAML。 |
| `genoffice.skill.yaml-to-json` | `@genoffice/skill-yaml-to-json` | 在 YAML 与 JSON 之间互转。 |

### 📊 表格（Sheet）— 1 个

| Skill | npm | 用途 |
|---|---|---|
| `genoffice.skill.sheet-formula` | `@genoffice/skill-sheet-formula` | 在 `.xlsx` 中新增 / 解释公式（token-by-token + 操作数类型推断）。 |

### 🎬 演示（Slides）— 1 个

| Skill | npm | 用途 |
|---|---|---|
| `genoffice.skill.slides-outline` | `@genoffice/skill-slides-outline` | 基于 prompt + 可选上下文生成幻灯片大纲。 |

### 🌐 翻译（Translation）— 2 个

| Skill | npm | 用途 |
|---|---|---|
| `genoffice.skill.text-translate` | `@genoffice/skill-text-translate` | 在 BCP-47 语言之间翻译文本，支持可选领域提示。 |
| `genoffice.skill.text-translate-pairs` | `@genoffice/skill-text-translate-pairs` | 翻译 TMX 风格平行句对，保留占位符。 |

### 🏢 行业（Industry）— 预留

行业类别留给针对特定垂直领域（法律 / 医疗 / 金融 / 教育 …）的第三方 Skill。要投稿第一个，请走 [社区 Skills](/zh/skills/community) 流程。

## 按触发短语搜索

每个 Skill 都声明一组触发短语。运行时 Agent Loop 把用户输入与这些触发短语匹配。

| 触发短语 | Skill |
|---|---|
| `format markdown`、`clean up markdown` | `genoffice.skill.markdown-format` |
| `format document`、`clean up document`、`文档排版` | `genoffice.skill.doc-format` |
| `summarize`、`tldr`、`summary`、`摘要` | `genoffice.skill.text-summarize` |
| `diff text`、`compare text`、`文本对比` | `genoffice.skill.text-diff` |
| `validate json`、`check json` | `genoffice.skill.json-validate` |
| `validate yaml`、`check yaml` | `genoffice.skill.yaml-validate` |
| `yaml to json`、`json to yaml` | `genoffice.skill.yaml-to-json` |
| `explain formula`、`check formula`、`解释公式` | `genoffice.skill.sheet-formula` |
| `slide outline`、`presentation outline`、`幻灯片大纲` | `genoffice.skill.slides-outline` |
| `translate`、`翻译` | `genoffice.skill.text-translate` |
| `translate pairs`、`tmx` | `genoffice.skill.text-translate-pairs` |

## 一键安装全部

```sh
npm install \
  @genoffice/skill-markdown-format \
  @genoffice/skill-doc-format \
  @genoffice/skill-text-summarize \
  @genoffice/skill-text-diff \
  @genoffice/skill-json-validate \
  @genoffice/skill-yaml-validate \
  @genoffice/skill-yaml-to-json \
  @genoffice/skill-sheet-formula \
  @genoffice/skill-slides-outline \
  @genoffice/skill-text-translate \
  @genoffice/skill-text-translate-pairs
```

## 通过市场引导启动

web-server 自动加载 `genoffice.skills.json` 里列出的 Skill：

```json
{
  "skills": [
    { "name": "@genoffice/skill-markdown-format" },
    { "name": "@genoffice/skill-text-translate" },
    { "name": "@genoffice/skill-doc-format" }
  ]
}
```

启动成功日志：

```
[marketplace] loaded 3 skill(s):
  - genoffice.skill.markdown-format
  - genoffice.skill.text-translate
  - genoffice.skill.doc-format
```

## 路线图

行业类别会随着社区投稿通过 [社区 Skills](/zh/skills/community) 流程进入而填满。

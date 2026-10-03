# 云盘四格式整篇翻译：真机走查揪出的六个缺陷

> 日期：2026-10-04
> 配套文档（Dataflare 侧，含端到端走查细节与门禁清单）：
> `/Users/louloulin/appx/dataflarework/docs/plans/2026-10-03-genoffice-drive-translation-production.md` §2.14 / §2.15
> 范围：`docx` / `xlsx` / `pptx` / `pdf` 四个应用 + `apps/web-server` 侧车
> 状态：全部修复并落地门禁，四格式真机端到端通过

## 0. 一句话结论

整篇翻译的**能力**在之前的迭代里已经补齐（四格式各有 `translateDocument` 接线、宿主
`translate` 命令、落盘写回），但把它接到真实栈上跑一遍之后，又暴露出**六条让功能
静默失效的缺陷**。它们的共同特征是：**界面完全正常、控制台零报错、既有门禁全绿**。
所以这份记录的重点不是「修了什么」，而是「为什么静态检查抓不到，以及各自由什么钉住」。

## 1. 六条缺陷

| # | 缺陷 | 位置 | 后果 |
| --- | --- | --- | --- |
| J | 桥是 `dataflare.install({})`，**所有宿主 `translate` 命令被丢弃** | `apps/pdf/src/renderer/web-bridge.ts` | 云盘里点「翻译全文」对 PDF 完全无效，且不报错 |
| K | 宿主命令监听整块写在 `App()` 的 `return (` **之后** | `apps/sheets/src/renderer/App.tsx` | 表格翻译静默失效 |
| L | 写回时读 `sheet.sparklines.length`，而该字段的 schema 默认值只在**跑 schema 的路径**生效 | `apps/sheets/src/renderer/App.tsx` + 新增 `workbook-normalize.ts` | 从上传打开的工作簿必抛异常，**同批次后续写入全丢**，界面却提示「成功」 |
| M | `workbook:close` 在 web-server 侧从未注册（Rust 协议里本来就有 `close`） | `apps/web-server/src/sheets/{sidecar.ts,sidecar-pool.ts,index.ts}` | 每次开关文档 404；sidecar 常驻模型（含 ~1.2GB recalc 模型）永不释放 |
| N | `defaultSidecarPath()` 写死四跳 `..`，实际产物深一层 | `apps/web-server/src/sheets/sidecar.ts` | 解析到不存在路径 → `xlsx-sidecar binary not found`（生产镜像靠 `ENV` 掩盖） |
| O | 幻灯片抽取漏过滤 `GlyphRun.isBullet` | `apps/slides/src/renderer/ai/document-translate.ts` | 写回后项目符号变字面文本 + 段落仍带 `buChar` = **双项目符号** |

### 1.1 J 与 K：语法合法 ≠ 接线成立

- **J** 的 `dataflare.install({})` 语法完全合法，缺的是 `onCommand` 转发。注意
  `init` 命令是由 SDK 自己消费的，所以**文档能正常打开** —— 极易误判成「PDF 接线通了」。
  现在改为转发到 `dataflare:office-command` 事件。
- **K** 更极端：`tsc` 不做可达性分析，那段代码对编译器而言不是死代码，是给**运行时**看的；
  minifier 直接把它丢掉，产物里连 `cancel-translation` 这个字面量都不存在。
  既有门禁只 grep 字样也照样全绿。

这两条共同指向一条门禁纪律：**判据必须落在「真的会执行」的位置上**，落在文件里
出现过某个字符串是不够的。

### 1.2 L：异常逃出循环，界面却报成功

`worksheetMetadataSchema` 的 `.default([])` 只在**跑 schema 的解析路径**上生效；
从云盘上传后直接打开的工作簿，字段根本不存在。原先的防御是在 Univer 命令处理器
**内部**加一个点状守卫，但 `FRange.setValue` 不拦异常 —— 异常直接逃出调用方的循环，
于是同循环里它之前那些写入进了 journal、**之后的全丢**。实测 6 个单元格只落 1 个译文，
状态栏却显示「已写入 6 个单元格」。

**根治**而不是补点状守卫：新增 `apps/sheets/src/renderer/workbook-normalize.ts` 的
`withSheetMetaDefaults(file)`，在 `openLazyWorkbook` 里对 `pivotTables` / `sparklines` /
`cellImages` 补 `[]`（与既有的 `visuals` 归一化并列）。点状守卫已回退，保持单一机制。

### 1.3 M 与 N：协议早就支持，只是没人接线

M 的 Rust 侧协议里本来就有 `close` 命令。补上三处：`sidecar.ts` 加 `close(sessionId)`、
`sidecar-pool.ts` 加**按 `sourcePath` 路由**的 `close`（按 sessionId 路由会在同一文件
被反复打开时关错会话）、`index.ts` 注册 `workbook:close`。

N 的 `defaultSidecarPath()` 从「写死层数」改成「从模块位置向上 walk 找
`apps/sheets/native/xlsx-engine` 标记目录」，并导出该纯函数以便单测。
写死层数的版本在 `dist/web-server/src/sheets/sidecar.js`（深一层）上解析到不存在路径，
而生产镜像用 `ENV` 把它掩盖了 —— **本机开发与生产镜像走的是两条不同路径**。

### 1.4 O：全仓只有这一处抽取漏了过滤

`TextEditOverlay.tsx` 等其它抽取点都过滤了 `run.isBullet`，只有
`document-translate.ts` 的 `frameText` 漏了。来源是 master / layout 占位符继承的默认
`buChar`（`pptx-engine/src/parse.ts:1567`），写回后 `•` 变成字面文本、段落仍带 `buChar`。
真机验证：新上传的 pptx 四段翻译后文本里**没有任何 `•`**。

## 2. 新增门禁（全部已接 `package.json` + CI，全部做过变异验证）

| 门禁 | 钉住的缺陷 | 反向验证 |
| --- | --- | --- |
| `check:embed-host-documents` | 打开方向（bridge 在 `createDataflareEmbedIntegration({…})` **实参内** dispatch / App 成对 add+remove / **handler 函数体**内有打开入口）+ 保存方向（`dataflare.saveDocument(`） | 6 种变异全红 |
| `check:app-translation-parity`（扩两条） | 「桥**转发**宿主命令」（J）、「监听在组件 `return` **之前**，不是死代码」（K） | 各 1 种变异全红 |
| `check:sheets-model-defaults` | `openLazyWorkbook` 必须过 `withSheetMetaDefaults`，且模块导出与三个字段齐全（L） | 1 种变异红 |

`check:embed-host-documents` 的两个坑值得单独记：

1. **不能用正则全局剥注释**。`App.tsx` 里有 `text.replace(/…\* padding…/)` 这种正则字面量，
   剥注释会把它吞掉，连带吞掉其后 6 万字符真实代码。改为**只剥行首注释**。
2. **判据不能落在 effect 体**，只能落在 handler 函数体 —— effect 在 mount 期本来就会
   消费一次命令，判据落那里会假绿。

`check:app-translation-parity` 也踩过一个：`dataflare.install()` 的字面量在**注释里**
先出现，`indexOf` 会命中注释。改为取全部调用点、任一满足即通过。

## 3. 新增单测

| 文件 | 覆盖 | 变异 |
| --- | --- | --- |
| `apps/sheets/tests/document-translate.test.ts` | `applySheetTranslations`：6 个 unit 全写 / 双语列落点 / 非字符串跳过（3 例） | — |
| `apps/sheets/tests/workbook-normalize.test.ts` | 三个字段补 `[]`（4 例） | pass-through → 2 红 |
| `apps/slides/tests/document-translate.test.ts` | `frameText`：跳 bullet / 保留字面 bullet / 空项目符号段落（3 例） | 去过滤 → 2 红 |
| `apps/web-server/tests/sidecar-path.test.ts` | 向上 walk 定位（3 例） | 旧实现 → 3 红 |
| `apps/web-server/tests/sidecar-pool.test.ts` | `close` 按 `sourcePath` 路由（1 例） | 只按 sessionId → 红 |

## 4. 真机结果（后端 + web-server + 固定串 mock provider，真实浏览器）

| 格式 | 结果 |
| --- | --- |
| `docx` | 4/4 段替换，0 空段落 |
| `pptx` | 4/4 文本框替换，**无字面 `•`** |
| `xlsx` | 6/6 文本格翻译；`B2=12345` 数值保留、`C2` 公式 `B2*2` 保留、`C3=9.99` 保留 |
| `pdf` | 3/3 段 pdfium 原地替换落盘（`pdftotext` 复核） |

走查脚本与判据细节在 Dataflare 侧 §2.15。其中三条是这次才暴露的、值得本仓也记住的：

1. **「宿主有没有某个能力」这类判据不能写 `page.getByRole()`** —— 它默认穿透 iframe，
   会命中本仓内部的同名文案。必须限定到宿主 frame。
2. **canvas 渲染的应用不能用 DOM 文本判「是否生效」** —— 表格与幻灯片的单元格、
   文本框根本不在 DOM 里，那种判据恒假，比不判更糟。
3. **「读一个可能不存在的字段」要用入口归一化，不能用调用点守卫** —— 这正是 L 的教训。

## 5. 遗留（不在本轮范围）

- 只有 `apps/docs` 会向宿主发 `document-dirty`；`sheets` / `slides` / `pdf` 都不发，
  所以宿主侧「有未保存修改」的标记对这三个格式永不出现。这不构成功能缺陷（这三者本来
  就不走宿主保存按钮），但用户从宿主标题栏看不到「我改了还没存」。是否补，待拍板。
- 渲染器构建有陈旧缓存坑：改 `apps/sheets` 源码后必须
  `npm run build -w @genoffice/sheets`，否则真机跑的还是旧渲染器。

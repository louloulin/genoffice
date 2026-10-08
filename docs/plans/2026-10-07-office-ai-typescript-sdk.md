# Plan — 把 GenOffice 核心 Office AI 变成可直接 import 的 TS 库(去 SaaS 化)

> 文档版本:v1.0(2026-10-07)
> 目标读者:genoffice 维护者 + `~/dataflare/aiwork`(dataflare-next)接入方
> 配套文档:`docs/plans/2026-09-18-office-ai-strategy-overview.md`(战略总览)、
> `docs/plans/2026-09-19-dataflarework-integration-design.md`(旧版 DataflareWork 嵌入方案)、
> `sdk1.md`(开放计划)、`saas1.md`(SaaS 化计划)、`agent1.md`(pi 重写计划)

---

## 0. 一句话结论

**不需要重写,也不需要拆仓。** GenOffice 的"核心 Office AI"事实上已经以**纯 TS、可 headless 运行**的形态散落在 `packages/*` 与 `@genoffice/cli` 里;它们现在只是被两件事挡住:①只以 CLI/HTTP 两个"外向面"暴露,没有库入口;②`packages/cli` 反向相对 import 了 14 处 `apps/*/src` 的编辑器实现。最小改造 = **新增一个 facade 包 `@genoffice/office-ai`,把已有引擎 + Skill + Provider 组合出一个稳定的编程 API,用 esbuild 打成自包含产物**(把 14 处相对 import 内联掉),再把 `aiwork` 的**无头文档处理**从"起独立 web-server 容器"改成"进程内 `import`"。

⚠️ 关键前提(清点 aiwork 触点后确认):aiwork 现有对 GenOffice 的 HTTP 调用**几乎全是编辑器会话**(JWT/embed/nonce/推模型配置/反代),并非"文档 AI"。真正缺一个进程内入口的,只有 **headless 读写 / 转换 / 渲染**——那正是本方案要交付的。所以**独立容器不删**(交互式编辑器仍用它),库化是**纯增量**。翻译/KB/OCR 保持 aiwork 自持,库不越界(见 §6.1)。

预计新增源码 **≈ 1.5k–2.5k 行**(facade + 文件型 Editor 适配器 + Node SkillContext + 打包脚本),不动现有引擎实现。

---

## 1. 现状:GenOffice 今天是怎么被"外部"消费的

### 1.1 两条既有的外向路径

| 路径 | 载体 | 谁在用 | 形态 |
|---|---|---|---|
| **A. SaaS / Web Server** | `apps/web-server`(`@genoffice/web-server`,551 channels + 22 routes,单进程 Node) | `aiwork`(dataflare-next)通过 `GENOFFICE_URL`/`GENOFFICE_TOKEN`(`deploy/ora/compose.yml` 中 `http://genoffice:8080`)访问;旧版 DataflareWork 通过 nginx `/office-engine/` 反代 | HTTP + SSE |
| **B. 嵌入 iframe SDK** | `apps/sdk`(`@genoffice/web-sdk`) | 宿主页面用 `createEditor()` 挂 iframe,走 `genoffice-dataflare/v1` postMessage 协议 | 浏览器客户端 SDK |

两条路径**都指向"把 genoffice 当成一台服务/一个挂件"**,而不是"把能力装进宿主进程"。

### 1.2 已经存在的第三条路径(被低估)

`@genoffice/cli` 的 README 自己写着:

> `genoffice` … "exposes the suite's document engines to scripts and AI agents **without opening a window**"

它已经是一个**headless、文件进文件出**的文档能力层:

```
genoffice docs read report.docx --json
genoffice docs apply report.docx --ops ops.json
genoffice sheet read book.xlsx --json
genoffice create --type xlsx --from table.json --out book.xlsx
genoffice slides apply deck.pptx --ops edit.json
genoffice convert scan.pdf --to docx
genoffice render report.docx --out shots/
```

而且 `packages/cli/src/formats/*.ts` 导出的就是**纯函数**(`Uint8Array → Uint8Array` / 结构化对象),天然就是库 API:

| 模块 | 关键导出(已存在) |
|---|---|
| `formats/docx.ts` | `openDocument(bytes)` / `saveDocument(doc)` / `describeDocument(doc)` / `applyDocOps(doc, ops, opts)` / `documentHtml(doc)` / `fillFromHtml(doc, html)` / `listComments(doc)` / `listRevisions(doc)` / `headerFooterState(doc)` / `docsGuide()` |
| `formats/xlsx.ts` | `workbookSummary(path)` / `readSheet(...)` / `sheetToCsv(...)` / `blankWorkbook()` / `writeWorkbook(...)` / `cellEditsFromTable(...)` / `convertLegacyWorkbook(...)` / `parseAddressChecked(...)` |
| `formats/pptx.ts` | `openDeck(bytes)` / `saveDeck(opened)` / `applyOps(opened, ops, opts)` / `describeDeck(...)` |
| `formats/pdf.ts` | `pdfInfo(bytes)` / `convertPdf(bytes, target)`(→ docx/pptx/xlsx) |
| `formats/markdown.ts` | `markdownToDocx(...)` / `markdownToHtml(...)` / `htmlToMarkdown(...)` |
| `formats/csv.ts` | `csvInfo(bytes)` / `csvToXlsx(bytes, sheet)` |
| `formats/xlsx-dsl.ts` | `runWorkbookDsl(...)` / `SUPPORTED_DSL_OPS` |

**结论:库的"身体"已经写好了,缺的是"皮肤"——一个对外稳定的入口 + 打包 + 分发。**

### 1.3 反向依赖:唯一的硬伤

`packages/cli/src` 有 **14 处**相对 import 打回 app 源码:

```
packages/cli/src/formats/docx.ts:47-55   → apps/docs/src/renderer/{editor/extensions, editor/convert,
                                            ai/protocol, ai/ops, ai/tools, i18n/locale,
                                            editor/comments, editor/hf-text, editor/revisions}
packages/cli/src/formats/markdown.ts:19-21 → apps/markdown/src/renderer/{editor/extensions,
                                            editor/ops, export/docxExport}
packages/cli/src/formats/xlsx.ts:22-23   → apps/sheets/src/main/{atomic-write, xlsx-sidecar-client}
```

合计 **9 + 3 + 2 = 14 处**(已逐条核验)。

原因:**docs / markdown 的"保真编辑模型"住在渲染层**(tiptap 扩展 + ops + protocol),不在包里。这是库化最大的单点障碍,也是 §5.2 要解的地方。

---

## 2. "核心 Office AI"到底由哪几层组成

把 SaaS 胶水剥掉后,真正的能力分四层,全部已有实现:

```
┌─ L3 Agent 层 ────────────────────────────────────────────────────────────┐
│  @genoffice/agent-core   AgentLoop / AgentTransport / agent-protocol v1    │
│                          (AgentRequest / AgentResult / AgentRunner)        │
│  @genoffice/chat-runtime ChatRuntime / Session / Run / ChangePlan          │
│  @genoffice/agent-runtime(pi 版,createOfficeSession, 0.85.1)              │
├─ L2 Skill 层 ───────────────────────────────────────────────────────────┤
│  @genoffice/agent-skills  SkillDefinition / SkillContext 协议              │
│    extensions: docs / sheets / slides / translate / ocr / office-workflow  │
│                agent-team / audit-log / verify-response / frozen-selection │
│                skill-market / web-search / image-search / local-models     │
│    + 11 个独立包 @genoffice/skill-{doc-format,markdown-format,sheet-formula│
│      ,slides-outline,text-diff,text-summarize,text-translate,              │
│      text-translate-pairs,json-validate,yaml-validate,yaml-to-json}        │
├─ L1 Provider 层 ────────────────────────────────────────────────────────┤
│  @genoffice/ai-provider   18 家 BYOK provider + 插件注册表 + 重试/看门狗   │
│                           + media(图像生成/多模态分析)协议                │
│  @genoffice/translation-core  translateOne/Batch/Document + translateFile(整文件,          │
│                            SUPPORTED_EXTENSIONS=[.pdf,.xls,.xlsx,.pptx,.docx])           │
│                            + KB/TM;llm-client.ts 的 setLlmCaller() 是可换模型的接缝       │
│  @genoffice/ai-search     搜索/图片搜索/媒体工具                          │
├─ L0 文档引擎层 ─────────────────────────────────────────────────────────┤
│  @genoffice/docx-engine   parseDocx(Block 树) + OOXML 片段生成 + 段落 patch│
│  @genoffice/xlsx-gateway  纯 TS 工作簿读写(jszip 打 OOXML)+ 工作簿 DSL     │
│  @genoffice/pptx-engine   pptx 解析 + savePptxToFile                      │
│  @genoffice/pptx-ops      幻灯片 op 事务(与 app 内 AI 同一套)            │
│  @genoffice/pptx-render   幻灯片 → PNG(opentype + bidi)                   │
│  @genoffice/pdf2docx      pdfium wasm:pdf → docx/pptx/xlsx                │
│  @genoffice/file-parse    doc/docx/ppt/pptx/xlsx/pdf → 文本                │
│  @genoffice/html2docx / @genoffice/pipelines(deck 生成三阶段)            │
└──────────────────────────────────────────────────────────────────────────┘
```

### 2.1 必须留在 SaaS 里、**不能**进库的部分

| 类别 | 位置 | 为什么不能进库 |
|---|---|---|
| 鉴权 / JWT / scope / 租户 | `apps/web-server/src/auth`, `api/v1` | 宿主自己的身份体系,库不该管 |
| 用量计量 / 审计落库 / 限流 | `common/{usage-meter,audit-log,rate-limit}` | 运营面 |
| 协作会话 / 企业能力 / 市场 | `collab`, `enterprise`, `marketplace-loader` | 服务端状态 |
| 静态 SPA 托管 / embed iframe | `apps/web-server/src/web`, `embed` | 交互式编辑器外壳 |
| **编辑器 UI 本体**(Tiptap/Univer/幻灯片画布 + 各 app 的 router/IPC bootstrap) | `apps/{docs,sheets,slides}/src`(经 `/embed/:docId` 装载) | 整包 app,非组件;抽成库组件 = 大工程,单列 M3(见 §5.9) |
| 文件存储后端(S3/local) | `file-management` | 宿主已有自己的存储 |
| AI settings 持久化/加密 | `ai/settings-sanitize`, `ai/ai-audit` | 宿主自己存 key |

> 注意 `@genoffice/file-management` 只依赖 `@aws-sdk/*`,可库化,但**默认不进** facade——aiwork 自己有云盘(`nodes.storage_key`),应该由宿主把字节传进来、把字节存回去。

### 2.2 顺带发现的既成契约(可直接复用,不必重新设计)

- `docs/api/agent-protocol.md`:`genoffice.agent.v1` 信封 + `AgentRunner` 接口。**这就是库的 AI 契约**,已文档化、已版本化。
- `docs/api/ai-skills-protocol.md`:`SkillDefinition` + `SkillContext`(含 `workspace.files` / `llm` / `storage` / `emitProgress` / `cancel`)。**这就是"宿主桥"**,即宿主注入文件系统与模型的接缝。
- `docs/api/sdk-typescript.md`:现有 SDK 是**浏览器嵌入**客户端,与本次"服务端库"不是一回事,勿混。

---

## 3. 目标形态:一个 facade 包,三档 API

新增包 **`@genoffice/office-ai`**(Node ≥ 22.12,ESM + CJS + `.d.ts`,无 Electron、无 HTTP 依赖)。三档能力,按需引用:

```ts
import {
  // ── 档 1:文档引擎(无 LLM,纯函数)─────────────────────────
  readDocument, writeDocument, convert, render,
  applyDocxOps, applySheetOps, applySlidesOps,
  // ── 档 2:Office Skills(给任意 agent 宿主用)──────────────
  officeTools, createNodeSkillContext, createFileWorkspace, skillDefinitions,
  // ── 档 3:AI 运行时(宿主自己没有 agent 时可选)────────────
  createOfficeAgent, translateDocument,
} from '@genoffice/office-ai'
import { setLlmCaller } from '@genoffice/office-ai/llm' // 允许宿主换模型调用
```

### 3.1 档 1 —— 文档引擎(字节进、字节出)

```ts
type DocFormat = 'docx' | 'xlsx' | 'pptx' | 'pdf' | 'md' | 'html' | 'csv'

// 读:统一成结构化"文档视图"
async function readDocument(bytes: Uint8Array, opts?: ReadOptions): Promise<DocumentView>

// 写:应用一组 op(与 app 内 AI 用的同一套 op 语法)
async function writeDocument(bytes: Uint8Array, ops: OfficeOp[], opts?): Promise<Uint8Array>

// 转换:格式矩阵
async function convert(bytes: Uint8Array, from: DocFormat, to: DocFormat, opts?): Promise<Uint8Array>

// 渲染:可选的位图预览(pptx/pdf/文档 → PNG)
async function render(bytes: Uint8Array, opts?: { scale?: number; pages?: number[] }): Promise<Uint8Array[]>
```

这一档**不碰网络、不碰模型**,只做确定性文档处理。`aiwork` 用它做:OCR 前处理、上传预览、格式归一、导出。

### 3.2 档 2 —— Office Skills(接缝在 `SkillContext`)

把 `@genoffice/agent-skills` 的 15 个扩展 + 11 个独立 skill 暴露成**可被任意 agent 框架调用的工具**,并补上**文件型 Editor 适配器**和 **Node 版 SkillContext**:

```ts
// 文件型 workspace:把磁盘/宿主存储的文件映射成 SkillContext.workspace
const ctx = createNodeSkillContext({
  files: await createFileWorkspace({ read: hostRead, list: hostList }),
  llm: { chat, streamChat },          // 宿主注入;或省略 → 用档 3 的 provider
  storage: hostKV,                    // 宿主注入
  onProgress: (e) => {},
})

// 工具定义(可直接喂给 pi / MCP / 自研 loop)
const tools = officeTools({ formats: ['docx','xlsx','pptx','pdf'] })
```

> 关键新增物:**`DocsFileEditor` / `SheetsFileEditor` / `SlidesFileEditor`** —— 实现 `agent-skills` 里已定义的 `DocsEditor` / `SheetsEditor` / `SlidesEditor` 接口,把"打开文件 → 应用 op → 保存文件"包成编辑器语义。这是让 15 个 skill **真正 headless 跑起来**的缺件。

### 3.3 档 3 —— AI 运行时(可选)

```ts
const agent = createOfficeAgent({
  provider: { id: 'openai-compatible', apiKey, baseUrl, model }, // BYOK
  skills: {...},
  transport: 'in-process',   // 不用 electron/http transport
})
const result = await agent.run({ v: 'genoffice.agent.v1', goal: '把 Q3.xlsx 按增长率排序并出图' })
```

`aiwork` **大概率只要档 1 + 档 2**(它已经有自己的 pi agent-kernel 与模型),档 3 留给"无 agent 的宿主"。这也是**最小化**的关键:不强加 agent 运行时。

### 3.4 "全量 SDK"导出面清单(契约,不含实现)

所谓"全量 SDK"= 下面这些名字**全部**从 `@genoffice/office-ai` 可达(绝大多数是既有函数的幂等 re-export,只有标 ★ 的是新增)。

**档 1 · 文档引擎(纯函数)**
```
★ readDocument(bytes, opts) → DocumentView        // 按 magic/扩展名分派
★ writeDocument(bytes, ops, opts) → Uint8Array     // 统一 op 入口(内部分派到下面三个)
★ applyDocumentOps(bytes, ops, opts) → Uint8Array  // writeDocument 的分派实现(避免与既有 pptx `applyOps` 重名)
  applyDocxOps / applySheetOps / applySlidesOps     // 既有:applyDocOps / cellEditsFromInputs / pptx applyOps
★ convert(bytes, from, to, opts) → Uint8Array      // 封装 NODE_ROUTES(§4.1)
  pdfInfo / convertPdf / markdownToDocx / markdownToHtml / htmlToMarkdown
  csvInfo / csvToXlsx / convertLegacyWorkbook / workbookSummary / readSheet / sheetToCsv
  openDocument / saveDocument / describeDocument / documentHtml / fillFromHtml
  openDeck / saveDeck / describeDeck / runWorkbookDsl / parseAddressChecked
★ render(bytes, opts) → Uint8Array[]               // pptx-render / pdfium / (docx 需 app,见 §4.3)
  docsGuide / listComments / listRevisions / headerFooterState
```

**档 2 · Office Skills**
```
★ officeTools(opts) → ToolDefinition[]            // 15 扩展 + 11 独立 skill → 通用工具定义
★ createNodeSkillContext(opts) → SkillContext     // Node 版 SkillContext(workspace/llm/storage/progress/cancel)
★ createFileWorkspace(io) → Workspace             // 宿主 read/list → SkillContext.workspace
★ DocsFileEditor / SheetsFileEditor / SlidesFileEditor   // 实现既有 *Editor 接口
  skillDefinitions / ALL_DOCS_TOOL_NAMES / ALL_SHEETS_TOOL_NAMES / ALL_SLIDES_TOOL_NAMES
  OfficeWorkflowCallbacks 类型(宿主可注入 readSpreadsheet/composeDocument/composeSlides)
```

**档 3 · AI 运行时(可选,非 aiwork 交付面)**
```
★ createOfficeAgent(opts) → { run(req): Promise<AgentResult> }   // pi 作为 optional peer
  AgentRequest / AgentResult / AgentRunner / genoffice.agent.v1 类型
  translateFile(request: TranslateFileRequest) → TranslateFileResult   // 既有,文件级
  translateDocument(...) / translateOne / translateBatch              // 既有
  setLlmCaller(caller)                                                 // 换掉默认 LLM 调用
```

**分发子路径**:`@genoffice/office-ai`(主入口)、`@genoffice/office-ai/llm`(换模型)、
`@genoffice/office-ai/converters/libreoffice`(可选旧格式适配器,见 §4.3)。

> 判断"全量"是否达成的唯一标准:**上表每个名字都能在宿主进程 `import` 到,且不拉进 Electron / HTTP / 数据库**。

---

## 4. 支持矩阵(本次要保证的格式)

| 能力 | docx | doc | xlsx | xls | pptx | ppt | pdf | md/html/csv |
|---|---|---|---|---|---|---|---|---|
| 解析结构 | ✅ `docx-engine` | ⚠️ 仅文本 | ✅ `xlsx-gateway` | ⚠️ 仅文本 | ✅ `pptx-engine` | ⚠️ 仅文本 | ✅ `pdf2docx`/`file-parse` | ✅ |
| 读文本 | ✅ | ✅ `file-parse` | ✅ | ✅ `file-parse` | ✅ | ✅ `file-parse` | ✅ | ✅ |
| 创建 | ✅ | ❌ | ✅ | ❌(另存为 xlsx) | ✅ | ❌ | ❌ | ✅ |
| 应用 op 编辑 | ✅(jsdom 保真)/ ⚠️(引擎级 patch) | ❌ | ✅ | ⚠️ 转换后编 | ✅ | ❌ | ❌ | ✅ |
| 转其它格式 | →pdf⚠️/ →html/→md | →docx | →csv/→pdf⚠️ | →xlsx | →pdf⚠️/→png | ❌ | →docx/pptx/xlsx | ↔ |
| 渲染 PNG | ✅(Electron) | ❌ | ✅ | ❌ | ✅ `pptx-render` | ❌ | ✅ pdfium | ⚠️ |

### 4.1 CLI `convert` 的两条路由(决定"哪些能在库内跑")

源码依据:`packages/cli/src/commands/convert.ts:16`(NODE_ROUTES)/ `:34`(APP_ROUTES)。

| 路由 | 支持的转换 | 是否需要 Electron |
|---|---|---|
| **NODE_ROUTES(进程内,纯库)** | `pdf→docx\|pptx\|xlsx`、`csv→xlsx`、`xls\|xlsb\|ods→xlsx`、`md\|markdown→docx\|html`、`docx→md`、`xlsx\|xlsm→csv` | ❌ 不需要 |
| **APP_ROUTES(需 app 二进制 `--headless-export`)** | `csv\|xls\|md\|markdown\|docx\|xlsx\|xlsm\|pptx\|html\|htm →pdf`、`docx→html`、`html\|htm→docx` | ✅ spawn app |

**库默认只交付 NODE_ROUTES**;APP_ROUTES 需要宿主自备浏览器/布局引擎(见 §4.3)。

### 4.2 三个已知缺口(必须在计划里明说,不要假装全绿)

1. **→ PDF 导出 / docx→html / html→docx 需要布局或浏览器引擎**。web 构建下 `anydoc:convert` 对 `docx→pdf` 诚实拒绝;只有 Electron 版有 `--headless-export`(`docs/headless-pdf-export.md`),`html2docx` 则需要注入 `BrowserDriver`(CLI 用 playwright-core,app 用 Electron webContents)。库形态下要么(a)不提供这几条边,要么(b)保留瘦 headless-render 边车,要么(c)宿主用 Puppeteer 自理。
2. **`.doc / .ppt / .xls` 旧二进制格式:读文本 ✅,读写 ❌(除 xls→xlsx 转换)**。`@genoffice/file-parse` 已覆盖:`doc.ts`(word-extractor)、`ppt.ts`(ppt-to-text)、`xlsx.ts`(cfb)、`pdf.ts`(pdfjs)——**全部是"取文本",不保真、不可回写**。转换方面只有 `xls|xlsb|ods→xlsx` 是进程内的(走 `xlsx-gateway`);`.doc`/`.ppt` **连转换路由都没有**(`convert.ts` 的 NODE/APP 表里无 `doc`/`ppt` 键)。**要让旧格式达到"全量"读写,必须外接 LibreOffice**(见 §4.3)。
3. ~~xlsx 需要 Rust sidecar~~ —— **更正(2026-10-08 实测)**:要分读写两路说。
   - **写**:不需要。`xlsx-gateway` 有完整纯 TS 写路径(`applyPlanToXlsx` / `applyCellEditsToXlsx` / `writeXlsxAtomically` / `mutateXlsxFile`,`createBufferEntrySource` + `assembleWithJsZip`)。`writeWorkbook` + `runWorkbookDsl` 全程不碰 sidecar。
   - **读**:`formats/xlsx.ts` 的 `readSheet` / `workbookSummary` / `sheetToCsv` 走 `withOpenWorkbook → withSidecar`,`withSidecar` 找不到二进制就抛 `CliError('xlsx engine (xlsx-sidecar) not found')`。**这是宿主外冒烟的实测红**——本机绿只是因为 `apps/sheets/native/xlsx-engine/target/release/xlsx-sidecar` 恰好在位。
   - **库内解法(已实现)**:`office-ai/src/sheet-view.ts` 改用 `xlsx-gateway` 的 `readBasicWorkbook`(纯 TS)产出 `WorkbookView` / `SheetGridView`;`readDocument`、`xlsx→csv` 全部走这条,**默认零 sidecar**。代价:不做数字格式化(日期单元格回 serial 而非显示值),需要显示格式时宿主可自行套 `numfmt` 或显式接 sidecar。
   - Rust sidecar 的真正不可替代场景是**公式求值 / 缓存值**与超大表流式写;默认库不需要。

### 4.3 旧格式(`.doc/.ppt`)达到"全量"的两条路(诚实交代)

需求里点名了 `ppt`、`xls`。`xls` 走 `xls→xlsx`(进程内)已解决;`doc`/`ppt` 是真正的缺口。两条可选路:

| 方案 | 做法 | 代价 | 建议 |
|---|---|---|---|
| **L0. 库内不自建,文档只读文本** | 沿用 `file-parse`;宿主若需编辑旧格式,先用外部工具转新格式 | 零成本;`ppt/doc` 仅摘要/检索可用 | ✅ **M0–M2 默认** |
| **L1. 可选 LibreOffice 边车** | 独立进程/容器跑 `soffice --headless --convert-to`,把 `doc/ppt/xls → docx/pptx/xlsx` 后再进 L0 引擎 | 引入外部二进制(数百 MB)与跨平台部署负担;非纯 TS | 作为**可选适配器** `office-ai/converters/libreoffice`,不进默认依赖 |

> 边界:`libreoffice` 适配器**不属于** facade 默认面(违反"纯 TS 库"的最小化约束),但**在计划里明列**,由宿主按需开启——这样"全量"是"可达成",而不是"已内建"。

---

## 5. 最小改造清单(按依赖顺序)

### 5.1 新增 `packages/office-ai`(facade,约 800–1200 行)

- `src/documents/{index,docx,xlsx,pptx,pdf,convert,render}.ts` —— 幂等包装 §1.2 的既有函数,补统一类型 `DocumentView` / `OfficeOp` / 错误码(`OFFICE_UNSUPPORTED` 等,沿用 CLI 的 `result.ts` 语义)。
- `src/skills/{index,files-editor,node-context,office-tools}.ts` —— 文件型 Editor 适配器 + Node `SkillContext` + 工具导出。
- `src/agent/{index}.ts` —— `createOfficeAgent`(可选,薄包装 `agent-core` 的 `AgentLoop` + `ai-provider`)。
- `src/index.ts` —— 只做 re-export,**不新增逻辑**。
- `package.json`:`exports` 映射到 `dist/`(不再是 `./src/*.ts`),`sideEffects:false`,`engines.node >= 22.12`。

> 设计原则:**facade 只做"组合 + 类型 + 错误语义",不做第二套实现**。任何逻辑都下沉到既有包。

### 5.2 解掉 14 处反向依赖(二选一)

| 方案 | 做法 | 代价 | 建议 |
|---|---|---|---|
| **B1. 打包内联**(推荐) | 沿用 CLI 的 `build.mjs`(esbuild `bundle:true`),把 `apps/docs|markdown|sheets|shell` 的实现**打进产物**;宿主只依赖 `dist/`,不再解析相对路径 | 产物变大;`jsdom` 仍需 external | ✅ 零源码搬迁,最快 |
| B2. 抽包 | 把 `apps/docs/src/renderer/{editor,ai}`,`apps/markdown/src/renderer/{editor,export}`,`apps/sheets/src/main/{atomic-write,xlsx-sidecar-client}` 移进 `packages/*`,app 改为 re-export | 动 33k + 13k 行,回归面大 | 后续可选(治理性) |

**先 B1 交付,B2 作为后续技术债清理**,不阻塞本次目标。

### 5.3 文件型 Editor 适配器(核心缺件,约 400–700 行)

`agent-skills` 已定义 `DocsEditor`/`SheetsEditor`/`SlidesEditor` 接口(见 `extensions/{docs,sheets,slides}-skill.ts`),但**只有渲染层实现**。接缝很干净:每个工具只需 `uiAdapter.getEditorInstance<T>()`(`agent-runtime/src/ui-adapter.ts`),所以 headless 宿主只要实现 `*Editor` 接口、交给 `ReactUIAdapter`,**不需要 Tiptap/Univer/Electron**。

> 已核验(`packages/agent-skills/src/extensions/docs-skill.ts:42`):`DocsEditor` 等接口**是纯 TS 类型,无 `HTMLElement`/`React`/`document`/`window`**——DOM 只存在于"真实实现(Tiptap-backed)"里,不存在于契约里。故库内实现一份文件型 `*Editor` 是**接口级 drop-in**。

> ⚠️ **但要如实说明:docs 的"保真编辑模型"本身是 Tiptap/ProseMirror 耦合、需要 DOM 的**。核验结果:`apps/docs/src/renderer/ai/ops.ts`(op 执行器)与 `editor/convert.ts`(Tiptap doc → docx-engine save plan)、`editor/{comments,hf-text,revisions}.ts`、markdown 的 `ops.ts`/`docxExport.ts` **都是 0 处真实 DOM 调用**;真正耦合 DOM 的是 `editor/extensions.ts`(**48 处** DOM 调用)与 `ai/protocol.ts`(3)/`ai/tools.ts`(5)。**无 Electron/主进程依赖**。因此 `packages/cli` 的做法是在导入前**装一个 jsdom**(`packages/cli/src/dom.ts:14-67`,注释:"need a DOM to exist, not to be seen")。→ 库内文件型 `DocsEditor` = **在 jsdom shim 下跑既有 `applyDocOps`**;`jsdom` 作为库依赖(external)保留,**这不是纯无 DOM 模块**。sheet/slides 侧无此问题(xlsx 走 `xlsx-gateway` 纯 TS;pptx 走 `pptx-ops`)。

```
openFile → 实现 Editor 接口 → skill 调工具 → 变更收集 → 保存回字节
```

要点:①所有变更走 CLI 已有的 `applyDocOps` / `writeWorkbook` / `applyOps`;②保存必须**原字节保真**(沿用 OOXML 段落 patch,而非重新生成);③工具名(`ALL_DOCS_TOOL_NAMES` / `ALL_SHEETS_TOOL_NAMES` / `ALL_SLIDES_TOOL_NAMES`)与 app 内完全一致,宿主 prompt 才能复用;④`cross_office_workflow` 需要宿主提供 `OfficeWorkflowCallbacks`(`readSpreadsheet` / `composeDocument` / `composeSlides`),由库用三个引擎实现后注入。

### 5.4 Node `SkillContext` + 原生资源定位

- 新增 `createNodeSkillContext(...)`:实现 `SkillContext`(workspace/llm/storage/emitProgress/cancel)。仓库现存唯一实现是 `apps/docs/src/renderer/ai/AiPanel.tsx`(渲染层),需下沉为库内 Node 版本。
- 复用 `packages/cli/src/resources.ts` 的定位策略:`GENOFFICE_PDFIUM_WASM`、`GENOFFICE_XLSX_SIDECAR`、OCR helper;打包产物旁放 `wasm/`、`native/`、`ocr/`。

### 5.5 分发(与 aiwork 的 submodule 现实对齐)

`aiwork` 已经把 genoffice 作为 **git submodule** 放在 `vendor/genoffice`(branch `release0919`),用 `npm ci && npm run build:web` 构建。因此**不需要发布到 npm 公共源**:

1. genoffice 侧:`npm run build:office-ai` 产出 `packages/office-ai/dist/`(ESM+CJS+d.ts+资源)。
2. aiwork 侧:`pnpm add ./vendor/genoffice/packages/office-ai`(或 workspace `file:` / 直接 copy `dist`),把 `@genoffice/office-ai` 加进 `apps/server` 的 deps。
3. `externalizeDepsPlugin`(electron-vite)不涉及 aiwork;tsup/tsc 下确保 `@genoffice/office-ai` 被 bundle 或作为依赖安装。
4. 升级 submodule 后必须跑一次库契约测试(见 §7)。

### 5.6 aiwork 侧接入(替换 HTTP → 进程内)

aiwork 今天的 GenOffice 触点已清点清楚(文件级):

| 现状(文件:行) | 实质 | 改为 |
|---|---|---|
| `apps/server/src/office/genoffice.ts:20` `call()`;`GENOFFICE_URL`/`TOKEN`(`env.ts:35,91`) | HTTP 客户端 + 10s 超时 + `GenOfficeError{stage}` | **保留**(仅编辑器所需);无头调用改进程内 |
| `genoffice.ts:70/75/81` `/api/v1/auth/jwt` + `/embed/nonce` + `/embed/verify-nonce` | 为 iframe 铸三级 guest JWT(scope: files:read 等,ttl 1800) | 保留 —— **这是编辑器会话,不是文档能力** |
| `genoffice.ts:96` `/api/ipc/web:write-temp-file`(`stageFile`)、`genoffice.ts:123/127` `ai:set/get-settings` | 把字节送进服务临时文件 / 推宿主模型配置 | 编辑器路径保留;无头路径由库消除 |
| `apps/server/src/office/proxy.ts:13` `/office-engine` 反代 + `officeRequestAllowed()` 白名单 | 浏览器经宿主反代打到 genoffice,剥离 cookie/注入 operator token | 保留(编辑器 iframe 需要) |
| `apps/server/src/rpc/office.ts:8` `open` → `mintEmbedSession` → `OfficeSession` | 会话铸造 | 保留 |
| `apps/server/src/http/office.ts` `content`/`stage`/`save` + `office/versions.ts` CAS | **宿主自己的**云盘字节桥与版本(100MB 上限) | 保留 —— 这正是"字节由宿主传入/传出"的现成实现 |
| 无头能力(格式转换、预览、文档读写)目前无独立入口,只能绕 iframe/HTTP | 缺件 | **新增** `import { convert, readDocument, writeDocument, officeTools } from '@genoffice/office-ai'`,`apps/server` 进程内直调 |
| `apps/server/src/kb/extract.ts`(unpdf / mammoth / `lib/xlsx`)、`kb/ocr.ts`(vision OCR) | aiwork **已有**自己的抽取/OCR 栈 | **不替换**;仅在"保真读写/格式转换"上引入库能力补齐 |
| `apps/server/src/translate/*`(`docx.ts` 字节保真改写、`pdf.ts` pdf-lib、`service.ts` `xlsToXlsx` + 术语表) | aiwork **已有**完整翻译栈,且 proxy 已明确**拒绝** `/api/ai/translate` 与 15 个 `TRANSLATION_CHANNELS` | **不引入** genoffice 翻译;见 §6.1 |
| AI 生成/编辑文档需起 iframe 或 HTTP | 缺件 | 用档 2 的 `officeTools` 挂到 `@dfn/agent-kernel`(pi 1.0.4)工具集,由 aiwork 自己的 agent 驱动 |

> 边界原则:**"在线编辑器 UI" 仍走 iframe 服务;"无头文档处理" 走库。** 关键在于 aiwork 现有的 HTTP 触点**几乎全是编辑器会话**(JWT/embed/nonce/settings/反代),而非"文档 AI"。真正需要库化的只有**目前根本没有入口**的那一块:headless 读写/转换/渲染。

### 5.7 与 aiwork 既有决策的对撞检查(必须先读,避免方案打脸)

aiwork 侧已有若干 ADR,直接约束本方案:

| ADR / 文档 | 结论 | 对本方案的影响 |
|---|---|---|
| `ADR-2026-10-04-pi-agent-kernel.md` | **已否决**"复用 GenOffice `@genoffice/agent-core`",自建 `agent-kernel`(pi 1.0.4) | **档 3 `createOfficeAgent` 不作为 aiwork 的交付面**;aiwork 只取档 1 + 档 2 的工具定义,agent loop 用它自己的 |
| `ADR-2026-10-05-document-translation.md` + `plans/2026-10-07-genoffice-translation-analysis.md` | aiwork 自建翻译栈,并**主动阻断** genoffice 翻译通道 | 方案里**不再建议**把翻译改成库内 `translation-core`;翻译保持 aiwork 自持 |
| `ADR-2026-10-04-genoffice-online-editing.md` | 子模块 + 三个容器 + 白名单 + 三级 embed + 不用 genoffice 做存储 + 版本化 | 与本方案"编辑器保留"一致;库化是**增量**,不推翻该 ADR |
| `ADR-2026-10-06-office-large-file-open.md` | `stage` 端点 + 流式(依赖 genoffice 提交 `29e6245d`) | 大文件路径仍走编辑器链路,库不介入 |
| `apps/server/src/contracts` `OFFICE_EXTENSIONS` | 只认 `docx/xlsx/pdf/md/markdown/html/htm`,**不含 pptx/doc/xls** | **库化后可补 pptx 能力**,但 aiwork 的字节桥/版本化需同步扩这个枚举(小改) |

**没有**任何现存 ADR/plan 主张"把 SaaS 进程换成进程内库"——所以本方案是新增方向,需要在 aiwork 侧**新建一条 ADR** 记录取舍(依赖 `vendor/genoffice` 的库入口、格式枚举扩展、哪些能力留 HTTP)。

### 5.8 分发与部署现状(genoffice 侧无需改动)

`deploy/ora/compose.yml` 三容器: `db`(pgvector/pg16)、`genoffice`(`Dockerfile.genoffice`: rust 阶段编 `xlsx-sidecar`,node:22 拷预构建渲染器)、`app`(`Dockerfile.server`,env `GENOFFICE_URL=http://genoffice:8080` + `TOKEN`)。`deploy.sh` 在 `vendor/genoffice` 未构建时**拒绝部署**。

库化**不改这套**:编辑器仍需该容器。新增的只是 `apps/server` 多一条 `@genoffice/office-ai` 依赖(来自 submodule 的 `packages/office-ai/dist`)。`Dockerfile.server` 的构建需确保 `vendor/genoffice/packages/office-ai/dist` 已随 submodule 一起构建产物——建议在 `deploy.sh` 打包步骤前加一步 `npm run build:office-ai`,并在 genoffice 未构建时同样拒绝。

### 5.9 Office「编辑器功能」的支持策略(本轮新增需求)

需求新增"支持相关的 office 编辑器功能"。**先区分三种"编辑"含义**再决定投入,否则会把"能改文件"和"有编辑界面"混为一谈:

| 含义 | 今天的实现 | 库化方案 | 成本 |
|---|---|---|---|
| **E1 程序化 / 无头编辑(op 级)** | `applyDocOps`(docx)/ 工作簿 DSL(`xlsx-dsl.ts`,约 30 个 op:`set_cell`/`set_formula`/`format_range`/`merge_cells`/`add_chart`/`set_freeze`…)/ pptx `applyOps` | 已规划为**档 1 + 档 2**(§3.1 / §5.3);**sheet/pptx 纯 TS,docs 需 jsdom shim** | 低(在最小改造内) |
| **E2 页内所见即所得编辑器(host 直接内嵌组件)** | **不存在**(全部是单体 `App()`,无 `exports`) | 抽出编辑器组件 + **注入进程内传输替代 web-server `/api/ipc/*`** | **高**(牵动 app 外壳,单列 M3) |
| **E3 iframe 编辑器(现状)** | `@genoffice/web-sdk` 的 `createEditor()` + `/embed/:docId` + `/api/ipc/sdk:command` | **保持**;库不接管 | 零 |

**证据(源码级)**:
- **不存在任何可复用的编辑器组件(核实为 absent)**。`apps/docs/src/renderer/App.tsx:600`、`apps/sheets/.../App.tsx:456`、`apps/slides/.../App.tsx:327` 各是**单体 `export function App()`**;编辑器实例内联其中(docs `useEditor` at `App.tsx:987`;sheets `createUniver` at `:1505`;slides `SlideCanvas.tsx:525` 只是画布、非"文件+onChange"编辑件)。三个 app 的 `package.json` 均 `"private": true` 且**无 `exports`**,唯一入口是 Electron `main`。→ **E2 是真重构**,不是"导出一下"。
- **引擎**:docs = Tiptap `3.31`/ProseMirror;sheets = Univer `0.25.1`(~17 个 `@univerjs/*` presets + **Rust sidecar**);slides = 自研 React + Konva `9` + harfbuzzjs。
- **Electron 依赖已被中和(好消息)**:三个 app 都带 `web-bridge.ts`,以 `if (!isElectronRuntime())` 在浏览器模式下**用 HTTP/SSE 顶替 Electron 全局**(`window.desktop`/`desktopApi`/`slidesApi`)。→ E2 的**真正阻塞不是 Electron,而是对 web-server `/api/ipc/*` 传输的依赖 + 单体**。
- `apps/web-server/src/embed/index.ts:190-192`:embed 并不加载专用 editor bundle,而是**直接托管 app 自己的整包渲染产物**(`<STATIC_ROOT>/<app>/out/renderer/index.html`)再注入 bridge(`:350-445`)。
- **现有"编辑器功能"契约**(`apps/sdk/src/types.ts`):命令 30 个(`setContent`/`getContent`/`insertText`/`insertImage`/`undo`/`redo`/`save`/`isDirty`/`downloadAs`/`print`/`focus`/`setTheme`/`setLang`/`setMode`/`aiRewrite`/`aiTranslate`/`aiSummarize`/`getUndoStack`/`setTrackChanges`/`acceptChange`/`rejectChange` + comments 4 + versions 3 + sidebar 4 + `reportUsage`);事件 10 个(`ready`/`saved`/`dirtyChanged`/`selectionChange`/`error`/`closed`/`commentAdded`/`commentResolved`/`sidebarMessage`/`usage`)。Dataflare 信封另有一套(`dataflare/types.ts`)。**库若做 E2,应对齐这张表而不是另造。**
- aiwork 侧已自建 Tiptap `3.31` + Yjs `13.6`(`@dfn/editor-schema`)承载其原生云文档。→ **aiwork 缺的不是"编辑器 UI",而是"对真实 Office 文件(docx/xlsx/pptx)的保真编辑"。**

**结论(三层落点)**:
- **E1 = 主交付面**。它覆盖"编辑功能"的实质:程序化修改 docx/xlsx/pptx **并保真保存**(而非重新生成)。这正是 aiwork 真正缺、且今天完全无入口的能力。
- **E3 = 原样保留**。需要完整 WYSIWYG 的宿主继续用 iframe SDK,`/embed` 与 `sdk:command` 不动,零成本。
- **E2 = 单列里程碑 M3(可选,不阻塞 M0–M2)**。把 `apps/{docs,sheets,slides}` 的编辑器核心抽出为 `@genoffice/office-ai/editor`(React 组件,输入 bytes + `onChange`/`onSave`,在宿主 Web 页内挂载,不再需要 `/embed` 服务)。**关键手法**:编辑器代码沿用不动,只**注入一个实现 `@genoffice/ipc-bridge/client` 同形接口的"进程内传输"**替换 web-bridge 里的 HTTP/SSE——这样解耦面收敛到"传输"一处。**前置条件**是组件与 app 的 `router`/store 分离,本质是 §5.2 **B2 抽包**的产物,工作量与风险**并入 B2**,不新增独立评估。**M0–M2 不做。**

> 一句话:**"编辑器功能"先以"能保真地程序化编辑 Office 文件"(E1)交付;要"页内所见即所得"(E2)则走 B2 抽包 + M3;iframe 编辑器(E3)维持现状。** 三者不互相排斥,避免把最小改造拖成编辑器重构。

---

## 6. 与 pi / 宿主既有能力的边界(必须先决定的约束)

### 6.0 pi 版本分裂

两个仓库都用 `@earendil-works/pi-*`,但**版本不同**:

| 仓库 | 版本 |
|---|---|
| genoffice | `^0.85.1`(`agent-runtime`/`agent-session`/`agent-skills`/`agent-telemetry`) |
| aiwork `packages/agent-kernel` | `1.0.4` |

**风险**:若库直接携带 pi 依赖,会导致宿主里出现两份 pi,或 API 不兼容而运行期炸。

**对策(按优先级)**:
1. **档 1 + 档 2 不依赖 pi**(文档引擎与 skill 工具定义本身与 pi 无关),这是默认交付面——`aiwork` 用它自己的 pi 1.0.4 去调 `officeTools`。
2. 档 3(`createOfficeAgent`)才需要 pi,但 aiwork 已在 `ADR-2026-10-04-pi-agent-kernel.md` **明确否决复用 `@genoffice/agent-core`**。因此档 3 **不作为对 aiwork 的交付承诺**;仅在"无 agent 的第三方宿主"场景下,把 pi 作为 **peerDependency / optional** 提供。
3. 若确需 pi 版 runtime,单独把 genoffice 的 pi 升到 `1.0.4`,并对齐 `agent1.md` 的迁移计划,不混在本次最小改造里。

> 结论:本方案对 aiwork 的实际交付面 = **档 1(引擎)+ 档 2(工具定义)**;档 3 只服务其他宿主。

### 6.1 翻译 / KB / OCR 的归属(不越界)

aiwork 已经独立建成并**主动隔离**了这三块(见 §5.7):`translate/*`(字节保真 docx 改写、pdf-lib、`xlsToXlsx` + 术语表)、`kb/extract.ts`(unpdf / mammoth / xlsx)、`kb/ocr.ts`(vision OCR)。其 `/office-engine` 反代甚至**显式拒绝** `/api/ai/translate` 与 15 个 `TRANSLATION_CHANNELS`。

因此:
- **库不接管翻译/KB/OCR**;`@genoffice/translation-core` 只作为"给**没有**自己翻译栈的宿主"的可选项暴露在档 3,不进 aiwork 的交付面。
- 库只补 aiwork **真正缺**的那块:**保真读写(op 级编辑)、格式转换矩阵、无头渲染**(§3.1 档 1 + §3.2 档 2)。
- 若 aiwork 未来想合并两套翻译栈,那是**另一条独立决策**,需新 ADR,不在本次最小改造内。

---

## 7. 验证矩阵

沿用"唯一验收门"思路,分层验证:

| 层 | 验证 |
|---|---|
| L0 引擎 | 复用各包既有测试;facade 新增 contract test(`packages/office-ai/tests`):对同一批 fixture 做 read→write→read 往返,断言字节语义不变 |
| L1 Provider | 用一个 stub HTTP server 断言 `ai-provider` 的 BYOK 流式可用(不真连厂商) |
| L2 Skills | 给定 docx/xlsx/pptx fixture,`officeTools` 全工具各跑一次,断言产出可被 L0 重新读回 |
| L2 编辑保真 | 对同一文件做 `read → applyDocumentOps(改一处) → write`,断言**未改部分字节/样式不变**、被改处生效,并用 Word/Excel/LibreOffice 各打开一次不报修复 |
| L3 Agent | `createOfficeAgent` 用 stub provider 跑一条 `genoffice.agent.v1` 请求,断言 `AgentResult.stopReason` |
| 打包 | `npm run build:office-ai` 后,**在 genoffice 之外的临时目录** `node -e "import(...)"` 冒烟,确认无相对路径泄漏、wasm/sidecar 可定位 |
| aiwork 集成 | `aiwork: pnpm verify` + 一条端到端:上传 xlsx → 库内 read → AI 生成 op → 库内 write → 下载,断言内容与格式 |

**回归红线**:不得让既有 `apps/web-server` 与 `apps/sdk` 的任何测试变红(库化是**增量**,不是替换)。

---

## 8. 明确不做的事(最小化的边界)

- ❌ 不拆仓库、不把 `apps/web-server` 删掉(交互式编辑器仍需);aiwork 的三个容器与 `/office-engine` 反代**保持**。
- ❌ **M0–M2 内不重构编辑器外壳**(E2):不把编辑器 app 拆成组件、不动其 `router`/IPC bootstrap。E2 单列 M3(§5.9),随 B2 抽包进行。
- ❌ 不重写文档引擎,不引入"第二套 op 语法"。
- ❌ 不在库里做鉴权、多租户、用量计费、限流、审计落库。
- ❌ 不把 `file-management`(S3/local 存储)作为默认依赖——字节由宿主传入/传出(aiwork 的 `http/office.ts` + `versions.ts` 已是现成实现)。
- ❌ **不接管翻译 / KB / OCR**——aiwork 已自建并主动隔离(`ADR-2026-10-05-document-translation` + `plans/2026-10-07-genoffice-translation-analysis`);库只在档 3 对"无翻译栈的宿主"可选提供。
- ❌ **不把 `createOfficeAgent`(档 3)作为对 aiwork 的承诺**——aiwork 的 `ADR-2026-10-04-pi-agent-kernel` 已否决复用 `@genoffice/agent-core`(见 §6.0)。
- ❌ 不做 `docx→pdf` 的纯 TS 实现(需要布局引擎);该能力以"可选边车"或"宿主自理"处理。
- ❌ 不为了"公网 npm 发布"而搬迁 33k+13k 行 app 渲染代码(先打包内联,详见 §5.2 B1)。
- ❌ 不改 aiwork 的 `OFFICE_EXTENSIONS` 之外的现有契约(补 pptx 需同步该枚举,属**独立小改**,不是库的前置)。

---

## 9. 路线图

| 里程碑 | 内容 | 交付判据 |
|---|---|---|
| **M0(1 周)** | `packages/office-ai` 骨架 + 档 1(docx/xlsx/pptx/pdf 读写 + convert)+ esbuild 打包 + `dist` 冒烟 | 宿主外目录 `import` 成功;往返测试绿 |
| **M1(1–2 周)** | 5.2 反向依赖内联落地 + 档 2(文件型 Editor 适配器 + Node SkillContext + `officeTools`)+ 格式矩阵补全(md/html/csv、旧格式读) | 15 个 skill 在 headless 下各跑通一次 |
| **M2(1 周)** | 档 3(`createOfficeAgent`,pi 作为 optional peer,**非 aiwork 交付面**)+ aiwork 侧首个能力切换(headless read→AI op→write)+ aiwork 侧新建一条 ADR 记录取舍 + 契约测试进 CI | aiwork `pnpm verify` 绿;`deploy.sh` 增加 `build:office-ai` 前置;编辑器容器保持 |
| **M3(可选,1–2 周)** | **E2 页内编辑器**:随 §5.2 B2 抽包,把 `apps/{docs,sheets,slides}` 编辑器核心抽为 `@genoffice/office-ai/editor`(React),宿主 Web 直接挂载 | 组件在宿主页内渲染并 `onSave` 回字节;不依赖 `/embed` 服务 |

> **编辑器功能落点**:M0–M2 交付的是 **E1(程序化保真编辑)**——"能改 docx/xlsx/pptx 并保存";**E3(iframe 编辑器)**维持现状;只有需要"页内所见即所得"时才做 **M3(E2)**。

> M2 的 aiwork 侧"首个能力切换"建议挑 **AI 生成 xlsx / docx 的 op 编辑回写**(aiwork 今天完全没入口的能力),而**不是**翻译(那是 aiwork 自持栈,见 §6.1)。切错能力会让方案与既有 ADR 直接冲突。

工作量估算:facade **1.5–2.5k 行**;若走 B2 抽包另加 5–8k 行的搬迁+回归(不作为 M0–M2 前置)。

---

## 10. 一句话交付承诺

**用约 2k 行的 facade,把已经存在的 headless 引擎/Skill/Provider 组合成一个可 `import` 的 `@genoffice/office-ai`(导出面见 §3.4),在宿主进程内提供 docx/xlsx/pptx/pdf(+md/html/csv)的读写、转换与 **op 级保真编辑**(`.doc/.ppt/.xls` 提供文本读取,`.xls` 另可转 xlsx;旧格式完整读写经**可选** LibreOffice 适配器,§4.3);让 `aiwork` 在其自身 Node 进程(`apps/server`)里直接调用这些能力,而不再为"无头文档处理"起独立 SaaS 容器——**交互式编辑器 iframe(E3)与 `/office-engine` 反代保持不变**,翻译/KB/OCR 仍由 aiwork 自持。若需"页内所见即所得编辑器"(E2),走 §5.2 B2 抽包 + M3,不阻塞主线。**

达成判据:§3.4 清单全部可从宿主 `import`;§7 验证矩阵全绿;`apps/web-server` 与 `apps/sdk` 既有测试不变红。

---

## 11. 实施状态(2026-10-08,档 1 + 档 2 已落地,aiwork 已接)

代码在 `packages/office-ai/`(未提交)。交付 **档 1(document engine)** + **档 2(会话与工具层)** 的可运行、宿主外可 `import` 的实现,并在 `~/dataflare/aiwork` 内跑通端到端。

### 11.1 已实现的导出面

| 文件 | 内容 |
|---|---|
| `src/index.ts` | 公共入口:18 个运行时导出 + 类型 |
| `src/detect.ts` | `detectFormat(bytes,{hint})` — 签名嗅探(`%PDF-` / OLE2 / ZIP 内 `word/document.xml`\|`xl/workbook.xml`\|`ppt/presentation.xml`)→ pdf/ole(扫 WordDocument/PowerPoint/Workbook/Book)/docx/xlsx/pptx/odt→html→txt;`formatExtension` |
| `src/errors.ts` | `OfficeError` + `isOfficeError` + `OfficeErrorCode = OFFICE_UNSUPPORTED \| OFFICE_NEEDS_APP \| OFFICE_NEEDS_SIDECAR \| OFFICE_BAD_INPUT \| OFFICE_INTERNAL` |
| `src/internal.ts` | `LibContext{cwd,env}`(结构化对齐 CLI `PathContext`)、`makeCtx`、`withTempDir`、`readScratch`、`decodeText` |
| `src/views.ts` | 自有的**视图载荷类型**(`BlockSummary`/`DeckSummary`/`PdfInfo`/`CsvInfo`/…),不 re-export `@genoffice/*`,使发布的 `.d.ts` 自包含 |
| `src/sheet-view.ts` | **纯 TS 工作簿读**:`readWorkbookView(Buffer)` → `{workbook: WorkbookView, sheets: Map<name, SheetGridView>}`,走 `xlsx-gateway/readBasicWorkbook`,零 sidecar;`coordinatesOf`(对 `parseAddress` 抛错包 try/catch) |
| `src/documents.ts` | 档 1 主体(见下) |
| `src/session.ts` | **档 2**:`openSession(bytes)` → `DocumentSession`(`read`/`edit`/`save`/`render`/`bytes`),打开一次、改多次、导出一次 |
| `src/tools.ts` | **档 2**:`officeTools(opts)` → 14 个宿主无关工具(`OfficeTool{name,description,parameters,execute}`)+ `OFFICE_TOOL_NAMES` |
| `src/file-editor.ts` | **档 2 (§5.3 缺件)**:`openDocsFile(bytes)` / `openSheetsFile(bytes)` —— 文件型编辑器适配器,实现 `DocsEditor` / `SheetsEditor` 契约(见 §11.7) |

运行时导出:`readDocument` `writeDocument`(=`applyDocumentOps` 别名)`applyDocumentOps` `applyDocxOps` `applySheetOps` `applySlidesOps` `convert` `render` `NODE_ROUTES` `APP_ROUTES` `detectFormat` `formatExtension` `OfficeError` `isOfficeError` `openSession` `sessionExtension` `officeTools` `OFFICE_TOOL_NAMES` `openDocsFile` `openSheetsFile`。

### 11.2 分档能力(实测)

**档 1 — 文档引擎**

- **读** `readDocument(bytes, opts) → DocumentView`:docx(blocks/html/comments/revisions/headerFooter)、xlsx/xlsm(workbook+sheet 网格,纯 TS)、pptx(deck)、pdf(info+text)、csv、md/html/txt;`doc`/`ppt` 走 `file-parse` 取文本;`xls/xlsb/ods` 暂只返回空文本(需先转 xlsx)。
- **写** `applyDocumentOps`:`docx`(op 级,经 jsdom shim 的 `applyDocOps`)、`pptx`(`pptx-ops` 逐 op 原子校验)、`xlsx/xlsm`(`xlsx-dsl` + `writeWorkbook`,纯 TS)。
- **转换** `convert(bytes, from, to)`:`pdf→docx|pptx|xlsx`、`csv→xlsx`、`md→docx|html`、`docx→md`、`xlsx|xlsm→csv`(纯 TS,不碰 sidecar)。落在 `APP_ROUTES` 的边抛 `OFFICE_NEEDS_APP`;`xls|xlsb|ods→xlsx` 抛 `OFFICE_NEEDS_SIDECAR`;其余抛 `OFFICE_UNSUPPORTED`。
- **渲染** `render(bytes, opts)`:仅 pdf(pdfium wasm),其余抛 `OFFICE_NEEDS_APP`。

**档 2 — 会话与工具层(宿主无关,不依赖 pi)**

- **会话** `openSession` 把"打开一次、反复编辑、最后导出"变成有状态对象;`edit` 用 `format` 提示保证写路径与打开格式一致;`save(to)` 只在导出时转换,不动会话自身格式。
- **工具** `officeTools()` 返回 14 个 `OfficeTool`:`get_document_context` `read_document` `read_blocks` `insert_content` `replace_blocks` `replace_document` `apply_ops` `read_range` `find_cells` `aggregate_range` `set_cells` `read_comments` `convert_document` `render_pages`。每个工具是 JSON Schema + `execute(args) → {text,data?,files?}`,**失败不抛错**而是回 `data.error`,让 agent 循环能看见并改道;`only` 可裁剪工具集,`maxChars` 控单次读的截断上限。
- `replace_document` 落到 `replace_blocks(0, N-1)`(引擎没有 `replace_document` op),`set_cells` 里以 `=` 开头的值走 `set_formula`。
- **文件型编辑器** `openDocsFile` / `openSheetsFile`:实现 `DocsEditor` / `SheetsEditor` 契约的编辑器适配器(§11.6),让"打开文件 → 编辑器语义读写 → 保存回字节"这条链不依赖 Electron/React。

### 11.3 打包与资源定位

- `build.mjs`:**CJS 为主产物**(`dist/office-ai.cjs`,18.2 MB),ESM(`dist/office-ai.mjs`)是**生成的再导出外壳**(`createRequire` + 由 esbuild `metafile.exports` 数组驱动的具名再导出,名称不漂移)。之所以 CJS 为主:内联的 CJS-only 依赖(如 `word-extractor` 在 ESM 下 `require('buffer')`)无法在 esbuild 的 ESM 输出里模拟 `require`,会抛 "Dynamic require is not supported"。
- `external: ['electron','jsdom','mermaid']`;`jsdom` 作为依赖随包(`node_modules`),`mermaid` 仅惰性图表渲染触达、headless 不跑。
- 两处**加法式**资源回退:`packages/cli/src/dom.ts` 的 `loadJsdom` 在找不到自身 node_modules 时回退 import 宿主的 `jsdom`;`packages/cli/src/resources.ts` 的 `pdfiumWasmPath` 回退 `dist/wasm/pdfium.wasm`。`build.mjs` 把 wasm 拷到 `dist/wasm/`。
- `types` 指向 **`dist/types/index.d.ts`**,由 `tsconfig.build.json`(`emitDeclarationOnly` + `rootDir: ../..` + `noCheck`)产出。`noCheck` 是必需的:实现程序会传递性拉进 `apps/docs/src/renderer/**` 等兄弟包/应用源码(工作区包直接导出 `src/*.ts`),它们缺 DOM 类型;真正的类型检查仍由 `npm run typecheck` 用开发 tsconfig 跑。**注意 `rootDir` 不能是 `src`**:tsc 会为程序里每个 `.ts` 发射声明,而 rootDir 之外的源文件会被**就地**写出 `apps/*/src`、`packages/*/src` 里(2026-10-08 实测一次构建散落 508 个),`noCheck` 只压掉 TS6059 报错、不阻止发射。改为仓库根做 `rootDir` 后整个闭包镜像落在 `dist/types-all/`,`build.mjs` 只保留自有子树到 `dist/types`(22 个 `.d.ts`)。产出的 `.d.ts` **零外部 import**,只 `from './…'` 和 `node:`。
- `package.json` 只声明一个真依赖 `jsdom`;**不声明** `@genoffice/cli`/`@genoffice/file-parse` 的 peer。原因是宿主 aiwork 的 `.npmrc` 开着 `auto-install-peers=true`,任何列出的 peer 都会被 pnpm 拉去 registry 解析(而这两个包不在任何 registry 上 → `ERR_PNPM_FETCH_404`)。这两条 peer 本也无用:引擎已被 esbuild `bundle` 内联,产出的 `.d.ts` 又零外部 import(见上),所以拿不到类型也少不了类型。

### 11.4 验证(全绿)

- `npx tsc --noEmit` @ `packages/office-ai` — 通过。
- `npx vitest run` @ `packages/office-ai` — **29/29 通过**(`tests/roundtrip.test.ts` 9 个档 1;`tests/session-tools.test.ts` 13 个档 2:会话读改存/导出不改格式/拒空文档;工具名表与 `only`;未打开文档时回 `data.error` 不抛;工作簿 context→range→写→find→aggregate;`convert_document` 出文件;拒绝映射;docx 工具编辑全链路;`replace_document`;`apply_ops` 格式化;会话交接;**`tests/file-editor.test.ts` 7 个文件型编辑器**:docs 结构读/clamp 归一/插入/替换/保存回读、`applyOps` 干跑与原子拒绝、sheets 摘要/读区/聚合/查找/特性、双双拒空文档)。
- `npm run build` — CJS 18.2 MB + ESM 外壳(20 个具名导出,含 `openDocsFile`/`openSheetsFile`)+ `dist/types/*.d.ts`(10 个,自包含,零外部 import)+ `dist/wasm/pdfium.wasm`。
- **宿主外冒烟**(`/tmp/oa-smoke`,只符号链接 `node_modules` 与包目录,无 monorepo 相对路径):ESM `import` 与 CJS `require` 均成功;xlsx 读/写/往返、docx 改、pdf 读/render(wasm 回退命中)/pdf→docx 全部通过;文件型编辑器亦在其上跑通(见 §11.6)。
- **aiwork 端到端**:见 §11.5。

### 11.5 aiwork 接入(已跑通)

接入方式按用户选定:**pnpm workspace 直连 submodule 包**(不是 `file:` 依赖,也不是只做 dev symlink)。

- `~/dataflare/aiwork/pnpm-workspace.yaml` 增加 `vendor/genoffice/packages/office-ai`;`apps/server/package.json` 增加 `"@genoffice/office-ai": "workspace:*"`;包已物化到 `vendor/genoffice/packages/office-ai`(23 MB,含 `dist/`)。
- `apps/server/src/office/local.ts` —— aiwork 侧适配层,三件事:①`OfficeLocalError`(把 `OfficeError.code` 映射成中文产品文案 + `stage`);②`readOffice`/`editOffice`/`convertOffice`/`renderOffice`/`officeRoutes` 直通档 1;③`createOfficeServer()` 把 `officeTools()` 包装成 aiwork 自己的 **`LocalMcpServer`**,`officeMcpSpec()` 给出可直接挂载的 `McpServerSpec`(并把非只读工具标成 `sideEffect: 'write'`,而不是内核默认的 `'external'`)。
- `apps/server/test/office-local.test.ts` —— **8/8 通过**:档 1 往返(xlsx csv→xlsx→改→读→csv、docx md→docx→改→读→md、pdf 读/render)、本地化类型化错误、能力探针;档 2 经 `connectMcpServers` 真实挂载(工具名 `genoffice__*`、`read_range`→`none`、`set_cells`→`write`、`parameters` 透传)、读→写→`save` 全链路、工具失败以 MCP error 冒出。
- 内核**未改**:`packages/agent-kernel/src/mcp.ts` 保持原样 —— 它对本地 server 也套 `<external>` 包装,而 `read_range` 返回的正是用户自撰的单元格文本(注入面),这个既有决定是对的,不改。

### 11.6 文件型 Editor 适配器(§5.3 缺件,已落地)

`src/file-editor.ts`。这是 §5.3 标记的"核心缺件":`agent-skills` 的扩展要跑 headless,必须先有人实现 `DocsEditor` / `SheetsEditor`。

- **接口就地声明,不 import `@genoffice/agent-skills`**。那两个契约是纯 TS 形状,而 skill 包会拖进 pi(`@earendil-works/pi-coding-agent`)与 React UI 适配器——headless 宿主用不上。结构化类型让本模块的 `DocsEditor`/`SheetsEditor` 与原版**互相可赋值**,原样传给 skill 也能过类型检查。这与 §11.3 "不声明 peer" 是同一条理由。
- **`openDocsFile(bytes)` → `OpenDocsFile`**。`read()` 侧的引擎文档常驻内存,所以除 `save()` 外**全是同步**——与渲染层 Tiptap 编辑器同一语义。读走 `describeDocument`/`blockRangeHtml`;html 改写走 `protocol.parseHtmlFragment` + `replaceBlockRange`/`insertBlocksAfter`;格式批量走 `ops.executeOps`(即 `apply_ops` 的同一执行器)。`save()` 用 `saveDocument` 序列化,**保存后文件仍可继续编辑**。
  - `applyOps(ops, dryRun)` 是原子的:`executeOps` 先整批校验,一条不合格就整批拒绝,抛 `OFFICE_BAD_INPUT` 且文档分毫不动(有测试守)。`dryRun` 走引擎自己的 `ctx.dryRun` 分支,只出计划不落地。
  - 两处**如实降级**:`replaceSelection()` 恒回 `{replaced:false}`(headless 没有用户选区,谎报送 `true` 会让调用方以为改成功);`markDocSeen()` 是空操作(渲染层用它挡"模型上次读之后文档被别人改过"的陈旧索引,而文件型编辑器的唯一写者就是它自己)。
- **`openSheetsFile(bytes)` → `OpenSheetsFile`**。读走 §11.1 的 `readWorkbookView`(纯 TS,零 sidecar),开一次后全同步。`SheetsEditor` 唯一的写方法是可选的 `createNewDocument`,文件型宿主建新文档应该走 `writeDocument`,所以这一侧**读即完整**。
  - 已知边界:`readRange` 的单元格只报 `raw`(数字还原成 number),**不做数字格式化**——这与 `readWorkbookView` 的取舍一致(日期回 serial);`getSheetFeatures` 返回空 `mergedRanges`/`frozenPanes`,因为无 sidecar 的读路径只保单元格值,不猜。
- **未做:`openSlidesFile`**。`SlidesEditor` 的载荷要 `layoutName`(当前 headless deck 读取层没有),写侧要 `DeckPlan`/`SlideScript`;只做只读会是有损的,故留待 pptx 引擎补出布局名之后。
- **验证**:`tests/file-editor.test.ts` 7 个用例(全绿)。宿主外(`/tmp/oa-smoke`,相对 `dist` 导入)实测:md→docx→`insertBlocks`/`replaceBlockRange`/`applyOps(setHeadingLevel→3)`→`save`→`readDocument` 文本含全部改动、`docx→md` 首行 `### 改过的标题`(标题级别改动确实穿过保存落盘);csv→xlsx→`getWorkbookSummary`/`readRange`(数值为 number)/`aggregateRange`(sum/avg/count/min/max)/`findCells` 全部符合预期。
- **drop-in 实证(不是只看类型签名)**:临时探针直接调用 `@genoffice/agent-skills/extensions/docs-skill` 里**未改动的** `createGetDocumentContextTool` / `createInsertContentTool` / `createApplyOpsTool` / `createReplaceBlocksTool` / `createReadBlocksTool`,只把 `uiAdapter.getEditorInstance()` 指回本模块的编辑器对象。全链路通过:`apply_ops` 干跑回 `applied:0`,真跑回 `applied:1`;`replace_blocks(1,1)` 回 `{inserted:1,removed:1}`;保存后 `docx→md` 得
  ```
  ## Quarterly

  ### 补充说明

  补充说明。
  ```
  即三个真实 skill 工具造成的改动(`## `/`### ` 两级标题与追加段落)**全部穿过保存正确落盘**。探针跑完即删(它会把 pi 与整仓依赖拖进 vitest 的模块图,不适合留在包内套件里);包内套件仍是 3 文件 29 用例。

### 11.7 未做(诚实交代)

- **档 2 工具数是 14,不是 §3.2 草图的 26**。草图按"15 扩展 + 11 独立 skill"计;实现只落了**文档读写/编辑/转换/渲染**这一条主链(`officeTools` 的 14 个),翻译、KB、OCR、文档生成类 skill **按 §6.1 边界有意不进交付面**(aiwork 自持)。差额是设计取舍,不是缺口。
- **档 3 未做**:`createOfficeAgent` / AI runtime(`§3.3`)仍与 pi 耦合,不是 aiwork 的交付面(aiwork 用自己的 `@dfn/agent-kernel` 驱动档 2 的工具)。
- **15 个 pi skill 本体未进库**:§11.6 补的是**契约**(`DocsEditor`/`SheetsEditor`),让 skill 有得可跑;没有把 `@genoffice/agent-skills` 的 15 个扩展打进 `office-ai`。理由是可核的:`agent-skills` 的 dependencies 里有 `@earendil-works/pi-coding-agent` / `pi-ai` / `pi-agent-core`(本机 `node_modules` 实测 153 MB / 6.2 MB / 4.3 MB)与 `agent-runtime`(React UI 适配器),内联会把 pi 运行时拖进产物,而库的定位是"无 Electron、无 HTTP、无模型调用"。宿主若确实要跑那 15 个 skill,应把本模块的编辑器对象交给它自己的 agent 框架;§11.6 的结构化声明就是为了这条路径。(`SlidesEditor` 适配器见 §11.6 末条。)
- **未接 sidecar**:`xlsxSidecarPath()` 的 `dist/native/` 落地未做,故需要公式求值/超大表时仍要显式给 `XLSX_SIDECAR_PATH`;`xls|xlsb|ods→xlsx` 也因此报 `OFFICE_NEEDS_SIDECAR`。
- **workspace 链接已物化**:`pnpm install` 已在 aiwork 跑过,`pnpm-lock.yaml` 落定 `@genoffice/office-ai: link:../../vendor/genoffice/packages/office-ai`,13 个 workspace 项目全部 link 成功。**唯一的收尾**是在 genoffice 侧提交 `packages/office-ai`、再 bump `vendor/genoffice` submodule —— 在那之前,aiwork 的 lockfile 指着一个 submodule 里**尚未提交**的路径。
- **未提交**:所有改动留在两个工作树;并行会话共享 genoffice 树,提交前需按 memory 规则比对快照、只 `git add` 自己验证过的文件。


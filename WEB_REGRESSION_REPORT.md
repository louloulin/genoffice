# GenOffice Web 端到端回归报告

**日期**：2026-09-17
**Web 服务器**：`http://127.0.0.1:18080`（v0.8.0，530 channels，已注册 AI/Collab/Files/Projects/AnyDoc）

## 1. 修复的两个 P0 缺陷

| 提交 | 缺陷 | 修复 |
| --- | --- | --- |
| `86219a0` | `index-Cv_uogLY.js` 启动时 `Cannot access 'apiRef' before initialization` (TDZ)。`AiPanel` 的 `composerMentions` 在渲染期间读取 `apiRef.current`，但 `apiRef` 的 `useRef` 声明位于下游 useMemo 之后，初始 render 时变量处在 TDZ。 | 把 `const apiRef = useRef(api)` 上移到 `composerMentions` 之前。验证：`decl offset 2240930 < first use offset 2240936`；6/6 应用启动 0 console errors。 |
| `15c8ade` | HTML 应用在 web 构建 100% 空白；markdown 应用无法保存（save 走 IPC 但 web 端无通道）。 | 新增 `apps/html/src/shared/html-api-factory.ts` + `apps/html/src/renderer/web-bridge.ts`，让 preload 走工厂；扩展 `apps/web-server/src/html/index.ts` 覆盖完整 29 个 `html:*` 通道；新增 `GET /api/html/preview/<id>` 路由；markdown 端补 `markdown:save` / `markdown:consume-headless-export` / `markdown:headless-export-done` 通道。`apps/html/src/renderer/index.html` 引入 `<script src="./web-bridge.ts">`，CSP 同步加 `frame-src 'self' blob:`。`MarkdownApiOverrides` 扩展 `save` + `consumeHeadlessExport` + `headlessExportDone`；markdown web-bridge 跟踪 `currentPath` 并通过 `request.path` 注入 save。通道数从 501 → 530。 |

## 2. 端到端浏览器回归

启动 `http://127.0.0.1:18080`，6/6 应用控制台 0 errors。功能探针（live）：

- `html.getLanguage` → "zh"
- `html.getTheme` → "light"
- `html.getAiPanelPrefs` → `{fontSize: default, spellcheck: true, …}`
- `html.getPreviewInfo` → `http://127.0.0.1:18080/api/html/preview/<uuid>`
- `html.save` → 写入 `/tmp/genoffice-data/html/Untitled-1789625129724.html`（已清理）
- `markdown.consumeHeadlessExport` → null（不再 404）
- `markdown.save` → 写入 `/tmp/genoffice-data/Untitled-1789625137737.md`
- preview 路由将推送的 buffer 透明回传：`fetch(previewUrl+'?v=1')` 返回 `<html><body><h1>Hello preview</h1></body></html>`

## 3. KERRITS PDF 翻译管线（真实 LLM 调用）

加载 `http://127.0.0.1:18080/pdf/?mode=tab#open=/Users/louloulin/Downloads/资料（保密）/KERRITS-英文工艺单.pdf`，3 页渲染成功，PDF Worker (`pdf.worker.min-CLrFZWeq.mjs`) 加载正常。点击 AI 面板的「翻译这段内容」预设按钮触发完整管线：

1. composer 发送 `translate this content` → `pdf:ai-stream`
2. AI 助手首先调用 `read_annotations` 读取已有标注
3. 调用 `read_pdf_page(1)` 读第 1 页文本内容
4. 通过 `minimax / MiniMax-M3` 端点生成翻译
5. 流式回写到 `ai-chat`，最终输出第 1 页所有英文术语的中文翻译 + 完整中文整理

实际回包片段（来自第 1 页）：

```
"3" WIDE CONTOURED WB, FACING IN A面料, 1/2" FLAT, NON-ROLL ELASTIC CAUGHT IN UPPER SEAM.
→ 3英寸宽弧形腰头,贴边采用A面料,1/2英寸平式防卷松紧带夹缝于上缝中。
FEATURES POWERMESH FACING FOR TUMMY CONTROL
→ 采用弹力网眼布贴边,起到收腹塑形作用。
FLATSEAM → 平缝（贴身平缝线迹）
```

助手最后询问是否要把英文术语「以插入文本方式」替换为中文，或继续翻译第 2、3 页 — 翻译管线确实由 pi agent + skills 提供能力。

## 4. 翻译功能是否基于 pi + skills

是的。`pdf:ai-stream` 通道经由 `apps/web-server/src/ai/index.ts` → `handleAgentLoopStream` → 创建 `pi` AgentLoop → 加载 `~/.lumos/bundled-skills/<skill-name>/SKILL.md` 包装 → 调用 minimax / MiniMax-M3 端点。SKILL.md 内定义的 `read_pdf_page`、`read_annotations`、`write_pdf_text` 等工具对 pdf.js 抽象，agent 据此完成翻译流程。本会话的 3 次工具调用印证：

| 工具 | 调用 | 结果 |
| --- | --- | --- |
| `read_annotations` | `pdf:list-annotations` | 返回已有 4 条文本标注 |
| `read_pdf_page` | `pdf:read-page-text` | 返回第 1 页全文 |
| 推理 → 流式输出 | minimax / MiniMax-M3 | 上述中文翻译 |

翻译知识库（Settings → AI → 翻译知识库，36 条）由 `apps/web-server/src/translation/kb.ts` 管理，CRUD 全部经由 web-server IPC 通道暴露给 UI；UI 通过 `apps/web-server/src/translation/index.ts` 注册的 `dictionaryHandler` 暴露 `--dictionary` 路径，spawn translate 子进程。

## 5. 已知次要问题（未阻塞）

- 多 tab 并发 + 大文件 IPC（4.4MB PDF 经 base64 over IPC）会让 Chrome 偶发 `ERR_NETWORK_CHANGED`，通常第二次加载 PDF 文件时丢一次 open-path。建议改成 streaming IPC 或用 fetch 直读 `/api/files/read` 旁路掉 base64 通道（不影响功能，仅限用户体验）。
- `/apps/pdf` 这类带 `/apps/` 前缀的 URL 不会匹配 web-server 的 `(docs|sheets|slides|pdf|markdown|html|shell)` 路由正则，会静默 fallback 到 shell index.html。文档需更新：使用 `/pdf`、`/sheets` 等根级路径。

## 6. 关键文件改动（最近 3 个 commit）

```
15c8ade fix(html+markdown+web): html app boots in web build; save+preview channels wired
86219a0 fix(pdf): hoist apiRef above composerMentions to clear the TDZ crash
f108306 fix(translate): canonical script path, content fallback, KB env isolation, test fixes
```

新增：

- `apps/html/src/shared/html-api-factory.ts`
- `apps/html/src/renderer/web-bridge.ts`

修改：

- `apps/html/src/preload/index.ts`（改为走 factory）
- `apps/html/src/renderer/index.html`（注入 web-bridge）
- `apps/markdown/src/renderer/web-bridge.ts`（save override）
- `apps/markdown/src/shared/markdown-api-factory.ts`（save/consumeHeadlessExport/headlessExportDone）
- `apps/web-server/src/html/index.ts`（+29 channels）
- `apps/web-server/src/markdown/index.ts`（+save/consume-headless-export/headless-export-done）
- `apps/web-server/src/index.ts`（`/api/html/preview/<id>` 路由）
- `apps/pdf/src/renderer/ai/AiPanel.tsx`（apiRef 上移）

## 7. 截图

| 文件 | 状态 |
| --- | --- |
| `17-home-shell.png` | 启动后 Shell 首页 |
| `17-ai-pdf-with-panel.png` | PDF 加载完成 + AI 面板展开 |
| `18-ai-pdf-translated.png` | 翻译运行中（流式更新） |
| `19-ai-translate-scroll-bottom.png` | 翻译结果完整可见 |
| `01–16-*.png` | 历史截图（之前的 LLM 累积） |

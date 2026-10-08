# `@genoffice/office-ai-web` — 浏览器交互体验"GenOffice 作为库"

一个零依赖的 Node 网站：**所有**文档能力都由 `@genoffice/office-ai` 在服务进程内
提供，浏览器只是它的 UI。这就是"GenOffice 作为库嵌入宿主"的最小真实形态 ——

- 无 Electron、无 SaaS、无模型调用：`server.mjs` 是一个普通 `node:http` 进程；
- 浏览器↔库的协议就是 `officeTools()` 的 **14 个工具**，与 aiwork 挂给专家的
  `createOfficeServer` 是同一套；
- 样例文件全部是仓库真实文件（真实 Word/Excel/PPT/PDF/Markdown）。

## 运行

```sh
# 仓库根目录（库已构建可跳过）
npm run build:office-ai

# 启动示例网站
node examples/office-ai-web/server.mjs
# 打开 http://localhost:18085
```

端口可用 `PORT=xxxx` 覆盖。

## 页面上能真实做什么

| 区块 | 能力 | 库入口 |
|---|---|---|
| ① 打开文档 | 一键样例 / 拖拽上传 docx·xlsx·pdf·pptx·md·csv | `officeTools().open` → `readDocument` |
| ② 文档视图 | Word 块列表 / Excel 单元格表 / PPT 逐页元素 / PDF 信息+文本 | 精简后的 `DocumentView` |
| ③ PDF 渲染 | pdfium wasm 进程内光栅化，144dpi 显示 | 工具 `render_pages` |
| ④ 真实编辑 | Word 追加段落；Excel 写单元格；保存后**重新打开验证**并下载 | 工具 `insert_content` / `set_cells` + `save()` |
| ⑤ 格式转换 | xlsx→csv、docx→md、md→docx、csv→xlsx、pdf→docx 等，结果可下载 | 工具 `convert_document`（`NODE_ROUTES`） |
| ⑥ Agent 工具面 | 14 个工具任选执行，错误以 `isError` 结果返回（与 agent 循环一致） | `officeTools` |

错误约定与库一致：类型化 `code`（`OFFICE_BAD_INPUT` / `OFFICE_NEEDS_APP` /
`OFFICE_INTERNAL` …）直接透传到 UI。

## 与 aiwork 的关系

`server.mjs` 里调库的方式和 `aiwork/apps/server/src/office/local.ts` 完全同构：
`officeTools()` → `open(bytes)` → `tools.find(...).execute(args)` → `save(to)`。
把这里的 HTTP 换成 aiwork 的 `LocalMcpServer` 就是生产接法。
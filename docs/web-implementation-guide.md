# GenOffice Web 版本实现指南

> 状态:本文档为面向 web 改造的早期调研/探索记录。多数第三方依赖条目
> （`file-saver` / `yjs` / `y-webrtc` / `print-js` / `workbox-precaching` 等）
> **从未进入仓库**，也没有实际代码引用。仅保留为后续 Phase 的备选参考，
> 不得当作"GenOffice 当前在用的依赖"。当前 web 版本实现的真实状态见
> [`docs/web-electron.md`](web-electron.md)；通用 web 等价能力（文件选/
> 存、打印、剪贴板、字体度量、全屏、屏幕捕获、窗口/标签页）的实现统一
> 集中在 [`packages/ipc-bridge/src/web-native.ts`](../packages/ipc-bridge/src/web-native.ts)
> 与各 app 的 `apps/<app>/src/renderer/web-bridge.ts`。
>
> 文中每节末尾的"调研结论"段均标注为 **调研中（未引入仓库）**，以避免后续
> 工程师把它们当作已落地的技术栈。

## 研究结论

### 1. Web File System Access API

**调研中（未引入仓库）**——以下代码示例来自早期选型评估，不在仓库代码中。

**调研方案**: 使用原生 API + `file-system-access` 降级库

```typescript
// 核心 API
const handle = await window.showOpenFilePicker({
  types: [{
    description: 'Documents',
    accept: { 'application/vnd.openxmlformats-officedocument.wordprocessingml.document': ['.docx'] }
  }]
});
const file = await handle.getFile();
const content = await file.arrayBuffer();
```

**降级方案**: File Input + Blob 下载
```typescript
// 对于不支持 File System Access API 的浏览器
<input type="file" accept=".docx" onchange="handleFile(e)">
// 调研中：原计划使用 file-saver 下载，但当前 web-bridge 直接用
// packages/ipc-bridge/src/web-native.ts 的 downloadBytes（Blob + <a download>），
// 没有引入 file-saver。
// import { saveAs } from 'file-saver';
// saveAs(blob, 'document.docx');
```

### 2. AI 服务集成

**调研中（未引入仓库）**——流式 AI 由 GenOffice 自己的 `@genoffice/ai-provider`
+ 主进程 handler (`ai:stream` / `ai:stream-cancel`) 走 SSE 推送完成，
不依赖 `@vercel/ai` / `ai` (LangChain) 等第三方流式框架。

```typescript
// 调研方案: HTTP API + SSE 流式响应
async function* streamAI(prompt: string) {
  const response = await fetch('/api/ai/stream', {
    method: 'POST',
    body: JSON.stringify({ prompt }),
    headers: { 'Content-Type': 'application/json' }
  });
  
  const reader = response.body?.getReader();
  const decoder = new TextDecoder();
  
  while (true) {
    const { done, value } = await reader.read();
    if (done) break;
    yield decoder.decode(value);
  }
}
```

**库调研参考（未引入）**:
- `@vercel/ai` - 流式响应处理
- `ai` (LangChain) - AI 应用框架

### 3. 协作文档编辑

**调研中（未引入仓库）**——`yjs` / `y-webrtc` / `y-websocket` 等实时协同库均**未引入**
仓库。`apps/docs` 与 `apps/markdown` 当前的 Tiptap 编辑器只用于单用户编辑，没有
Yjs CRDT 同步层。"协同编辑" 是后续 Phase 的工作，本文示例不可作为落地参考。

```typescript
import * as Y from 'yjs';
import { WebrtcProvider } from 'y-webrtc';

// 创建文档
const ydoc = new Y.Doc();
const provider = new WebrtcProvider('room-id', ydoc);

// 获取文本
const ytext = ydoc.getText('content');
```

**替代方案（实际使用的）**:
- `TipTap` (基于 ProseMirror) - apps/docs 与 apps/markdown 的单用户富文本编辑器
  (`@tiptap/core` / `@tiptap/react` / `@tiptap/starter-kit` 等均在 `apps/markdown/package.json`、
  `apps/docs/package.json` 中作为实际依赖,但用于单用户编辑,不是协同)。
- `Lexical` - Meta 出品的编辑器框架（未引入）。

### 4. 离线支持

**调研中（未引入仓库）**——当前 web 版本不做离线缓存（`workbox-precaching`、
`workbox-strategies` 均**未引入**仓库，仓库内不存在 `sw.js` / service worker
注册）。离线支持是后续 Phase 的工作。

```typescript
// sw.js
import { precacheAndRoute } from 'workbox-precaching';
precacheAndRoute(self.__WB_MANIFEST);

// 缓存策略
import { StaleWhileRevalidate } from 'workbox-strategies';
registerRoute(
  ({ url }) => url.origin === 'https://api.example.com',
  new StaleWhileRevalidate({ cacheName: 'api-cache' })
);
```

### 5. 打印功能

**调研中（未引入仓库）**——`print-js` / `jspdf` 均**未引入**仓库。
当前实现统一走 `packages/ipc-bridge/src/web-native.ts` 的 `webPrint()`（即
`window.print()`），由各 app 的 web-bridge 在 `print*` 路径上调用：
- `apps/docs/src/renderer/web-bridge.ts` 的 `print` / `exportPdf` / `saveMergedPdf`
- `apps/slides/src/renderer/web-bridge.ts` 的 `printSlides`
- `apps/markdown/src/renderer/web-bridge.ts` 的 `exportPdf`（在新窗口里 `window.print()`）

```typescript
// 调研中（未引入）: print-js + 浏览器原生打印
// import print from 'print-js';
// print({ printable: elementId, type: 'html', documentTitle: 'My Document' });
// import jsPDF from 'jspdf';
```

## 技术栈选择

> 本节为早期调研对照表。"推荐方案"列均为 **调研中（未引入仓库）** 的备选；
> 实际落地以代码引用为准。`file-saver` / `yjs` / `y-webrtc` / `print-js` /
> `workbox-precaching` 在仓库中没有代码引用。

| 功能 | 调研中（未引入） | 当前实际实现 |
|------|------------------|---------------|
| 文件选择 | File System Access API | `<input type="file">`（`pickFileBytes` in `web-native.ts`） |
| 文件保存 | File System Access API / `file-saver` | `Blob` + `<a download>`（`downloadBytes` in `web-native.ts`） |
| AI 对话 | `@vercel/ai` / LangChain | `ai:stream` / `ai:stream-cancel` 走 SSE（`@genoffice/ai-provider`） |
| 协作编辑 | Yjs + y-webrtc / Hocuspocus | （未实现） |
| 离线缓存 | Workbox / Service Worker | （未实现） |
| 打印 | print-js / jsPDF | `window.print()`（`webPrint` in `web-native.ts`） |

## 实现优先级

### Phase 1: 核心功能
1. ✅ Web Server IPC 基础（已完成；当前真实状态见 [`docs/web-electron.md`](web-electron.md)）
2. ✅ 文件打开/保存（web-bridge 已覆盖所有 app）
3. ✅ AI 聊天接口（`ai:stream` / SSE 已实装）

### Phase 2: 增强功能
4. ✅ 项目管理完整功能
5. ✅ 文件上传/下载
6. ✅ AI 流式对话

### Phase 3: 高级功能
7. ⏳ 协作文档编辑（Yjs 等调研中,未引入仓库）
8. ⏳ 离线支持（Workbox 等调研中,未引入仓库）
9. ✅ 打印/导出（`window.print()` / 主进程字节下载）

## 依赖建议

> 本节原列出的"建议使用"依赖 **未在仓库引入，也没有代码引用**，不得当作
> GenOffice 当前依赖。`@tiptap/core` / `@tiptap/react` 等 Tiptap 包作为
> `apps/docs` / `apps/markdown` 编辑器本身的依赖在 `apps/<app>/package.json`
> 中有实际使用（单用户编辑场景），但与本节列出的其余库无关。

**调研中（未引入仓库）**:
```jsonc
// 这些只是调研候选,不在 package.json / package-lock.json 中:
{
  // "file-saver": "^2.0.5",
  // "yjs": "^13.6.0",
  // "y-webrtc": "^10.2.5",
  // "print-js": "^1.6.0",
  // "workbox-precaching": "^7.0.0"
}
```


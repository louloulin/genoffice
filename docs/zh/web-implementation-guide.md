---
title: GenOffice Web 版本实现指南
---

# GenOffice Web 版本实现指南

> 本页是 `docs/web-implementation-guide.md` 的中文版本（同一文档，作者直接用中文撰写）。

## 研究结论

### 1. Web File System Access API

**推荐方案**: 使用原生 API + `file-system-access` 降级库

```typescript
// 核心 API
const root = await navigator.storage.getDirectory();
const handle = await root.getFileHandle('foo.docx', { create: true });
const writable = await handle.createWritable();
await writable.write(bytes);
await writable.close();
```

### 2. 浏览器渲染方案

- **Canvas + 自绘**：可控制最深，但需要重写排版引擎（不推荐）
- **HTML 渲染 + 测量**：复用浏览器排版能力，推荐方案
- **OffscreenCanvas + Worker**：性能最佳，适合大文档

### 3. 同步策略

- 本地 IndexedDB 主存
- 后台 sync 到云端
- 冲突解决：CRDT 或最后写入获胜（按文件配置）

## 详细规范

参见 [`/web-implementation-guide`](/web-implementation-guide)。

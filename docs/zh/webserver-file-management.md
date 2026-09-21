---
title: Web-server 文件管理
---

# Web-server 文件管理

独立版 web-server（`apps/web-server`）处理 GenOffice Web 版的文件上传、保存、
读取与生命周期管理。本文记录 WPS 级重构（Phase 0-2, 5）之后的架构以及它与
Electron 桌面端（`apps/docs/src/main`）共享的契约。

## 分层

参见英文版 [`/webserver-file-management`](/webserver-file-management)。

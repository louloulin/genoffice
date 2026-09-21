---
title: Web + Electron 双协议
---

# Web + Electron 双协议

GenOffice 在 Electron 桌面端和本地 Web 端共用同一份渲染构建。Electron 渲染端通过
`ipcRenderer` 调用主进程 handler，浏览器端通过回环 HTTP bridge 调用同一组 handler。
Main → Renderer 推送走隔离的 server-sent events 流。

## 架构

- `@genoffice/ipc-bridge` 包装 `ipcMain.handle` / `removeHandler` / `on`，为渲染端提供统一接口
- `@genoffice/agent-core` 的 HTTP transport 与 Electron transport 共用 `genoffice.agent.v1` 信封
- SSE channel 在 Electron 下走主进程广播，在浏览器下走 loopback SSE

## 详细说明

完整设计参见英文版 [`/web-electron`](/web-electron)。

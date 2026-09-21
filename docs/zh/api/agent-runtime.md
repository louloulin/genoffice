# `@genoffice/agent-runtime`

[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
的轻量包装，提供 **React UI 适配器**、带 GenOffice 默认配置的 **session 工厂**
（模型发现、额外 skill 路径），以及 office 应用消费的 React 绑定
（`PiSessionProvider` + 一族 hooks）。

> npm：[`@genoffice/agent-runtime`](https://www.npmjs.com/package/@genoffice/agent-runtime)
> Tarball：19.6 kB · 16 文件 · Apache-2.0
> React 18 为可选 peer 依赖。

## 适用场景

- 你正在构建一个承载多个 GenOffice 应用（Docs / Sheets / Slides …）
  的桌面 / Web shell，希望每个 shell 共享一个 agent session，并用
  React 绑定来呈现对话框 / 通知
- 你想接入自定义 `ResourceLoader` / `ModelRuntime` / `SessionManager`，
  又不想重写 session 模板代码
- 你想把 marketplace 的 skill 目录转发给 session，让新装的 skill 在
  下一次 session 启动时立即可见，无需触碰用户的全局 `~/.pi/agent`
  设置

如果你只需要 session 后端（Node 上的 SQLite 或 Web 上的 IndexedDB），
不需要 React，请用 [`@genoffice/agent-session`](./agent-session.md)。

## 公开接口

```ts
// packages/agent-runtime/src/index.ts
export {
  ReactUIAdapter,
  type DialogRequest,
  type DialogKind,
  type NotificationItem,
  type NotificationKind,
  type SelectDialogRequest,
  type ConfirmDialogRequest,
  type InputDialogRequest,
} from "./ui-adapter";

export {
  createOfficeSession,
  type OfficeSession,
  type OfficeSessionOptions,
} from "./session";

export {
  PiSessionProvider,
  useOfficeSession,
  usePiSession,
  usePiAgentSession,
  useUiAdapter,
  usePiDialogs,
  usePiNotifications,
  usePiStatuses,
  type PiSessionProviderProps,
} from "./provider";

export {
  PiDialogHost,
  NotificationToaster,
  PiStatusBar,
  type PiDialogHostProps,
  type NotificationToasterProps,
} from "./components";

export {
  createBenchmark,
  createResponseCache,
  DEFAULT_CACHE_TTL_MS,
  DEFAULT_CACHE_MAX_ENTRIES,
  PERFORMANCE_TARGETS,
  recordTiming,
  summarizeBenchmark,
  type Benchmark,
  type BenchmarkSummary,
  type CacheEntry,
  type ResponseCache,
  type ResponseCacheOptions,
  type TimingSample,
} from "./performance";
```

### `createOfficeSession(options)`

创建一个带 GenOffice 默认配置的 pi `AgentSession`。返回的
`OfficeSession` 是 `{ session, uiAdapter, dispose }` 三元组 —
适配器被接入 session 的 `ExtensionUIContext`，因此工具调用
`ctx.ui.confirm(...)` 会推入 React 队列。

```ts
import { createOfficeSession } from '@genoffice/agent-runtime'

const office = await createOfficeSession({
  cwd: process.cwd(),
  additionalSkillPaths: ['./.genoffice/skills'],
})

// `dispose()` 清理 pi session 并移除适配器上的所有监听。
// Shell 退出时务必调用。
process.on('SIGINT', () => { office.dispose(); process.exit(0) })
```

`OfficeSessionOptions`（节选）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `cwd` | `process.cwd()` | 传给底层 session 的工作目录 |
| `agentDir` | `~/.pi/agent` | pi 发现内置扩展的位置 |
| `sessionManager` | 内存版 | 预构建的 `SessionManager` |
| `modelRuntime` | `ModelRuntime.create()` | 自定义模型发现 |
| `uiAdapter` | 新建 `ReactUIAdapter` | 自定义 UI 桥 |
| `additionalExtensionPaths` | — | 额外的扩展文件 |
| `additionalSkillPaths` | — | 额外的 skill 目录（每个目录含 `<name>/SKILL.md`）|
| `additionalExtensions` | — | 进程内工厂（对 bundler 友好）|

### React 绑定

```tsx
import { PiSessionProvider, PiDialogHost, NotificationToaster } from '@genoffice/agent-runtime'

function App({ office }) {
  return (
    <PiSessionProvider office={office}>
      <Editor />
      <PiDialogHost />          {/* 渲染 ctx.ui.confirm / select / input 的弹窗 */}
      <NotificationToaster />   {/* 渲染 ctx.ui.notify* 的 toast */}
    </PiSessionProvider>
  )
}

function Editor() {
  const { session, uiAdapter } = useOfficeSession()
  const dialogs = usePiDialogs()
  // …
}
```

可用 hooks：`useOfficeSession` · `usePiSession` ·
`usePiAgentSession` · `useUiAdapter` · `usePiDialogs` ·
`usePiNotifications` · `usePiStatuses`。

### 性能工具

`createBenchmark()` 与 `createResponseCache()` 提供可选的进程内
缓存（`DEFAULT_CACHE_TTL_MS = 60_000`、
`DEFAULT_CACHE_MAX_ENTRIES = 256`）和 benchmark 记录器。
`PERFORMANCE_TARGETS` 常量枚举了 office 应用用来标记回归的延迟
预算。

## 安装

```bash
pnpm add @genoffice/agent-runtime react react-dom
```

`react` 与 `react-dom` 为可选 peer 依赖；只有用 React 绑定时才需要
安装。

## 兼容性矩阵

| 运行时 | 状态 |
|---|---|
| Node ≥ 22.12 | ✅ |
| React ≥ 18 | ✅（可选 peer）|
| Electron ≥ 30 | ✅（通过 `@genoffice/agent-session` 用 Node SQLite）|
| 浏览器（Vite / Webpack 5）| ✅（本包无 Node-only 依赖）|

## 相关

- [`@genoffice/agent-session`](./agent-session.md) — SQLite（Node）
  与 IndexedDB（浏览器）session 后端，被 `createOfficeSession` 使用
- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  — 本包包装的上游 agent SDK
- [`@genoffice/ai-provider`](../api/provider-plugins.md) — 被
  `ModelRuntime` 使用的 provider 插件注册中心

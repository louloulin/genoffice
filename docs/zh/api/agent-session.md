# `@genoffice/agent-session`

office 应用的 session **存储后端**。提供两个并行的实现，共享同一
`JsonlSessionEntry` 落盘格式，方便未来在宿主之间以"一行一条
entry"流式导入 / 导出而无需转译：

- **`./sqlite`** — 仅 Node 的 SQLite 后端（`better-sqlite3` 由
  `@earendil-works/pi-session-backend-sqlite-node` 提供），供
  Electron shell 以及任何 Node 侧的 agent runtime 使用
- **`./indexeddb`** — 仅浏览器的 IndexedDB 后端，供 Web 编辑器
  SPA（`apps/docs`、`apps/web-server` 的 web-server 模式）使用

> npm：[`@genoffice/agent-session`](https://www.npmjs.com/package/@genoffice/agent-session)
> Tarball：8.1 kB · 8 文件 · Apache-2.0

## 适用场景

- **Electron shell** — 调用 `createElectronSessionBackend({ cwd })`，
  把返回的 `repository` 传给
  [`@genoffice/agent-runtime`](./agent-runtime.md) 中的
  `createOfficeSession`
- **Web 编辑器 SPA** — 调用 `createWebSessionBackend()`（无需参数，
  使用 `globalThis.indexedDB`），同样把 `repository` 传过去
- **自定义 Node 宿主**（服务端 agent runtime、无头 CI） — 同
  Electron。SQLite 后端只需要 `cwd` 与一个可写的用户数据目录

## 公开接口

```ts
// packages/agent-session/src/index.ts
export {
  createElectronSessionBackend,
  DEFAULT_DATABASE_FILENAME,
  DEFAULT_USER_HOME_DIR,
  resolveDatabasePath,
  type ElectronSessionBackend,
  type ElectronSessionBackendOptions,
} from "./sqlite";

export {
  createWebSessionBackend,
  DEFAULT_DATABASE_NAME,
  DEFAULT_STORE_NAME,
  fromJsonl,
  toJsonl,
  type JsonlSessionEntry,
  type WebSessionBackend,
  type WebSessionBackendOptions,
  type WebSessionMetadata,
} from "./indexeddb";
```

### `createElectronSessionBackend(options)`

```ts
import { createElectronSessionBackend } from '@genoffice/agent-session/sqlite'

const { repository, databasePath, userHomeDir } =
  createElectronSessionBackend({ cwd: process.cwd() })

// `databasePath` 是真正使用的 SQLite 文件的绝对路径。
// 把 `repository` 直接传给 @genoffice/agent-runtime 的 createOfficeSession。
```

`ElectronSessionBackendOptions`（节选）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `cwd` | （必填）| session 向宿主应用报告的工作目录 |
| `userHomeDir` | `~/.genoffice` | SQLite 文件存放目录 |
| `databasePath` | `${userHomeDir}/sessions.sqlite` | 若为相对路径，则相对于 `userHomeDir` 解析。省略则每个 session 在 `userHomeDir` 下占一个独立 `${id}.sqlite` 文件 |
| `now` | `Date.now` | 测试用时钟覆盖 |

返回对象：`{ repository: SqliteSessionRepo, databasePath, userHomeDir }`。

### `createWebSessionBackend(options?)`

```ts
import { createWebSessionBackend } from '@genoffice/agent-session/indexeddb'

const { repository } = createWebSessionBackend()
// 仅浏览器。使用 `globalThis.indexedDB`；无需额外设置。
```

`WebSessionBackendOptions`（节选）：

| 字段 | 默认值 | 说明 |
|---|---|---|
| `databaseName` | `"genoffice-sessions"` | IndexedDB 数据库名 |
| `storeName` | `"sessions"` | 对象存储名 |
| `idbFactory` | `globalThis.indexedDB` | Node 测试时可传入 `fake-indexeddb` |

### JSONL 工具函数

`fromJsonl(text)` 与 `toJsonl(entries)` 在 pi-coding-agent 文件式
session 使用的 JSONL 落盘格式与内存里的 `JsonlSessionEntry[]` 数组
之间互转。便于 **在 Electron 与 Web 宿主之间导入 / 导出 session**。

```ts
import { fromJsonl, toJsonl } from '@genoffice/agent-session/indexeddb'

const entries = fromJsonl(await fetch('/sessions/abc.jsonl').then(r => r.text()))
const back = toJsonl(entries)
```

## 安装

```bash
# 仅 Node 宿主（Electron shell、服务端 agent runtime）
pnpm add @genoffice/agent-session

# 浏览器 SPA — 任选你的 bundler
pnpm add @genoffice/agent-session
```

本包是 dual-target：`./sqlite` 输出 Node 代码（浏览器构建会被
bundler tree-shake 掉），`./indexeddb` 输出浏览器代码（Node 侧 import
会抛错）。

## 兼容性矩阵

| 运行时 | `./sqlite` | `./indexeddb` |
|---|---|---|
| Node ≥ 22.12 | ✅ | ❌（无 `indexedDB`）|
| Electron ≥ 30 | ✅ | ✅（渲染进程内有 `indexedDB`）|
| 浏览器（Chromium / Firefox / Safari）| ❌（无 `fs`）| ✅ |
| Bun ≥ 1.1 | ✅ | ✅（提供 `indexedDB`）|

## 测试

```text
2 文件 / 30 测试
- sqlite：15 测试（增删改查、多 session、自定义 databasePath、时钟覆盖、错误 envelope）
- indexeddb：15 测试（增删改查、列表元数据、JSONL 往返、store-name 覆盖）
```

运行：`pnpm --filter @genoffice/agent-session test`。

## 相关

- [`@genoffice/agent-runtime`](./agent-runtime.md) — 通过
  `createOfficeSession({ sessionManager })` 消费本包的 `repository`
- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  — 上游 SDK；`JsonlSessionEntry` 形态与其文件式 session 兼容

# `@genoffice/agent-runtime`

Thin wrapper around
[`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
that supplies a **React UI adapter**, a **session factory** with GenOffice
defaults (model discovery, additional skill paths), and the React
bindings (`PiSessionProvider` + a family of hooks) that the office apps
consume.

> npm: [`@genoffice/agent-runtime`](https://www.npmjs.com/package/@genoffice/agent-runtime)
> Tarball: 19.6 kB · 16 files · Apache-2.0
> React 18 is an optional peer dependency.

## When to use

- You are building a desktop / web shell that hosts multiple GenOffice
  apps (Docs, Sheets, Slides, …) and want one shared agent session per
  shell, with React bindings to surface dialogs / notifications.
- You want to wire a custom `ResourceLoader` / `ModelRuntime` /
  `SessionManager` without rewriting session plumbing.
- You want to forward marketplace skill directories so a freshly
  installed skill is visible to the next session without touching the
  user's global `~/.pi/agent` settings.

If you only need a session backend (SQLite on Node, IndexedDB on web)
without React, prefer [`@genoffice/agent-session`](./agent-session.md).

## Public surface

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

Creates a pi `AgentSession` with GenOffice defaults. The returned
`OfficeSession` is a `{ session, uiAdapter, dispose }` triple — the
adapter is wired as the session's `ExtensionUIContext`, so tools that
call `ctx.ui.confirm(...)` push into the React queue.

```ts
import { createOfficeSession } from '@genoffice/agent-runtime'

const office = await createOfficeSession({
  cwd: process.cwd(),
  additionalSkillPaths: ['./.genoffice/skills'],
})

// `dispose()` cleans up the pi session and removes all listeners on
// the adapter. Always call it on shell teardown.
process.on('SIGINT', () => { office.dispose(); process.exit(0) })
```

`OfficeSessionOptions` (selected):

| Field | Default | Notes |
|---|---|---|
| `cwd` | `process.cwd()` | Working directory passed to the underlying session. |
| `agentDir` | `~/.pi/agent` | Where pi discovers its built-in extensions. |
| `sessionManager` | in-memory | Pre-built `SessionManager`. |
| `modelRuntime` | `ModelRuntime.create()` | Custom model discovery. |
| `uiAdapter` | new `ReactUIAdapter` | Custom UI bridge. |
| `additionalExtensionPaths` | — | Extra extension files. |
| `additionalSkillPaths` | — | Extra skill dirs (per `<name>/SKILL.md`). |
| `additionalExtensions` | — | In-process factories (bundler-friendly). |

### React bindings

```tsx
import { PiSessionProvider, PiDialogHost, NotificationToaster } from '@genoffice/agent-runtime'

function App({ office }) {
  return (
    <PiSessionProvider office={office}>
      <Editor />
      <PiDialogHost />          {/* renders modals for ctx.ui.confirm / select / input */}
      <NotificationToaster />   {/* renders toast for ctx.ui.notify* */}
    </PiSessionProvider>
  )
}

function Editor() {
  const { session, uiAdapter } = useOfficeSession()
  const dialogs = usePiDialogs()
  // …
}
```

Available hooks: `useOfficeSession` · `usePiSession` ·
`usePiAgentSession` · `useUiAdapter` · `usePiDialogs` ·
`usePiNotifications` · `usePiStatuses`.

### Performance utilities

`createBenchmark()` and `createResponseCache()` give you an opt-in
in-process cache (`DEFAULT_CACHE_TTL_MS = 60_000`,
`DEFAULT_CACHE_MAX_ENTRIES = 256`) and a benchmark recorder. The
constants `PERFORMANCE_TARGETS` enumerate the latency budgets the
office apps use to flag regressions.

## Installation

```bash
pnpm add @genoffice/agent-runtime react react-dom
```

`react` and `react-dom` are optional peer dependencies; install them
only if you plan to use the React bindings.

## Compatibility matrix

| Runtime | Status |
|---|---|
| Node ≥ 22.12 | ✅ |
| React ≥ 18 | ✅ (optional peer) |
| Electron ≥ 30 | ✅ (uses Node SQLite via `@genoffice/agent-session`) |
| Browser (Vite / Webpack 5) | ✅ (no Node-only deps in this package) |

## See also

- [`@genoffice/agent-session`](./agent-session.md) — SQLite (Node) and
  IndexedDB (browser) session backends used by `createOfficeSession`
- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  — the upstream agent SDK this package wraps
- [`@genoffice/ai-provider`](../api/provider-plugins.md) — provider
  plugin registry used by `ModelRuntime`

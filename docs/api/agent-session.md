# `@genoffice/agent-session`

Session **storage backends** for the office apps. Ships two parallel
implementations that share the same `JsonlSessionEntry` on-disk shape
so future import / export between hosts streams one entry per line
without translation:

- **`./sqlite`** — Node-only SQLite backend (`better-sqlite3` via
  `@earendil-works/pi-session-backend-sqlite-node`), used by the
  Electron shell and any Node-side agent runtime.
- **`./indexeddb`** — Browser-only IndexedDB backend, used by the web
  editor SPA (`apps/docs`, `apps/web-server`'s `web-server` mode).

> npm: [`@genoffice/agent-session`](https://www.npmjs.com/package/@genoffice/agent-session)
> Tarball: 8.1 kB · 8 files · Apache-2.0

## When to use

- **Electron shell** — call `createElectronSessionBackend({ cwd })` and
  hand the returned `repository` to `createOfficeSession` in
  [`@genoffice/agent-runtime`](./agent-runtime.md).
- **Web editor SPA** — call `createWebSessionBackend()` (no args; uses
  `globalThis.indexedDB`) and hand `repository` the same way.
- **Custom Node host** (server-side agent runtime, headless CI) — same
  as Electron. The SQLite backend only needs `cwd` and a writable
  user-data dir.

## Public surface

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

// `databasePath` is the absolute SQLite file actually used. Pass
// `repository` straight into `createOfficeSession` from
// @genoffice/agent-runtime.
```

`ElectronSessionBackendOptions` (selected):

| Field | Default | Notes |
|---|---|---|
| `cwd` | (required) | Working directory the session reports to its host app. |
| `userHomeDir` | `~/.genoffice` | Where the SQLite file lives. |
| `databasePath` | `${userHomeDir}/sessions.sqlite` | If relative, resolved against `userHomeDir`. Omit to get one-file-per-session under `userHomeDir`. |
| `now` | `Date.now` | Clock override for tests. |

Returned object: `{ repository: SqliteSessionRepo, databasePath, userHomeDir }`.

### `createWebSessionBackend(options?)`

```ts
import { createWebSessionBackend } from '@genoffice/agent-session/indexeddb'

const { repository } = createWebSessionBackend()
// Browser-only. Uses `globalThis.indexedDB`; no setup required.
```

`WebSessionBackendOptions` (selected):

| Field | Default | Notes |
|---|---|---|
| `databaseName` | `"genoffice-sessions"` | IndexedDB database name. |
| `storeName` | `"sessions"` | Object store name. |
| `idbFactory` | `globalThis.indexedDB` | Override for Node testing (e.g. `fake-indexeddb`). |

### JSONL helpers

`fromJsonl(text)` and `toJsonl(entries)` round-trip between the
JSONL on-disk shape used by pi-coding-agent's file-backed sessions
and the `JsonlSessionEntry[]` array used in memory. Useful for
**importing / exporting sessions between Electron and Web hosts**.

```ts
import { fromJsonl, toJsonl } from '@genoffice/agent-session/indexeddb'

const entries = fromJsonl(await fetch('/sessions/abc.jsonl').then(r => r.text()))
const back = toJsonl(entries)
```

## Installation

```bash
# Node-only host (Electron shell, server-side agent runtime)
pnpm add @genoffice/agent-session

# Browser SPA — pick your bundler
pnpm add @genoffice/agent-session
```

The package is dual-target: `./sqlite` exports Node code (which your
bundler will tree-shake away in browser builds), `./indexeddb`
exports browser code (which Node will throw on if you import it from a
Node bundle).

## Compatibility matrix

| Runtime | `./sqlite` | `./indexeddb` |
|---|---|---|
| Node ≥ 22.12 | ✅ | ❌ (no `indexedDB`) |
| Electron ≥ 30 | ✅ | ✅ (`indexedDB` available in renderer) |
| Browser (Chromium / Firefox / Safari) | ❌ (no `fs`) | ✅ |
| Bun ≥ 1.1 | ✅ | ✅ (`indexedDB` available) |

## Tests

```text
2 files / 30 tests
- sqlite: 15 tests (crud, multi-session, custom databasePath, clock override, error envelope)
- indexeddb: 15 tests (crud, list metadata, JSONL round-trip, store-name override)
```

Run with `pnpm --filter @genoffice/agent-session test`.

## See also

- [`@genoffice/agent-runtime`](./agent-runtime.md) — consumes this
  package's `repository` via `createOfficeSession({ sessionManager })`
- [`@earendil-works/pi-coding-agent`](https://www.npmjs.com/package/@earendil-works/pi-coding-agent)
  — upstream SDK; the `JsonlSessionEntry` shape matches its file-backed
  sessions

# @genoffice/web-server

Standalone HTTP server for GenOffice. No Electron required — runs the same
apps/docs / apps/sheets / apps/slides / apps/pdf / apps/markdown / apps/html
renderers the desktop build ships, but over an `http://` IPC transport
instead of Electron's preload bridge.

## Quick start

```bash
# 1. Build the renderer bundles (apps/docs, etc.) — required because
#    the server serves them straight off disk.
pnpm --filter @genoffice/docs build
pnpm --filter @genoffice/sheets build
pnpm --filter @genoffice/slides build
pnpm --filter @genoffice/pdf build
pnpm --filter @genoffice/markdown build
pnpm --filter @genoffice/html build

# 2. Bundle and start the server.
pnpm --filter @genoffice/web-server bundle
pnpm --filter @genoffice/web-server start
# → http://127.0.0.1:18081
```

## Configuration

All knobs are environment variables. Defaults are tuned for a developer
running on the same machine as the renderer (no auth, loopback-only).

| Variable | Default | Purpose |
|---|---|---|
| `HOST` | `127.0.0.1` | Bind address. Set to `0.0.0.0` to expose on the LAN — **always pair with `WEB_TOKEN`** in that case. |
| `PORT` | `18081` | HTTP port. |
| `WEB_TOKEN` | (unset) | When set, every `/api/*` request must carry `Authorization: Bearer <token>` (or `X-GenOffice-Token: <token>`). Health, channel discovery, and HTML preview stay open. |
| `DATA_DIR` | `/tmp/genoffice-data` | Persistent state: `projects.json`, `docs-recent.json`, `docs-starred.json`, `ai-settings.json`, `translation-kb.json`, KB/TM, upload `files/`. |
| `WEB_TEMP_ROOT` | `$TMPDIR/genoffice-web-temp` | Disposable per-upload directories; swept every boot, age > 24 h. |
| `WEB_STATIC_ROOT` | `<repo>/apps` | Override where the server looks for the renderer `out/` directories. |
| `WEB_PATH_PREFIX` | (empty) | Strip a URL prefix from incoming requests before routing. Useful for reverse proxies. |
| `WEB_CORS_ORIGIN` | (echo request Origin) | Set to a single origin to lock CORS to that value. |
| `WEB_CORS_ORIGINS` | (unset) | Comma-separated allowlist for CORS. |

## Storage layout

```
DATA_DIR/
├── projects.json           # Project list
├── docs-recent.json        # Recent docs (capped at 10)
├── docs-starred.json       # Starred docs (persisted)
├── sheets-recent.json
├── slides-recent.json
├── ai-settings.json        # Provider keys, default model
├── translation-kb.json     # GenOffice translation knowledge base
├── translation-memory/     # Persistent TM shards
└── files/                  # All uploads, save-as targets, recents rows

WEB_TEMP_ROOT/
└── upload-<ts>-<rand>/     # Per-upload sandbox; swept at boot
    └── <sanitized-name>
```

## Channel inventory

Every renderer request hits one of the channels registered by
`register*Handlers()` in `src/<capability>/index.ts`. The boot banner
reports `handlers.size`; `/api/channels` returns the full sorted list.

See `docs/channels.md` for the per-channel reference (request shape,
response shape, error codes). Highlights:

- `web:save-file`, `web:write-temp-file`, `web:read-file-bytes` — file
  upload helpers. Bytes capped at 100 MiB; names sanitised; uploads
  isolated to managed storage.
- `docs:open-path`, `docs:save`, `docs:save-new`,
  `docs:create-document`, `files:add-pasted-image` — document
  persistence. Atomic writes; magic-byte gate; daily paste quota
  (default 100 MiB / day).
- `home:recents`, `home:starred`, `home:toggle-star` — home pane
  state.
- `anydoc:recognize`, `anydoc:convert`, `anydoc:extract-text`,
  `anydoc:extract-tables`, `anydoc:extract-images`,
  `anydoc:render-preview` — format recognition and extraction. See
  the channel doc for honest gaps.

## Security posture

The web-server has no OS-level sandbox. Three things keep it honest:

1. **Loopback bind** — the default `HOST=127.0.0.1` means anything that
   is not on the same machine cannot reach `/api/*`.
2. **Path containment** — every channel that touches the disk starts
   with `requireManagedPath(channel, path)`. The managed area is
   `DATA_DIR` plus `WEB_TEMP_ROOT`.
3. **Token gate** — setting `WEB_TOKEN` activates a Bearer-token
   middleware on every `/api/*` request. `/health`, `/api/channels`,
   and `/api/html/preview/*` stay open so health probes and the
   iframe preview keep working.

Together with `sanitizeFileName` (path-traversal-proof basenames),
`assertMagicMatchesExtension` (refuse bytes that don't match the
extension), `atomicWriteJson` (crash-safe JSON persistence), and the
WEB_TEMP_ROOT 24 h GC, the surface area is enough for a single-host
deployment and clearly insufficient for an untrusted multi-tenant one.

## Testing

```bash
pnpm --filter @genoffice/web-server typecheck
pnpm --filter @genoffice/web-server test
```

The `tests/` directory holds unit suites (`paths-sanitize`, `magic`,
`auth`, `atomic`, `static-spa-routes`, `ipc-error-status`,
`ai-provider-config`) and e2e suites (`*-e2e.test.ts`) that boot a
real HTTP server. The e2e suites share `tests/global-setup.ts`, which
re-runs the esbuild bundle when `src/` is newer than `dist/bundle`.

## Repository layout

```
src/
├── ai/            AI settings, KB/TM, chat/stream, HTTP translate
├── anydoc/        Format recognition, conversion, extraction, preview
├── auth/          Static-token auth gate (optional, WEB_TOKEN)
├── collab/        Collaboration sessions
├── common/        Shared utilities (paths, registry, state, magic, atomic)
├── docs/          Docs IPC (open/save/recents)
├── enterprise/    Mail / calendar / workflow / audit
├── html/          HTML app entry + preview
├── markdown/      Markdown app entry
├── pdf/           PDF app entry
├── projects/      Project management IPC
├── sheets/        Sheets IPC
├── slides/        Slides IPC
├── shell/         Home, modules, prefs, skills, pi session
└── web/           Web platform helpers (temp file, save-file)
```

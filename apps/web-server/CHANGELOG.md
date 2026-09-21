# GenOffice Web Server Changelog

All notable changes to the `@genoffice/web-server` package are documented here.

The full monorepo changelog lives at [`/CHANGELOG.md`](../../CHANGELOG.md) — this file
mirrors just the web-server-specific entries.

## [Unreleased]

### Added

- **REST API v1** — stable SDK contract; 10 endpoints across auth / files / ai / kb / webhooks / health / changelog.
- **iframe Embed endpoint** at `GET /embed/:docId?token=…` with v1.0 postMessage bridge.
- **Webhook firing** on every save (`docs:save` / `web:save-file` / `markdown:save` / `html:save` / `html:save-file` / `workbook:save` / `slides:save` / `pdf:save`).
- **JWT RBAC scope** with `hasScope(payload, scope)` helper (exact / `*` / `ai:*` prefix / default read-only / admin bypass).
- **HMAC-SHA256 webhook signing** via `signWebhookBody()`.
- **Scope gate** on every v1 endpoint (16 endpoints total).
- **`/api/v1/health`** and **`/api/v1/changelog`** are public (no auth required) per the SDK contract.

### Changed

- **`/api/v1/health`** body now returns the full channel list (`channels: string[]`) in addition to the count, so clients can self-discover IPC capabilities.
- **`<meta name="genoffice-token">` injection** is now case-insensitive (`<HEAD>` vs `</head>`).

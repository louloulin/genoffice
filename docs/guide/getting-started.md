# Getting Started

Welcome to GenOffice. This page walks you through the fastest path from
zero to a running instance.

## What you get

A single Node.js process that serves:

- The six editors (docs, sheets, slides, pdf, markdown, html) as SPAs.
- A REST API at `/api/v1/*` for uploads, JWT auth, AI calls, webhooks.
- An iframe Embed endpoint at `/embed/:docId`.
- 546 IPC channels bridging the renderer to the main process.

## 30-second install

```sh
git clone https://github.com/genspark-ai/genoffice.git
cd genoffice
npm install
npm run build:web-server     # bundles the standalone server
PORT=8080 node apps/web-server/dist/bundle/index.js
```

Open <http://localhost:8080> in your browser. Pick an editor, drop in a
file, edit, save.

## Next steps

- [Quick Start: Web](/guide/quick-start-web) — boot the server in 5 minutes.
- [Quick Start: Embed](/guide/quick-start-embed) — embed the editor in
  your own site.
- [Quick Start: SDK](/guide/quick-start-sdk) — script the editor with
  the TypeScript SDK.
- [Deployment: Docker](/guide/deployment-docker) — production deploy.

## What you should know

- **Node ≥ 22.12.** Older Node versions will run the editors but the
  bundle uses ESM modules with `import.meta.url` and a few Web APIs.
- **No telemetry.** First boot with no `GENOFFICE_JWT_SECRET` answers
  `503 NOT_CONFIGURED` for v1 authed routes; the rest of the API works
  in `open` mode.
- **Storage is local.** Files live under `DATA_DIR` (default
  `./.genoffice-data`). Configure `DATA_DIR` to a persistent volume in
  production.

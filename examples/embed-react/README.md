# `@genoffice/example-embed-react` — React 18 + Vite

Drop-in React wrapper around `@genoffice/web-sdk`.

## Run

```sh
# 1. Start the GenOffice web-server on http://localhost:18082
cd /path/to/genoffice
pnpm --filter @genoffice/web-server dev

# 2. Mint a JWT (in another terminal)
curl -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"demo-user"}'

# 3. Start the example dev server
pnpm install
pnpm dev          # http://localhost:5173

# 4. Open http://localhost:5173, paste the JWT, click Mount.
```

The Vite dev server proxies `/api` and `/embed` to the web-server on
`localhost:18082` so the iframe loads the editor without CORS friction.

## Files

| File | Purpose |
|---|---|
| `GenOfficeEditor.tsx` | The React component (the deliverable). |
| `demo.tsx` | Basic single-instance demo app wiring the component to a form. |
| `demo-kestrel.tsx` | **SDK 2.0 Kestrel end-to-end demo** — four surfaces in one page: multi-instance + comments + plugin runtime + telemetry. Open at `/kestrel.html`. |
| `panel-stub.html` | Static page used as the sidebar panel URL during the plugin-runtime demo. |
| `index.html` | Vite entry — links to both Basic and Kestrel demos. |
| `vite.config.ts` | Vite config with the `/api` and `/embed` proxy. |
| `tsconfig.json` | Strict TypeScript config with React JSX. |

## SDK 2.0 Kestrel demo

`pnpm dev` then open <http://localhost:5173/kestrel.html>. The page exercises:

1. **Multi-instance** — two `GenOfficeEditor`s side-by-side (`split-A` / `split-B`),
   each with its own `instanceId`. The Comments panel uses
   `getEditor('split-A')` to look up a handle from a sibling component.
2. **Comments API** — `addComment` / `listComments` / `resolveComment`
   plus `commentAdded` / `commentResolved` event hooks.
3. **Plugin Runtime** — `mountSidebar({ panelUrl: '/panel-stub.html' })`
   + `postToSidebar` from the host + `sidebarMessage` events from the
   panel back into the host (the static `panel-stub.html` ships back
   `PONG` / `ANSWER` payloads via `window.parent.postMessage`).
4. **Telemetry** — `createEditor({ telemetry: true })` + `usage` event
   subscriber. The interval fires every 30 s; click the `insertText`
   button to bump the `docBytesWritten` counter before the next tick. |

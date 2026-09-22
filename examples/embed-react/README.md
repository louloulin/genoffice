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
| `demo-auto-release.tsx` | **SDK 2.0 sessionBinding.autoRelease:false demo** — shows how to mint a server-bound nonce, mount with `autoRelease:false`, and call `releaseEmbedNonce()` yourself from a `pagehide` handler. Open at `/auto-release.html`. |
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

## SDK 2.0 sessionBinding.autoRelease:false demo

`pnpm dev` then open <http://localhost:5173/auto-release.html>. The
page walks the full `createEmbedNonce` → `createEditor({ sessionBinding: { autoRelease: false } })` → manual `releaseEmbedNonce` flow, plus a `pagehide` listener that mirrors what a real production wiring looks like.

The default `autoRelease: true` is right for 95% of hosts, but `autoRelease: false` is what you want when:

- You have a global page-unload handler that needs to call release AFTER `destroy()` (e.g. `Router.beforeunload` fires the release, then the SDK destroys the handle on component unmount).
- You want to reuse a single `sessionId` across multiple mounts of the same editor (mount, destroy, mount again — the server slot stays reserved for you).
- You're using a framework lifecycle that destroys the editor handle asynchronously after the user's actual teardown event.

The server-side LRU + 5 min TTL means a missed release isn't catastrophic — the slot just sits unused until TTL expiry. But explicit release frees the slot the moment you're done. |

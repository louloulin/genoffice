# `@genoffice/example-embed-vue` — Vue 3 + Vite

Drop-in Vue 3 SFC around `@genoffice/web-sdk`.

## Run

```sh
# 1. Start the GenOffice web-server on http://localhost:18082
cd /path/to/genoffice
pnpm --filter @genoffice/web-server dev

# 2. Mint a JWT
curl -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"demo-user"}'

# 3. Start the example dev server
pnpm install
pnpm dev          # http://localhost:5174

# 4. Open http://localhost:5174, paste the JWT, mount.
```

The Vite dev server proxies `/api` and `/embed` to the web-server on
`localhost:18082`.

## Files

| File | Purpose |
|---|---|
| `GenOfficeEditor.vue` | The Vue SFC (the deliverable). |
| `demo.ts` | Basic single-instance demo app using inline template. |
| `demo-kestrel.ts` | **SDK 2.0 Kestrel end-to-end demo** — four surfaces in one page: multi-instance + comments + plugin runtime + telemetry. Open at `/kestrel.html`. |
| `panel-stub.html` | Static page used as the sidebar panel URL during the plugin-runtime demo. |
| `index.html` | Vite entry — links to both Basic and Kestrel demos. |
| `vite.config.ts` | Vite config with the `/api` and `/embed` proxy. |
| `tsconfig.json` | Strict TypeScript config with Vue JSX preserved. |

## SDK 2.0 Kestrel demo

`pnpm dev` then open <http://localhost:5173/kestrel.html>. Same four
surfaces as the React demo (`examples/embed-react/demo-kestrel.tsx`):
multi-instance, Comments, Plugin Runtime, Telemetry — implemented in
Vue 3 Composition API. |

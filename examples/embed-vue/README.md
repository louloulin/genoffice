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
| `demo.ts` | Tiny demo app using inline template. |
| `index.html` | Vite entry. |
| `vite.config.ts` | Vite config with the `/api` and `/embed` proxy. |
| `tsconfig.json` | Strict TypeScript config with Vue JSX preserved. |

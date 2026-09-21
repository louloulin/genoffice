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
| `demo.tsx` | Tiny demo app wiring the component to a form. |
| `index.html` | Vite entry. |
| `vite.config.ts` | Vite config with the `/api` and `/embed` proxy. |
| `tsconfig.json` | Strict TypeScript config with React JSX. |

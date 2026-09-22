# `sdk-multi-instance` — SDK multi-instance demo

Demonstrates the SDK 2.0 Kestrel M1 multi-instance API by mounting **two**
independent editors side-by-side on a single host page.

Each editor:

- gets a unique auto-minted `instanceId`
- registers a separate `EditorHandle` in `window.GenOffice.editorRegistry`
- is registered in the iframe registry as `genoffice-{instanceId}` so the
  embed script can disambiguate concurrent instances via iframe `name`
  instead of relying on the fragile `event.source === iframe.contentWindow`
- can be saved, dirty-queried, and destroyed independently

This exercises every guarantee the SDK's multi-instance contract provides
(see `apps/sdk/test/kestrel-multi-instance.test.ts` and
`apps/sdk/test/multi-instance-isolation.test.ts` for the underlying
behavior pins; this demo shows them in a real browser).

## Run

```sh
# 1. Build the SDK UMD bundle (once)
pnpm --filter @genoffice/web-sdk build

# 2. Start the GenOffice web-server on http://localhost:18082
pnpm --filter @genoffice/web-server dev

# 3. Mint two JWTs (one per editor; same sub is fine for the demo)
JWT_A=$(curl -s -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"demo-user","scope":["files:read","files:write"]}' | jq -r .token)
JWT_B=$(curl -s -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"demo-user","scope":["files:read","files:write"]}' | jq -r .token)

# 4. Open index.html in a browser, paste the JWTs + docIds, click Mount.
```

## What the demo verifies

1. Two `createEditor()` calls land in the global `editorRegistry` map.
2. `listEditors()` returns both handles; `getEditor(id)` round-trips.
3. Each editor's `on('saved')` event fires for its own save only — not
   the other's (iframe-name dispatch is per-instance).
4. Destroying editor A leaves editor B's listeners + handle untouched.
5. After destroy, `getEditor(a)` returns `undefined`; `getEditor(b)`
   still returns B.

## Files

| File | Purpose |
|---|---|
| `index.html` | Standalone demo mounting two editors side-by-side. |
| `README.md` | This file. |

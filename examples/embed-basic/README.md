# `embed-basic` — minimal GenOffice iframe Embed example

Single-file HTML demonstrating the iframe Embed integration.

## Run

```sh
# 1. Start the GenOffice web-server on http://localhost:18082
cd /path/to/genoffice
pnpm --filter @genoffice/web-server dev

# 2. Mint a JWT (in another terminal)
curl -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"demo-user"}'

# 3. Open index.html in a browser, paste the JWT and a docId, click Mount.
```

The page loads `@genoffice/web-sdk` from `../../apps/sdk/dist/index.umd.js`
— that bundle is rebuilt by `pnpm --filter @genoffice/web-sdk build`.

## Files

| File | Purpose |
|---|---|
| `index.html` | Standalone demo using the SDK. |
| `no-sdk.html` | Same integration without the npm SDK — pure `<iframe>` + `postMessage`. Demonstrates the protocol surface that the SDK wraps. |

## How it works

The iframe URL is built with `buildEmbedUrl()`:

```js
const url = GenOffice.buildEmbedUrl({
  host: 'http://localhost:18082',
  documentId: 'doc_demo',
  app: 'docs',
  token: jwt,
  theme: 'auto',
  lang: 'zh-CN',
  toolbar: 'full',
})
iframe.src = url
```

The SDK performs a handshake with the embed iframe (a random nonce injected
into the URL must be echoed back in the `ready` event). Subscribe on the
host page:

```js
editor.on('ready', () => console.log('editor ready'))
editor.on('saved', (e) => console.log('saved version', e.version))
editor.on('error', (e) => console.error(e.code, e.message))
```

See `apps/sdk/README.md` for the full event / command surface.

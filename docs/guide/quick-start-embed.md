# Quick Start: Embed

Embed GenOffice in any web page with one `<iframe>`.

## Step 1 · Mint a token

```sh
curl -X POST https://genoffice.app/api/v1/auth/jwt \
  -H 'Content-Type: application/json' \
  -d '{"sub":"user-123","ttl":3600}'
```

Response:

```json
{ "token": "eyJhbGciOi…", "exp": 1700003600, "alg": "HS256" }
```

## Step 2 · Build the embed URL

```
GET /embed/<documentId>?token=<jwt>&app=<editor>&theme=<theme>&lang=<lang>&toolbar=<level>
```

| Parameter | Required | Notes |
|---|---|---|
| `:documentId` | yes | Whatever `id` your backend uses for the document. |
| `token` | yes | JWT minted above. |
| `app` | no (default `docs`) | `docs` / `sheets` / `slides` / `pdf` / `markdown` / `html`. |
| `theme` | no | `light` / `dark` / `auto`. |
| `lang` | no | `zh-CN` / `en-US` / `ja-JP`. |
| `toolbar` | no | `full` / `minimal` / `none`. |

## Step 3 · Drop it in an iframe

```html
<iframe
  id="genoffice"
  src="https://genoffice.app/embed/doc_abc?token=eyJ…&app=docs"
  style="width:100%;height:600px;border:0"
></iframe>
```

## Step 4 · Listen for events (optional)

```js
window.addEventListener('message', (event) => {
  if (event.data?.v !== '1.0') return
  if (event.data.kind === 'event' && event.data.payload?.name === 'ready') {
    console.log('editor ready')
  }
  if (event.data.kind === 'event' && event.data.payload?.name === 'saved') {
    console.log('saved:', event.data.payload.payload)
  }
})
```

See [postMessage Protocol](/api/postmessage-protocol) for the full event
surface.

## Hardening

- **CSP.** Add `frame-src https://genoffice.app` to your
  `Content-Security-Policy` (or your self-hosted origin).
- **Short-lived tokens.** Mint per-session JWTs; never embed long-lived
  credentials in HTML.
- **File-scoped tokens.** Use `POST /api/v1/files/:id/jwt` to issue a
  token that only authorises one document.

## What's next

- [SDK Reference](/api/sdk-typescript) — typed events and commands.
- [REST API](/api/rest-api) — full HTTP surface.
- [Security Best Practices](/guide/security-best-practices).

# postMessage Protocol v1.0

Wire format between the host page and the embed iframe.

## Envelope

Every message — in either direction — uses the same shape:

```ts
interface Envelope {
  v: '1.0'
  dir: 'host→editor' | 'editor→host'
  kind: 'event' | 'command' | 'command-result'
  correlationId?: string   // required for command / command-result
  payload: unknown
}
```

## Outbound events (`editor → host`)

| `payload.name` | When |
|---|---|
| `ready` | iframe has booted. |
| `saved` | a save round-trip finished. |
| `dirtyChanged` | edit buffer state changed. |
| `selectionChange` | caret or selection moved. |
| `error` | recoverable error. |
| `closed` | editor closed (back-nav or explicit close). |

## Inbound commands (`host → editor`)

The `payload` is `{ name, args }`. Editors MUST reply with a
`command-result` envelope carrying the same `correlationId`.

| Name | Args |
|---|---|
| `setTheme` | `{ theme }` |
| `setLang` | `{ lang }` |
| `setMode` | `{ mode }` |
| `setContent` | `{ text?, html?, immediate? }` |
| `getContent` | (none) → `{ text?, html?, bytes? }` |
| `insertImage` | `{ url, width?, height?, alt? }` |
| `insertText` | `{ text }` |
| `print` | (none) |
| `focus` | (none) |
| `aiRewrite` | `{ instruction, selection? }` |
| `aiTranslate` | `{ target, source? }` |
| `aiSummarize` | `{ length? }` |

## Origin validation

The SDK filters inbound `postMessage` events to `event.source ===
iframe.contentWindow` and `event.data.v === '1.0'`. The embed posts
`ready` to `window.parent` with `targetOrigin: '*'` — host pages
should restrict access via a CSP `frame-ancestors` directive.

## Versioning

The envelope version `1.0` is frozen for the lifetime of the v1
contract. Adding new `kind` values or `payload.name` values is
non-breaking; renaming or removing existing ones is.

# SDK Multi-instance

> SDK 2.0 Kestrel M1 (sdk1.md §B.5.1 #1, §11.38, §11.80). Landed on `release0919`.

Mount more than one editor on a single host page — for split-screen
comparisons, side-by-side translation, master/detail views, or any
layout that needs two (or more) independent GenOffice editors.

## What you get

Each editor gets a **stable per-instance id** that you can look up from
anywhere in your host code without threading the `EditorHandle` through
React props or callbacks.

```ts
import { createEditor, getEditor, listEditors } from '@genoffice/web-sdk'

const editorA = createEditor({
  container: '#left',
  documentId: 'doc-1',
  jwt,
  host,
  instanceId: 'split-left',       // optional — SDK auto-mints if omitted
})

const editorB = createEditor({
  container: '#right',
  documentId: 'doc-2',
  jwt,
  host,
  instanceId: 'split-right',
})

// Anywhere in your host code:
getEditor('split-left').command('setTheme', { theme: 'dark' })

const live = listEditors()        // [editorA, editorB] in insertion order
console.log(`there are ${live.length} editors on this page`)
```

## Contract pins

The SDK enforces three guarantees so multi-instance just works without
your code managing iframes manually:

| Guarantee | Why |
|---|---|
| `EditorHandle.instanceId` is always a non-empty string | Look it up via `getEditor(id)` from anywhere |
| `<iframe name>` is `genoffice-{instanceId}` | Embed script dispatches postMessage via `iframe.name`, not the fragile `event.source === iframe.contentWindow` check |
| `destroy()` removes the handle from the registry | `getEditor(id)` returns `undefined` afterward — no torn-down handles haunt your code |

Two `createEditor()` calls with the same `instanceId` throw a
remediation error: call `getEditor(id).destroy()` first.

## Live demo

The repo ships a runnable dual-iframe demo at
[`examples/sdk-multi-instance/`](https://github.com/genspark-ai/genoffice/tree/main/examples/sdk-multi-instance/).
It mounts two independent editors side-by-side and lets you save,
dirty-query, and destroy each one independently:

![multi-instance split layout — two editors side-by-side, each with its own Save / isDirty / Destroy controls and a shared event log.](/assets/sdk-multi-instance-demo.png)

The diagram above illustrates the layout — the page shows two editor
frames, a status bar, per-editor Save/isDirty/Destroy buttons, and a
shared event log that records `saved` / `dirtyChanged` / `error` /
`closed` events from both editors with their `instanceId` so you can
see the disambiguation working.

### Run it locally

```sh
# 1. Build the SDK UMD bundle
pnpm --filter @genoffice/web-sdk build

# 2. Start the web-server
pnpm --filter @genoffice/web-server dev    # http://localhost:18082

# 3. Mint two JWTs (one per editor; same sub is fine)
JWT_A=$(curl -s -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'content-type: application/json' \
  -d '{"sub":"demo-user","scope":["files:read","files:write"],"ttl":3600}' \
  | jq -r .token)

JWT_B=$(curl -s -X POST http://localhost:18082/api/v1/auth/jwt \
  -H 'content-type: application/json' \
  -d '{"sub":"demo-user","scope":["files:read","files:write"],"ttl":3600}' \
  | jq -r .token)

# 4. Serve the demo
cd examples/sdk-multi-instance
python3 -m http.server 8080
# open http://localhost:8080 and paste JWT_A / JWT_B into the form
```

### What the demo proves

- **`listEditors()` returns the live pair.** After `mount`, the status
  bar shows `2 editors: split-left, split-right` (the auto-minted ids
  use the `ed_<base64url>` shape — pin yours with `instanceId` to keep
  them stable across reloads).
- **`getEditor(id)` survives prop drilling.** Click "isDirty A" — the
  button reads `editorA.isDirty()` directly via `getEditor('split-left')`
  without the button needing a reference to the handle.
- **`destroy()` is per-instance.** Click "Destroy A" — editor B keeps
  working. `listEditors()` now returns `[editorB]`.
- **postMessage disambiguation.** The shared event log shows
  `[saved] instanceId=split-left` and `[saved] instanceId=split-right`
  even when both editors save within the same second. The embed bridge
  keys on `genoffice-{instanceId}` iframe `name` so events never get
  misrouted.

## Test pins

The behaviour is locked in by 23 unit tests across two suites:

- `apps/sdk/test/kestrel-multi-instance.test.ts` — 11 tests (auto-mint
  uniqueness, explicit id verbatim, `getEditor` hit / miss, registry
  removal on destroy, iframe `name` shape, etc.)
- `apps/sdk/test/multi-instance-isolation.test.ts` — 9 tests
  (concurrent mount/destroy/save/isDirty round-trips proving handles
  don't share state)

Run them locally:

```sh
pnpm --filter @genoffice/web-sdk test
```

## API summary

| Function | Returns | Notes |
|---|---|---|
| `createEditor(options?)` | `EditorHandle` | `instanceId` is optional in options; auto-minted if omitted |
| `getEditor(instanceId)` | `EditorHandle \| undefined` | Returns `undefined` after destroy |
| `listEditors()` | `EditorHandle[]` | New array each call; insertion order |
| `editor.destroy()` | `void` | Synchronous; tears down iframe + removes from registry |

See [SDK Reference](/api/sdk-typescript) for the full type surface.

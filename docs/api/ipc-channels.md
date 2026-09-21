# IPC Channels

GenOffice exposes **514 typed IPC channels** from the main process (or
the web-server when running standalone) to the renderer. Each channel
is registered via `registerHandle(name, handler)` and addressable
through HTTP at `POST /api/ipc/:channel` with a JSON body of shape
`{ "args": [...] }`.

## Auto-generated reference

The full list — grouped by capability directory, with file locations and
docstrings pulled from the source — is regenerated on every release by
[`tools/gen-ipc-docs.mjs`](https://github.com/genspark-ai/genoffice/blob/main/tools/gen-ipc-docs.mjs).

> 📄 [Browse all 514 channels →](./ipc-channels-auto.md)

The auto-generated file is checked into the repo at
`apps/web-server/IPC_CHANNELS.md` so you can grep it locally:

```sh
grep -A 3 '^### `workbook:save`' apps/web-server/IPC_CHANNELS.md
```

## Channel naming convention

`<area>:<verb>` — for example:

- `docs:save` · `docs:open` · `docs:create-document`
- `sheets:read-range` · `workbook:save` · `sheets:list-sheets`
- `slides:apply-txn` · `slides:save` · `slides:save-as`
- `pdf:save` · `pdf:export-images`
- `markdown:save` · `markdown:open`
- `html:save` · `html:save-file`
- `ai:chat` · `ai:capabilities` · `ai:fetch-image`
- `files:upload` · `files:read` · `files:delete`
- `home:recents` · `home:starred`
- `web:save-file` · `web:read-file-bytes`

## Argument encoding

Transport-level encoding rules live in
`@genoffice/ipc-bridge/transport` (`encodeTransportValue` /
`decodeTransportValue`). Byte arrays round-trip as
`{ __ipcBytes: '…', b64: '…' }`. Promises and other non-serialisable
values are rejected with `INVALID_ARGUMENT`.

## Adding a new channel

1. Find the right capability directory (`apps/web-server/src/<area>`).
2. Add a JSDoc above the `registerHandle(...)` call describing the
   contract.
3. Run `node tools/gen-ipc-docs.mjs` to regenerate the reference.
4. Add an integration test under `apps/web-server/tests/`.

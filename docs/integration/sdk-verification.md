# SDK Verification (contract gate)

The SDK's unit tests are mocked, and mocks encode *our belief* about the
server's wire format. When that belief drifts, the suite stays green while
every real call fails. This page is about the gate that catches that.

```bash
npm run verify:sdk
```

One command: build the SDK and the web-server bundle, boot a throwaway server
on a free port, run the SDK's real clients against it over HTTP, tear
everything down. Exit code 0 means the contract holds.

## Why it exists

Two incidents, both invisible to a mocked suite:

1. **The IPC envelope.** Four collab clients read payloads off the top level
   of the response envelope. Every mock served bare payloads, so 410 tests
   passed while `list()` returned `[]` forever and `add()` threw against a
   real server.
2. **A floating rejection on abort.** `SseParser.close()` called
   `reader.cancel()` without handling the returned promise. On a real socket
   that promise rejects with the abort reason; the rejection was unhandled
   and killed the probe process. The existing hanging-stream fixture cannot
   reproduce it — its `cancel()` always resolves — so no mock test could ever
   have found it.

Neither class of bug is findable without a real server. That is the whole
argument for this gate.

## What it runs

### `npm run verify:sdk` — full gate

```
build SDK  →  bundle web-server  →  reserve port  →  boot server
           →  poll /api/v1/health  →  run live-probe.mjs  →  SIGTERM + cleanup
```

| Env knob | Effect |
|---|---|
| `PROBE_SKIP_BUILD=1` | reuse the existing `dist/` instead of rebuilding |
| `PROBE_VERBOSE=1` | stream the child server's stdout/stderr |
| `PROBE_KEEP=1` | leave the temp data directory on disk for inspection |

Build steps have a 5-minute cap; the health poll gives up after 20 s.

### `npm run probe:live` — probe only

Runs `live-probe.mjs` against a server **you** already have running. Default
target `http://127.0.0.1:18081`, override with `PROBE_BASE`.

```bash
PROBE_BASE=http://127.0.0.1:18081 npm run probe:live -w @genoffice/web-sdk
```

Without `PROBE_BEARER` the v1 groups (embed, translation) print a `SKIP` line
and are not counted. That is deliberate — a skipped group is not a passed
group. To include them, mint a JWT carrying `files:read`, `files:write` and
`ai:translate`, then export it:

```bash
PROBE_BEARER=<jwt> npm run probe:live -w @genoffice/web-sdk
```

## What it covers

- **Collab over IPC** — cursor, presence, lock and comments, including the
  `NOT_FOUND` / `CONFLICT` paths. This is the original envelope regression.
- **Static SDK allowlist** — `GET /static/sdk/<entry>.mjs` for the entries
  the web-server serves from a hard-coded pattern. A missing entry is
  invisible locally (the SDK tests import `dist/` directly) and a 404 on a
  CDN-hosted deployment, so the probe fetches them over HTTP.
- **Embed closure** — creates a real file, calls `openEmbedSession()`, and
  asserts the returned URL, that re-verifying the minted pair still succeeds
  (proving `verify-nonce` is non-consuming), that `cleanup()` releases and is
  idempotent, and that a released session no longer verifies.
- **Translation on v1** — a recording `fetch` proves every translation call
  targets `/api/v1/ai/…` and none falls back to the legacy `/api/ai/…` path.

The translation assertions check that the **route understood the request**,
not that a translation succeeded. CI has no LLM provider key, so a batch
comes back HTTP 200 with a per-unit `status: "failed"` and
`"Claude HTTP 401: Missing API key"`. The probe asserts the shape is not a
400 `expected { text, from?, to }` — i.e. that the v1 route accepts `units[]`.
Do not "fix" the probe by asserting a successful translation; it would become
environment-dependent and fail for the wrong reason.

## What it does **not** cover

**The real iframe ↔ `postMessage` bridge.** The probe speaks REST; it never
loads an iframe. A browser is required, and the CI runner has none. The
boundary matters: a green `verify:sdk` says nothing about bridge wiring,
`event.source` / `event.origin` checks, or the handshake echo.

That surface is covered elsewhere:

- `apps/sdk/test/dataflare/iframe-bridge-e2e.test.ts` — bridge handshake
  against a real iframe, in a jsdom-ish environment
- `e2e/` — the Playwright suite (`npm run test:e2e`) driving real renderers

## CI

`.github/workflows/ci.yml` runs the gate as the `sdk-contract` job on every
push and PR. The job is deliberately **not** in `docker`'s `needs` list: it
guards the workflow's overall status without adding ~4 minutes to the release
path.

Two related fixes landed with it:

- The old `build` job ran `npm run build -w @genoffice/sdk --if-present`. The
  package is `@genoffice/web-sdk`; `--if-present` made the wrong name a silent
  no-op, so that job built nothing.
- The root `test` script never listed the SDK, so its suite never ran in CI.
  It does now.

## When the gate fails

Treat a failure as a real contract break, in one of three directions:

1. **The SDK drifted** — it calls a path or sends a body the server no longer
   accepts. Fix the SDK.
2. **The server drifted** — a route moved, a scope tightened, a response field
   was renamed. Fix the server, or update the SDK to match, deliberately.
3. **The probe is wrong** — only after confirming the first two. The probe
   encodes the contract the rest of the repo depends on; loosening it to make
   it pass removes the gate.

Before changing the probe, prove the gate can still fail: rename the `nonce`
parameter in `buildDataflareEmbedUrl` and re-run. One assertion must go red.
A gate that cannot fail is not a gate.

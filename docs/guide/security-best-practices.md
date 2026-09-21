# Security Best Practices

## Secrets

- **Always set `GENOFFICE_JWT_SECRET`.** Use a 256-bit random value
  (`openssl rand -hex 32`). Rotate quarterly.
- **Set `WEB_TOKEN`** in any environment where the IPC bridge is
  reachable from the network. Use a separate secret from
  `GENOFFICE_JWT_SECRET`.
- **Use RS256 in multi-tenant deployments.** Issue tokens from a
  central auth service and verify with `GENOFFICE_JWT_PUBLIC_KEY`.

## Network

- **Run behind TLS.** The bundled server is HTTP-only; terminate TLS
  in Caddy / nginx / a sidecar.
- **Restrict CORS.** Set `WEB_CORS_ORIGINS` to an explicit allowlist
  (`https://app.example.com,https://admin.example.com`).
- **Drop unauthenticated requests at the edge.** Use nginx `limit_req`
  to throttle `/api/v1/auth/jwt` and `/api/ipc/:channel`.

## File handling

- The server reads every regular file in `DATA_DIR` at boot to populate
  recents. Mount `DATA_DIR` as a read-only volume if you only need
  read access.
- The iframe Embed endpoint serves whatever file lives at
  `:docId`. Restrict `:docId` to a known prefix on the calling side
  (`/embed/<prefix>-<uuid>?token=…`) so the embed can't be tricked
  into loading files outside the trusted area.

## AI

- All LLM / image providers run with the user's own API key; no
  requests are proxied through GenOffice infrastructure.
- The Agent Loop has a `maxSteps` cap (default 8, configurable up to
  1000) to bound the cost of runaway loops.
- Skill execution surfaces `SkillError` with structured codes; the
  renderer can localise the message instead of leaking the raw
  provider error.

## Webhooks

- Delivery is best-effort with a 5-second cap. Slow / 5xx targets are
  logged but do not fail the save.
- Webhook URLs are stored verbatim; validate them at registration
  (block private IP ranges to prevent SSRF — `127.0.0.1`,
  `169.254.0.0/16`, `10.0.0.0/8`, …).

## Reporting

- See [`SECURITY.md`](https://github.com/genspark-ai/genoffice/blob/main/SECURITY.md)
  for the disclosure process. Email `security@genoffice.app`.

# Security Policy

## Supported versions

The following versions of GenOffice receive security updates:

| Version | Supported |
|---|---|
| latest release | ✅ |
| previous minor (≤ 6 months old) | ✅ |
| older | ⚠️ best-effort, no SLA |

## Reporting a vulnerability

**Please do NOT file a public GitHub issue for security bugs.**

Email **security@genoffice.app** with:

- A description of the vulnerability and its impact.
- Reproduction steps (proof-of-concept preferred).
- The affected component (`@genoffice/web-server`, `@genoffice/ai-provider`,
  `apps/docs`, …) and version.

You will receive an acknowledgement within 48 hours. We aim to ship a
patch within 14 days for critical issues and 30 days for lower
severity. Critical CVEs are coordinated with the reporter before public
disclosure.

## Disclosure process

1. Reporter emails `security@genoffice.app`.
2. Maintainer triages within 48 h and assigns a CVE id.
3. Patch developed in a private fork; embargoed until release.
4. Coordinated release: GitHub Security Advisory + npm provenance tag.
5. Public disclosure 7 days after the patched release is available.

## Hardening checklist for self-hosted deployments

- **Set `GENOFFICE_JWT_SECRET`** to a 256-bit (or longer) random value.
  Without it the v1 API answers `503 NOT_CONFIGURED` for authed routes.
- **Run behind HTTPS.** The JWT is sent in the `Authorization: Bearer …`
  header; a network observer can replay it for the TTL window.
- **Set `WEB_CORS_ORIGINS`** to an explicit allowlist (comma-separated).
  Without it the server echoes the request's `Origin`, which is fine for
  development but unsafe on the public internet.
- **Restrict `DATA_DIR`** to a non-shared filesystem. The file watcher
  reads every regular file in the tree at boot.
- **Disable skill hot-reload in production.** Keep
  `genoffice.providers.json` and `genoffice.skills.json` outside the
  deploy artefact so an attacker who can write to the bundle cannot
  also register a new plugin.

## Known limitations

- The iframe Embed endpoint does not validate the parent's origin (we
  post `ready` to `window.parent` with targetOrigin `'*'`). Restrict
  access via a CSP `frame-ancestors` directive on the host page.
- The IPC bridge (`/api/ipc/:channel`) is gated by `WEB_TOKEN`. Without
  it, anyone on the network can invoke channels. Always set
  `WEB_TOKEN` in production.

## Past advisories

(None yet — this is a new public release.)

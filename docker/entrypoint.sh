#!/bin/sh
# Tiny entrypoint that:
#   - ensures DATA_DIR / FILES_DIR exist
#   - exec's the bundled server (PID 1, signal-friendly)
set -e

if ! mkdir -p "$DATA_DIR" "$FILES_DIR" 2>/dev/null; then
  echo "[genoffice] cannot create DATA_DIR=$DATA_DIR / FILES_DIR=$FILES_DIR." >&2
  echo "[genoffice] The process runs as the unprivileged 'node' user (uid 1000)." >&2
  echo "[genoffice] A bind-mounted host directory must be writable by that uid." >&2
  exit 1
fi

# Authed v1 routes need GENOFFICE_JWT_SECRET; the IPC/AI surface needs
# WEB_TOKEN. Neither is required on a loopback bind, but on any other bind the
# server's own startup check refuses to serve without WEB_TOKEN — so this is a
# heads-up about the remaining gap, not the last word on either.
if [ -z "$GENOFFICE_JWT_SECRET" ] && [ -z "$WEB_TOKEN" ]; then
  echo "[genoffice] WARNING: GENOFFICE_JWT_SECRET and WEB_TOKEN are both unset." >&2
  echo "[genoffice]          Authed v1 routes will answer 503 NOT_CONFIGURED." >&2
fi

exec node ./bundle/index.js

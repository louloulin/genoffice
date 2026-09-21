#!/bin/sh
# Tiny entrypoint that:
#   - ensures FILES_DIR exists
#   - exec's the bundled server (PID 1, signal-friendly)
set -e

mkdir -p "$DATA_DIR" "$FILES_DIR"

# If GENOFFICE_JWT_SECRET is unset in production, warn loudly and refuse to
# serve authed v1 routes (they answer 503 NOT_CONFIGURED). This is the safer
# default than silently minting a predictable secret.
if [ -z "$GENOFFICE_JWT_SECRET" ] && [ -z "$WEB_TOKEN" ]; then
  echo "[genoffice] WARNING: GENOFFICE_JWT_SECRET and WEB_TOKEN are both unset." >&2
  echo "[genoffice]          Authed v1 routes will answer 503 NOT_CONFIGURED." >&2
fi

exec node ./bundle/index.js

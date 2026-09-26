#!/usr/bin/env bash
# Per-domain HTTP smoke for @genoffice/web-server.
# Each domain is a tuple of (label, channel, sample-args-JSON).
# Args are designed to be VALID enough to hit dispatcher body validation,
# not just auth.
set -uo pipefail

BASE="${WEB_BASE_URL:-http://127.0.0.1:18091}"
TOKEN="${WEB_TOKEN:-test-web-token}"

# pre-mint a JWT for cookie-less JWT-gated routes
JWT=$(curl -s -X POST "$BASE/api/v1/auth/jwt" \
  -H 'content-type: application/json' \
  -H "authorization: Bearer $TOKEN" \
  -d '{"sub":"smoke","scope":["files:read","files:write","files:versions"]}' \
  | python3 -c "import sys,json;print(json.load(sys.stdin).get('token',''))" 2>/dev/null)
echo "JWT len=${#JWT}"

results=()
record() {
  local label="$1"; local code="$2"; local body="$3"
  results+=("$label | $code | $(echo "$body" | head -c 250)")
}

call() {
  local label="$1" channel="$2" payload="$3"
  local code body
  body=$(curl -s -o /tmp/_smoke_body -w "%{http_code}" \
    -X POST "$BASE/api/ipc/$channel" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $TOKEN" \
    -d "$payload" 2>/dev/null)
  code="$body"
  body=$(head -c 250 /tmp/_smoke_body)
  record "$label" "$code" "$body"
}

echo "===== TOP-LEVEL HEALTH/PROTOCOL ====="
record "GET /health" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" "$BASE/health")" \
  "$(head -c 200 /tmp/_smoke_body)"
record "GET /api/channels" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" "$BASE/api/channels")" \
  "$(head -c 200 /tmp/_smoke_body)"
record "GET /api/v1/health" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" "$BASE/api/v1/health")" \
  "$(head -c 200 /tmp/_smoke_body)"
record "GET /api/v1/changelog" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" "$BASE/api/v1/changelog")" \
  "$(head -c 200 /tmp/_smoke_body)"

echo "===== DOCS ====="
call "docs:open-path" "docs:open-path" '{"args":["/tmp/genoffice-data/files/verify-doc-001.md"]}'
call "docs:open-path-bad" "docs:open-path" '{"args":["/etc/passwd"]}'
call "docs:create-document" "docs:create-document" '{"args":[{"format":"md"}]}'
call "docs:recent" "docs:recent" '{"args":[]}'
call "docs:get-settings" "docs:get-settings" '{"args":[]}'

echo "===== SHEETS ====="
call "sheets:new-blank" "sheets:new-blank" '{"args":[{}]}'
call "sheets:consume-new-blank" "sheets:consume-new-blank" '{"args":[]}'

echo "===== SLIDES ====="
call "slides:open" "slides:open" '{"args":[]}'
call "slides:get-slide-size" "slides:get-slide-size" '{"args":[]}'
call "slides:get-render-slides" "slides:get-render-slides" '{"args":[]}'
call "slides:font-catalog" "slides:font-catalog" '{"args":[]}'

echo "===== PDF ====="
call "pdf:list-edit-fonts" "pdf:list-edit-fonts" '{"args":[]}'
call "pdf:can-draw-text" "pdf:can-draw-text" '{"args":[]}'
call "pdf:read-file-bad" "pdf:read-file" '{"args":["/etc/passwd"]}'

echo "===== MARKDOWN ====="
call "markdown:read-file-bad" "markdown:read-file" '{"args":["/etc/passwd"]}'

echo "===== HTML ====="
call "html:preview-info" "html:preview-info" '{"args":["nonexistent-id"]}'

echo "===== SHELL / HOME ====="
call "home:list-modules" "home:list-modules" '{"args":[]}'
call "home:get-theme" "home:get-theme" '{"args":[]}'
call "home:get-language" "home:get-language" '{"args":[]}'
call "home:get-data-paths" "home:get-data-paths" '{"args":[]}'
call "home:cloud-projects" "home:cloud-projects" '{"args":[]}'
call "home:ai-capabilities" "home:ai-capabilities" '{"args":[]}'
call "home:starred" "home:starred" '{"args":[]}'
call "home:recents" "home:recents" '{"args":[]}'
call "home:install-skill" "home:install-skill" '{"args":[{"id":"nonexistent"}]}'

echo "===== COLLAB ====="
call "collab:lock-status" "collab:lock-status" '{"args":[{"docId":"verify-doc-001"}]}'
call "collab:presence-list" "collab:presence-list" '{"args":[{"docId":"verify-doc-001"}]}'
call "collab:cursor-list" "collab:cursor-list" '{"args":[{"docId":"verify-doc-001"}]}'
call "collab:permissions-get" "collab:permissions-get" '{"args":[{"docId":"verify-doc-001"}]}'
call "collab:sync" "collab:sync" '{"args":[{"docId":"verify-doc-001","baseRev":0}]}'

echo "===== COMMENTS / HISTORY ====="
call "comments:list" "comments:list" '{"args":[{"docId":"verify-doc-001"}]}'
call "comments:add" "comments:add" '{"args":[{"docId":"verify-doc-001","body":"smoke test comment"}]}'
call "history:versions" "history:versions" '{"args":[{"docId":"verify-doc-001"}]}'

echo "===== AI ====="
call "ai:get-settings" "ai:get-settings" '{"args":[]}'
call "ai:gsk-status" "ai:gsk-status" '{"args":[]}'
call "ai:codex-models" "ai:codex-models" '{"args":[]}'
call "ai:list-style-templates" "ai:list-style-templates" '{"args":[]}'

echo "===== ENTERPRISE ====="
call "auth:logout" "auth:logout" '{"args":[]}'
call "audit:log" "audit:log" '{"args":[{"action":"smoke","actor":"verify"}]}'
call "audit:query" "audit:query" '{"args":[{}]}'
call "users:list" "users:list" '{"args":[]}'
call "tenant:list" "tenant:list" '{"args":[]}'
call "workflow:list" "workflow:list" '{"args":[]}'
call "calendar:list-events" "calendar:list-events" '{"args":[]}'
call "mail:list" "mail:list" '{"args":[]}'

echo "===== ANYDOC ====="
call "anydoc:get-config" "anydoc:get-config" '{"args":[]}'
call "anydoc:extract-text-bad" "anydoc:extract-text" '{"args":["/etc/passwd"]}'

echo "===== FILES / PROJECTS ====="
call "files:list-versions" "files:list-versions" '{"args":[{"fileId":"verify-doc-001"}]}'
call "project:list" "project:list" '{"args":[]}'
call "files:read-bad" "files:read" '{"args":[{"path":"/etc/passwd"}]}'

echo "===== SDK COMMAND (real round-trip) ====="
call "sdk:command-addComment" "sdk:command" '{"args":[{"name":"addComment","args":{"docId":"verify-doc-001","body":"smoke"},"docId":"verify-doc-001"}]}'
call "sdk:command-listComments" "sdk:command" '{"args":[{"name":"listComments","args":{"docId":"verify-doc-001"},"docId":"verify-doc-001"}]}'
call "sdk:command-listVersions" "sdk:command" '{"args":[{"name":"listVersions","args":{"docId":"verify-doc-001"},"docId":"verify-doc-001"}]}'

echo "===== V1 ENDPOINTS ====="
record "POST /api/v1/auth/jwt" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" \
    -X POST "$BASE/api/v1/auth/jwt" \
    -H 'content-type: application/json' \
    -H "authorization: Bearer $TOKEN" \
    -d '{"sub":"smoke2","scope":["files:read"]}')" \
  "$(head -c 200 /tmp/_smoke_body)"

record "GET /api/v1/meta" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" \
    -H "authorization: Bearer $TOKEN" \
    "$BASE/api/v1/meta")" \
  "$(head -c 200 /tmp/_smoke_body)"

record "GET /api/v1/metrics" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" \
    -H "authorization: Bearer $TOKEN" \
    "$BASE/api/v1/metrics")" \
  "$(head -c 200 /tmp/_smoke_body)"

record "GET /api/v1/files" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" \
    -H "authorization: Bearer $TOKEN" \
    -H "x-genoffice-token: $TOKEN" \
    "$BASE/api/v1/files")" \
  "$(head -c 200 /tmp/_smoke_body)"

# 405 / 404 / path-traversal
record "DELETE /api/v1/health (expect 405)" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" \
    -X DELETE -H "authorization: Bearer $TOKEN" \
    "$BASE/api/v1/health")" \
  "$(head -c 200 /tmp/_smoke_body)"

record "GET /api/v1/files/../../etc/passwd (expect 400)" \
  "$(curl -s -o /tmp/_smoke_body -w "%{http_code}" \
    -H "authorization: Bearer $TOKEN" \
    "$BASE/api/v1/files/..%2F..%2Fetc%2Fpasswd")" \
  "$(head -c 200 /tmp/_smoke_body)"

echo "===== SUMMARY ====="
ok=0; fail=0; auth=0; body=0; notimp=0
for r in "${results[@]}"; do
  echo "  $r"
done

printf "\n--- Total: ${#results[@]} ---\n"
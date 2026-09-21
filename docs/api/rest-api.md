# REST API v1

Stable HTTP surface — sd1.md §2.1.A. Backward compatible inside v1.x;
six-month deprecation before v2.

## Auth

Every endpoint except `/api/v1/health`, `/api/v1/changelog`, and the
`/api/v1/auth/*` group requires:

```http
Authorization: Bearer <jwt>
```

Mint a token with `POST /api/v1/auth/jwt`:

```http
POST /api/v1/auth/jwt
Content-Type: application/json

{ "sub": "user-123", "ttl": 3600 }
```

Response: `{ "token": "eyJ…", "exp": 1700003600, "alg": "HS256" }`.

Configure the signing secret with `GENOFFICE_JWT_SECRET`. RS256 is
available by setting `GENOFFICE_JWT_ALG=RS256` + `GENOFFICE_JWT_PRIVATE_KEY`.

## Errors

```json
{
  "error": {
    "code": "INVALID_ARGUMENT",
    "message": "expected { name, bytes }",
    "channel": "files:create"
  }
}
```

Common codes: `INVALID_ARGUMENT`, `UNAUTHENTICATED`, `NOT_FOUND`,
`PAYLOAD_TOO_LARGE`, `INTERNAL`, `NOT_CONFIGURED`.

## Endpoints

| Method | Path | Notes |
|---|---|---|
| `GET`  | `/api/v1/health` | Public. Implementation metadata + channel count. |
| `GET`  | `/api/v1/changelog` | Public. Markdown changelog. |
| `POST` | `/api/v1/auth/jwt` | Mint a JWT. |
| `POST` | `/api/v1/auth/oauth/token` | OAuth 2.0 client_credentials. |
| `GET`  | `/api/v1/files` | List FILES_DIR entries. |
| `POST` | `/api/v1/files` | Upload `{name, bytes|base64}`. |
| `GET`  | `/api/v1/files/:id` | Metadata. |
| `DELETE` | `/api/v1/files/:id` | Remove. |
| `POST` | `/api/v1/files/:id/jwt` | File-scoped token. |
| `POST` | `/api/v1/files/:id/callback` | Register save webhook. |
| `GET`  | `/api/v1/ai/capabilities` | LLM / image / search provider snapshot. |
| `POST` | `/api/v1/ai/chat` | Streaming chat (SSE). |
| `POST` | `/api/v1/ai/translate` | Synchronous batch translate. |
| `POST` | `/api/v1/ai/image` | Image generation. |
| `POST` | `/api/v1/ai/skill/:name` | Invoke a registered Skill. |
| `GET`  | `/api/v1/kb/search?q=...` | Search the KB. |
| `GET`  | `/api/v1/kb/entries` | List KB entries. |
| `POST` | `/api/v1/webhooks` | Upsert an org-wide webhook subscription. |
| `DELETE` | `/api/v1/webhooks` | Remove the org subscription. |
| `POST` | `/api/v1/callbacks` | Admin-only: fire a callback on demand. |

## Webhook envelope

```http
POST <your-url>
Content-Type: application/json

{
  "v": "1.0",
  "event": "file.saved",
  "ts": 1700003600,
  "fileId": "abc.docx",
  "data": {
    "path": "/files/abc.docx",
    "size": 1234,
    "format": "docx"
  }
}
```

Delivery is best-effort with a 5-second cap. Register at the
file level (`POST /api/v1/files/:id/callback`) or org level
(`POST /api/v1/webhooks`).

## Versioning

- `v1.x` is frozen for the lifetime of the v1 contract. Optional fields
  may be added; required fields cannot be removed until v2.
- `v2` is announced six months in advance; old endpoints move to
  `/api/v1/legacy/` for the deprecation window.

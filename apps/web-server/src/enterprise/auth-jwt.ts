/**
 * Enterprise JWT rotation IPC handlers (sdk1 §11.79).
 *
 * Two new channels layered on top of the admin revocation registry
 * (`revokeJti` / `listRevokedJtis`) added to `apps/web-server/src/api/v1/auth.ts`:
 *
 *   - `auth:revoke-jti` (scope: auth:rotate)
 *       Admin rotates / invalidates a JWT by adding its `jti` to the admin
 *       revocation registry. Tokens whose `jti` is in the registry fail
 *       `verifyJwtWithRevocation` immediately, before any file-scoped hook
 *       fires. Idempotent: revoking the same `jti` twice returns `false`
 *       rather than throwing.
 *
 *   - `auth:list-revoked-jtis` (scope: auth:read)
 *       Read-only view of the admin registry. Returns the JTI list in
 *       insertion order (oldest first). Used by audit dashboards and by
 *       `auth:rotate-secret` follow-ups.
 *
 * Both channels are HARD-scoped: they require an `Authorization: Bearer`
 * header carrying the matching scope. The in-process web-renderer IPC
 * stack has no reason to call them — they're for v1 REST / iframe host
 * / cross-tenant admin tooling.
 */
import { InvalidArgumentError } from '../ai/errors'
import { registerHandle } from '../common/index'
import { listRevokedJtis, revokeJti } from '../api/v1/auth'

export function registerEnterpriseAuthJwtHandlers(): void {
  registerHandle(
    'auth:revoke-jti',
    (_event: unknown, args: unknown) => {
      const { jti, reason } = (args || {}) as { jti?: string; reason?: string }
      if (typeof jti !== 'string' || jti.length === 0) {
        throw new InvalidArgumentError('auth:revoke-jti', 'jti must be a non-empty string')
      }
      const added = revokeJti(jti)
      return {
        ok: true,
        jti,
        added,
        reason: reason ?? null,
        revokedAt: Date.now(),
      }
    },
    { scope: 'auth:rotate' },
  )

  registerHandle(
    'auth:list-revoked-jtis',
    (_event: unknown, args: unknown) => {
      const { limit, offset } = (args || {}) as { limit?: number; offset?: number }
      const all = listRevokedJtis()
      const maxResults = limit ?? 100
      const startOffset = offset ?? 0
      const slice = all.slice(startOffset, startOffset + maxResults)
      return {
        ok: true,
        total: all.length,
        offset: startOffset,
        limit: maxResults,
        jtis: slice,
      }
    },
    { scope: 'auth:read' },
  )
}

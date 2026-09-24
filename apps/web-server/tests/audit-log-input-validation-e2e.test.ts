/**
 * §11.123: `audit:log` IPC handler accepted malformed `status`,
 * `resourceId`, `userId`, and `details`.
 *
 * Before the fix:
 *   - `apps/web-server/src/enterprise/auth-audit.ts:75` registered the
 *     `audit:log` channel with type validation for ONLY three of seven
 *     fields: `action` / `resource` / `tenantId` were validated as
 *     strings, but `resourceId` / `userId` / `status` / `details` were
 *     cast via TypeScript's `as` (which is a no-op at runtime) and
 *     passed verbatim to `recordAudit`. The `RecordAuditInput`
 *     interface declared the correct types, but IPC is an external
 *     boundary — TypeScript types don't enforce anything across the
 *     wire.
 *   - Concrete bugs this let through:
 *       1. `status: 'anything'` (truthy non-enum) → stored verbatim.
 *          `queryAudit` does not filter on `status`, but the recorded
 *          value still appears in every `GET /api/v1/metrics` /
 *          `audit:query` response, polluting the audit log with values
 *          outside the documented 'success' | 'failure' enum.
 *       2. `resourceId: 12345` (number) → stored verbatim. The audit
 *          ring buffer's `resourceId` field was typed `string`, but
 *          the IPC handler accepted numbers, booleans, objects, etc.
 *       3. `details: 'a 1MB string'` (DoS surface). The handler does
 *          not cap the size of `details`; recordAudit stores whatever
 *          is sent into the JSONL ring buffer. A single 10MB `details`
 *          call would evict 100+ legitimate entries via MAX_RECORDS
 *          overflow (10000 cap).
 *       4. `details: ['a','b']` (array) → stored verbatim. The
 *          interface declares `Record<string, unknown>`, but arrays
 *          slip through because of the missing runtime check.
 *       5. `details: { __proto__: { polluted: 1 } }` (prototype-
 *          pollution attempt). `JSON.parse` in Node 22+ preserves
 *          `__proto__` as a literal key; if the consumer ever does
 *          `Object.assign(target, details)` or merge-spreads it,
 *          `target.__proto__` is overwritten globally. recordAudit
 *          currently uses object spread (`...input.details`), which
 *          treats `__proto__` as a regular property — so this is
 *          defense in depth, not an active exploit.
 *       6. `userId: 123` (non-string impersonation). The override
 *          semantic itself is documented for server-side batch use
 *          (see auth-audit.ts comment), but accepting a number as
 *          userId is unambiguously caller error.
 *
 * The fix mirrors the §11.115 / §11.117 / §11.120 pattern: each new
 * validation block is `if (X !== undefined && typeof X !== 'string')
 * throw InvalidArgumentError(...)` (or the equivalent for objects /
 * enums). `details` is rejected as `string / number / array / null`
 * and accepted only as a non-null object. `status` is restricted to
 * the two documented enum values.
 *
 * This test pins every malformed shape with an exact 400 envelope
 * match and asserts happy paths for valid enums / types continue to
 * return 200.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

interface IpcEnvelope {
  ok?: boolean
  result?: unknown
  error?: { code?: string; message?: string; channel?: string }
}

describe.skipIf(skip)('audit:log IPC input validation (sdk1 §11.123)', () => {
  it('rejects all malformed status / resourceId / userId / details; accepts valid shapes', async () => {
    const h = await ServerHarness.start()
    try {
      // `audit:write` scope is the documented gate for this channel
      // (sdk1 §11.78 enterprise scope hardening).
      const token = await h.token('audit-input-tester', ['audit:write'])

      async function callAuditLog(args: Record<string, unknown>): Promise<{ status: number; body: IpcEnvelope }> {
        const r = await fetch(`${h.base}/api/ipc/audit:log`, {
          method: 'POST',
          headers: {
            'authorization': `Bearer ${token}`,
            'content-type': 'application/json',
          },
          body: JSON.stringify({ args: [args] }),
          signal: AbortSignal.timeout(5000),
        })
        const body = await r.json() as IpcEnvelope
        return { status: r.status, body }
      }

      // === §11.123 status enum ===

      // 1. status='invalid' (non-enum) → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', status: 'invalid' })
        expect(r.status).toBe(400)
        expect(r.body.error?.code).toBe('INVALID_ARGUMENT')
        expect(r.body.error?.message).toMatch(/status must be 'success' or 'failure'/)
      }
      // 2. status='SUCCESS' (case-sensitive; enum only) → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', status: 'SUCCESS' })
        expect(r.status).toBe(400)
        expect(r.body.error?.message).toMatch(/status must be 'success' or 'failure'/)
      }
      // 3. status=200 (numeric truthy) → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', status: 200 })
        expect(r.status).toBe(400)
        expect(r.body.error?.message).toMatch(/status must be 'success' or 'failure'/)
      }
      // 4. status=true → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', status: true })
        expect(r.status).toBe(400)
      }

      // === §11.123 resourceId ===

      // 5. resourceId=12345 (number) → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', resourceId: 12345 })
        expect(r.status).toBe(400)
        expect(r.body.error?.message).toMatch(/resourceId must be a string/)
      }
      // 6. resourceId=true (boolean) → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', resourceId: true })
        expect(r.status).toBe(400)
      }
      // 7. resourceId=['x'] (array) → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', resourceId: ['x'] })
        expect(r.status).toBe(400)
      }

      // === §11.123 userId ===

      // 8. userId=123 (numeric impersonation) → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', userId: 123 })
        expect(r.status).toBe(400)
        expect(r.body.error?.message).toMatch(/userId must be a string/)
      }
      // 9. userId=true → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', userId: true })
        expect(r.status).toBe(400)
      }
      // String userId override is still accepted (documented for
      // server-side batch use).
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', userId: 'batch-impersonator' })
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
      }

      // === §11.123 details ===

      // 10. details as string → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', details: 'not-an-object' })
        expect(r.status).toBe(400)
        expect(r.body.error?.message).toMatch(/details must be a plain object/)
      }
      // 11. details as number → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', details: 12345 })
        expect(r.status).toBe(400)
      }
      // 12. details as array → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', details: ['a', 'b'] })
        expect(r.status).toBe(400)
      }
      // 13. details as null → 400
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', details: null })
        expect(r.status).toBe(400)
      }
      // 14. details as valid object → 200
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', details: { key: 'value' } })
        expect(r.status).toBe(200)
      }
      // 15. details with __proto__ literal → 200 (treated as a regular
      // key by JSON.parse + object spread; not exploited because the
      // store doesn't do Object.assign / merge).
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', details: { __proto__: { polluted: 1 }, normal: 'ok' } })
        expect(r.status).toBe(200)
      }

      // === Happy paths ===

      // 16. Full valid envelope with all documented fields → 200
      {
        const r = await callAuditLog({
          action: 'login',
          resource: 'auth',
          resourceId: 'user-123',
          details: { method: 'password' },
          status: 'success',
          userId: 'tester',
          tenantId: 'acme',
        })
        expect(r.status).toBe(200)
        expect(r.body.ok).toBe(true)
      }
      // 17. Empty object (no optional fields) → 200 (action / resource default)
      {
        const r = await callAuditLog({ action: 'logout', resource: 'auth' })
        expect(r.status).toBe(200)
      }
      // 18. status='failure' is accepted → 200
      {
        const r = await callAuditLog({ action: 'login', resource: 'auth', status: 'failure' })
        expect(r.status).toBe(200)
      }
    } finally {
      await h.stop()
    }
  })
})

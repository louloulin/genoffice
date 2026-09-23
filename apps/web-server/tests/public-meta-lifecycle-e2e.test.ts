/**
 * Public read-only endpoints lifecycle (no auth required).
 *
 * Pins the wire contract for endpoints that §2.1.A lists as "公开" —
 * `GET /api/v1/health`, `GET /api/v1/metrics`, `GET /api/v1/changelog`,
 * `GET /api/v1/meta`. None of these should require a JWT and all
 * should return JSON content-type (metrics is `text/plain; version=0.0.4`
 * which is the Prometheus exposition format — locked contract).
 *
 * No new bug here, this is a coverage pin so future refactors don't
 * accidentally turn a public endpoint into a JWT-gated one or vice-versa.
 */
import { describe, expect, it } from 'vitest'
import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { ServerHarness } from './helpers/v1-smoke'

const pkgRoot = join(import.meta.dirname, '..')
const bundle = join(pkgRoot, 'dist', 'bundle', 'index.js')
const skip = !existsSync(bundle)

describe.skipIf(skip)('v1 public read-only endpoints (no auth)', () => {
  it('serves health / meta / changelog / metrics with correct content-type and shape', async () => {
    const h = await ServerHarness.start()

    try {
      // ── 1. /api/v1/health ────────────────────────────────────────────────
      {
        const r = await h.req<{ status: string; apiVersion: string; implementedChannels: number }>('/api/v1/health')
        expect(r.status).toBe(200)
        expect(r.headers.get('content-type')).toMatch(/application\/json/)
        expect(r.body.status).toBe('ok')
        expect(r.body.apiVersion).toBe('v1')
        expect(typeof r.body.implementedChannels).toBe('number')
        expect(r.body.implementedChannels).toBeGreaterThan(0)
      }

      // ── 2. /api/v1/meta ──────────────────────────────────────────────────
      {
        const r = await h.req<{ apiVersion: string; serverVersion: string; capabilities: string[]; sdk: { instances: number } }>('/api/v1/meta')
        expect(r.status).toBe(200)
        expect(r.headers.get('content-type')).toMatch(/application\/json/)
        expect(r.body.apiVersion).toBe('v1')
        expect(typeof r.body.serverVersion).toBe('string')
        expect(Array.isArray(r.body.capabilities)).toBe(true)
        expect(r.body.capabilities).toContain('docs')
        expect(r.body.capabilities).toContain('sheets')
        expect(r.body.capabilities).toContain('slides')
      }

      // ── 3. /api/v1/changelog ─────────────────────────────────────────────
      {
        const r = await h.req<{ format: string; content: string }>('/api/v1/changelog')
        expect(r.status).toBe(200)
        expect(r.headers.get('content-type')).toMatch(/application\/json/)
        // changelog returns `{ format: 'markdown', content: '<markdown>' }`
        // — the raw CHANGELOG.md body, not a parsed structure. Hosts parse
        // it themselves with whatever markdown tool they prefer.
        expect(r.body.format).toBe('markdown')
        expect(typeof r.body.content).toBe('string')
        expect(r.body.content.length).toBeGreaterThan(0)
        expect(r.body.content).toMatch(/^# Changelog/)
      }

      // ── 4. /api/v1/metrics ───────────────────────────────────────────────
      {
        const r = await h.req('/api/v1/metrics')
        expect(r.status).toBe(200)
        // Prometheus exposition format is text/plain; version=0.0.4 per
        // the spec. The dispatcher must NOT return JSON for this endpoint.
        expect(r.headers.get('content-type')).toMatch(/text\/plain/)
        // Prometheus exposition format starts with `# HELP` comments.
        expect(r.text.startsWith('# HELP')).toBe(true)
        expect(r.text).toMatch(/genoffice_dlq_size \d+/)
      }

      // ── 5. Same endpoints accept auth (idempotent) ───────────────────────
      {
        const token = await h.token('public-meta-tester', ['admin'])
        const r = await h.req<{ status: string }>('/api/v1/health', { token })
        expect(r.status).toBe(200)
        expect(r.body.status).toBe('ok')
      }
    } finally {
      await h.stop()
    }
  }, 30_000)
})

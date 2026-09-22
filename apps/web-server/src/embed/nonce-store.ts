/**
 * In-memory nonce ↔ session binding for the iframe Embed handshake.
 *
 * Background (sdk1.md §11.20 + §B.2 #1):
 *   - The host SDK generates a random 128-bit base64 nonce, embeds it in the
 *     iframe URL (`?nonce=...`), and waits for the iframe's `ready` event to
 *     echo the same nonce. This proves the iframe is the one the host opened
 *     (not a stale or attacker-controlled iframe on the same origin).
 *
 *   - The protection is purely client-side: an attacker who controls the
 *     SDK could patch the check away. To make it harder, the *server* also
 *     keeps a nonce ↔ sessionId binding so an integrator can ask "did the
 *     server know this nonce when the iframe loaded?" — if the answer is
 *     no, the iframe is suspicious even if the postMessage payload matched.
 *
 * Threat model addressed by this module:
 *   - Attacker tampers with the SDK's client-side nonce verification (or
 *     replaces the SDK entirely with their own JS).
 *   - Attacker routes the iframe through a proxy that rewrites `?nonce=`
 *     but keeps the iframe otherwise intact.
 *
 * Threat model NOT addressed (out of scope):
 *   - Token theft (handled by `/api/v1/files/:id/jwt` single-use +
 *     `verifyJwtWithRevocation`).
 *   - Server compromise (this is process-local memory; on restart all
 *     sessions are forgotten and the host SDK will see `valid: false`).
 *
 * LRU cap: 1024 entries; older entries are evicted when the cap is hit. A
 * tiny clock-driven sweeper removes expired entries every `SWEEP_MS` ms
 * (started lazily on first mint; tests can call `stopEmbedNonceSweeper()`
 * to silence it during teardown).
 *
 * The store is deliberately process-local. It is NOT a Redis/MySQL-backed
 * session store because:
 *   - The SDK host and the iframe live in the same browser origin; the
 *     server-side check is a defense-in-depth audit, not a source of truth.
 *   - Replication across web-server processes would require a shared cache
 *     (Redis), which is out of scope for the standalone / Docker build.
 */
import { randomBytes } from 'node:crypto'

export interface NonceSession {
  sessionId: string
  nonce: string
  docId: string
  /** epoch milliseconds */
  expiresAt: number
  /** epoch milliseconds — used for LRU eviction */
  mintedAt: number
}

const SESSIONS = new Map<string, NonceSession>()
const MAX_SESSIONS = 1024
const DEFAULT_TTL_MS = 5 * 60 * 1000 // 5 min — enough for the host SDK to mint → iframe → ready handshake
const SWEEP_MS = 30 * 1000

let sweepTimer: NodeJS.Timeout | null = null
function ensureSweeper(): void {
  if (sweepTimer || typeof setInterval !== 'function') return
  sweepTimer = setInterval(() => {
    const now = Date.now()
    for (const [id, entry] of SESSIONS) {
      if (entry.expiresAt <= now) SESSIONS.delete(id)
    }
  }, SWEEP_MS)
  // Sweeper is a background hygiene task; never block process exit.
  if (typeof sweepTimer.unref === 'function') sweepTimer.unref()
}

/** Visible for tests. */
export function stopEmbedNonceSweeper(): void {
  if (sweepTimer) {
    clearInterval(sweepTimer)
    sweepTimer = null
  }
}

/** Visible for tests — wipes the store + stops the timer. */
export function _resetEmbedNonceStore(): void {
  SESSIONS.clear()
  stopEmbedNonceSweeper()
}

/**
 * Mint a new (sessionId, nonce) pair bound to `docId`.
 *
 * The nonce is 16 random bytes encoded as URL-safe base64 (22 chars).
 * The sessionId is the same — both are 128-bit random, kept identical so
 * the host SDK doesn't need to track two strings; the server treats
 * `sessionId` as the lookup key and `nonce` as the value.
 *
 * Returns `null` only if the parameters are unusable (empty docId /
 * non-positive ttl); never throws.
 */
export function mintEmbedNonce(docId: string, ttlMs: number = DEFAULT_TTL_MS): NonceSession | null {
  if (!docId || typeof docId !== 'string') return null
  if (!Number.isFinite(ttlMs) || ttlMs <= 0) return null
  ensureSweeper()
  const id = randomBytes(16).toString('base64').replace(/=+$/, '').replace(/\+/g, '-').replace(/\//g, '_')
  const now = Date.now()
  // LRU: when at cap, drop the oldest minted entry to make room.
  if (SESSIONS.size >= MAX_SESSIONS) {
    let oldestId: string | null = null
    let oldestAt = Infinity
    for (const [key, entry] of SESSIONS) {
      if (entry.mintedAt < oldestAt) {
        oldestAt = entry.mintedAt
        oldestId = key
      }
    }
    if (oldestId !== null) SESSIONS.delete(oldestId)
  }
  const entry: NonceSession = {
    sessionId: id,
    nonce: id,
    docId,
    mintedAt: now,
    expiresAt: now + ttlMs,
  }
  SESSIONS.set(id, entry)
  return entry
}

/**
 * Look up a previously-minted nonce.
 *
 * Returns `{ found: true, session }` when the session exists and is not
 * expired; `{ found: false, reason: 'unknown' | 'expired' }` otherwise.
 *
 * Verifying is intentionally decoupled from minting: the host SDK can
 * ping `/api/v1/embed/verify-nonce` to learn whether the iframe the SDK
 * is talking to came from a server-minted session — without exposing
 * which specific sessionId the SDK minted (the request body carries
 * both, so this is a cooperative check).
 */
export function verifyEmbedNonce(
  sessionId: string,
  nonce: string,
): { found: true; session: NonceSession } | { found: false; reason: 'unknown' | 'expired' } {
  if (!sessionId || !nonce) return { found: false, reason: 'unknown' }
  const entry = SESSIONS.get(sessionId)
  if (!entry) return { found: false, reason: 'unknown' }
  if (entry.expiresAt <= Date.now()) {
    SESSIONS.delete(sessionId)
    return { found: false, reason: 'expired' }
  }
  if (entry.nonce !== nonce) return { found: false, reason: 'unknown' }
  return { found: true, session: entry }
}

/**
 * Visible for tests — count of currently-live entries (post-sweep).
 */
export function _embedNonceStoreSize(): number {
  return SESSIONS.size
}

/**
 * Forcefully remove a session from the store. Returns true if the
 * session existed and was removed; false if it was already gone
 * (unknown id or already evicted by LRU / TTL sweeper).
 *
 * Use this when the host SDK tears down the iframe — frees up the
 * LRU slot eagerly instead of waiting for TTL. The client side is
 * allowed to call this on a sessionId it minted itself; we don't
 * authenticate the call (same as `/api/v1/embed/verify-nonce`) because
 * the caller is the entity that received the sessionId from this
 * very process.
 */
export function removeEmbedNonce(sessionId: string): boolean {
  if (!sessionId) return false
  return SESSIONS.delete(sessionId)
}

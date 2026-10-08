/// Token comparison shared by the UI host and the embed wrapper. The candidate
/// is attacker-controlled, so the compare must be constant-time; digesting both
/// sides first keeps `timingSafeEqual` from throwing on a length mismatch (which
/// would itself leak the secret's length through timing).
import { createHash, timingSafeEqual } from 'node:crypto'
import type { IncomingMessage } from 'node:http'

export function tokenMatches(candidate: string, token: string): boolean {
  if (candidate.length === 0) return false
  const a = createHash('sha256').update(candidate).digest()
  const b = createHash('sha256').update(token).digest()
  return timingSafeEqual(a, b)
}

/** Bearer header, `?token=`, or `x-genoffice-token` — any one satisfies the gate. */
export function isAuthorizedRequest(
  url: URL,
  headers: IncomingMessage['headers'],
  token: string,
): boolean {
  const bearer = headers.authorization
  if (typeof bearer === 'string' && bearer.startsWith('Bearer ') && tokenMatches(bearer.slice(7), token)) {
    return true
  }
  const query = url.searchParams.get('token')
  if (query !== null && tokenMatches(query, token)) return true
  const headerToken = headers['x-genoffice-token']
  if (typeof headerToken === 'string' && tokenMatches(headerToken, token)) return true
  return false
}

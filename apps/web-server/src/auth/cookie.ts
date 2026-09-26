/**
 * WEB_TOKEN → Set-Cookie shim.
 *
 * In `WEB_TOKEN` auth mode the iframe runs same-origin and its /api/ipc/*
 * calls must carry the token — but the bridge cannot stamp custom headers
 * on EventSource / fetch from inside the editor. Setting the cookie on the
 * wrapper HTML makes the browser auto-attach it to every same-origin
 * request.
 *
 * Lives in its own module (no imports from `../index` or `../embed`) so the
 * two entry points can each pull this helper without creating a circular
 * import. The auth gate in `src/index.ts:hasAuthorizationHeader` reverses
 * the percent-encoding with decodeURIComponent before comparing.
 *
 * Cookie attributes:
 *   - Path=/          every IPC call (mounted under /api/ipc/…) sees it
 *   - HttpOnly        document.cookie cannot read it — XSS in the iframe
 *                     can't exfiltrate the secret
 *   - SameSite=Strict the cookie never rides cross-site requests
 *   - Max-Age=604800  one week so long editor sessions don't lose auth
 */
export function authCookieHeader(): string | null {
  const token = process.env.WEB_TOKEN
  if (!token) return null
  return `auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`
}
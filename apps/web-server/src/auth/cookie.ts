/**
 * Credential → Set-Cookie shim for the HTML responses that mount an editor.
 *
 * In `WEB_TOKEN` auth mode the iframe runs same-origin and its /api/ipc/*
 * calls must carry a credential — but the bridge cannot stamp custom headers
 * on EventSource / fetch from inside the editor. Setting the cookie on the
 * wrapper HTML makes the browser auto-attach it to every same-origin
 * request.
 *
 * `token` is an **explicit parameter, never read from the environment**. That
 * is deliberate and load-bearing: the previous signature pulled `WEB_TOKEN`
 * itself, so every call site silently stamped the operator secret regardless
 * of whether the caller had presented anything. A caller could fetch
 * `/embed/<id>?token=anything` and walk away with an operator credential in
 * its `Set-Cookie`. Requiring the caller to name the credential makes that
 * class of mistake unrepresentable — the value handed out is always the one
 * the caller just authenticated against.
 *
 * Callers must therefore decide the credential *before* calling, and must not
 * call at all when the caller presented nothing valid (see the guards in
 * `src/index.ts` and `src/embed/index.ts`).
 *
 * Lives in its own module (no imports from `../index` or `../embed`) so the
 * two entry points can each pull this helper without creating a circular
 * import. The auth gate in `src/auth/index.ts:readToken` reverses the
 * percent-encoding with decodeURIComponent before comparing.
 *
 * Cookie attributes:
 *   - Path=/          every IPC call (mounted under /api/ipc/…) sees it
 *   - HttpOnly        document.cookie cannot read it — XSS in the iframe
 *                     can't exfiltrate the secret
 *   - SameSite=Strict the cookie never rides cross-site requests
 *   - Max-Age=604800  one week so long editor sessions don't lose auth
 */
export function authCookieHeader(token: string): string | null {
  if (!token) return null
  return `auth_token=${encodeURIComponent(token)}; Path=/; HttpOnly; SameSite=Strict; Max-Age=604800`
}
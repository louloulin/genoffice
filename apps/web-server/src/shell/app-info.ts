/**
 * Shell app info channels — language, version, platform, theme. These
 * mirror `apps/shell/src/main/index.ts` semantics for the standalone web
 * server build.
 */
import { registerHandle, READ_PREF_SCOPE } from '../common/index'
import { WEB_SERVER_VERSION } from '../common/version'

export function registerAppInfoHandlers(): void {
  // The read side carries `soft:preferences:read` so a JWT caller reaches it
  // by presenting that scope. An unscoped channel is NOT the same thing as an
  // open one here: jwtScopeFor() reads a missing declaration as "no JWT may use
  // this at all" and answers 403, so leaving the reads bare made language and
  // theme unreachable from the embed — the one place that runs as a scoped
  // guest. Mirrors the `soft:preferences:write` the setters already declare.
  registerHandle('app:get-language', () => 'zh', { scope: READ_PREF_SCOPE })
  registerHandle('app:get-version', () => WEB_SERVER_VERSION, { scope: READ_PREF_SCOPE })
  registerHandle('app:get-platform', () => 'web', { scope: READ_PREF_SCOPE })
  registerHandle('app:get-theme', () => 'light', { scope: READ_PREF_SCOPE })
}

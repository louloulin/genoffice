/**
 * Single source of truth for the web-server version string.
 *
 * Before §11.23 the value was hardcoded in five separate files:
 *   - apps/web-server/src/index.ts (boot banner + IPC status)
 *   - apps/web-server/src/shell/app-info.ts (app:get-version handler)
 *   - apps/web-server/src/shell/skills.ts (skill default version)
 *   - apps/web-server/src/embed/index.ts (EMBED_BRIDGE ready payload)
 *
 * Hardcoded literals drift over time — when this server eventually
 * ships 0.9.0 we shouldn't have to grep five files. The source string
 * lives here and every consumer imports it.
 *
 * The string is kept simple on purpose: major.minor.patch, no prerelease
 * tags, no git SHA. Downstream consumers (e.g. `/api/v1/health`) can
 * add metadata without affecting this contract.
 */
export const WEB_SERVER_VERSION = '0.8.0'

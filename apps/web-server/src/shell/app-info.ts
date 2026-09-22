/**
 * Shell app info channels — language, version, platform, theme. These
 * mirror `apps/shell/src/main/index.ts` semantics for the standalone web
 * server build.
 */
import { registerHandle } from '../common/index'
import { WEB_SERVER_VERSION } from '../common/version'

export function registerAppInfoHandlers(): void {
  registerHandle('app:get-language', () => 'zh')
  registerHandle('app:get-version', () => WEB_SERVER_VERSION)
  registerHandle('app:get-platform', () => 'web')
  registerHandle('app:get-theme', () => 'light')
}

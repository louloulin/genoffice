/**
 * Slides (pptx) module entry — wires every slides sub-domain into the host's
 * registry. Handlers are split across `core` (lifecycle), `elements`
 * (mutations), `state` (queries), `master` (master-view) and `files`
 * (file pickers).
 *
 * Every sub-module takes `(registry, state)` — and `core`/`files` also take
 * `workspace` — so two `startUiHost()` instances in one process get entirely
 * separate slide sessions, clipboards and staged files. (web-server keeps this
 * state in module-level singletons; a library that can be mounted more than
 * once cannot.)
 */
import type { Registry } from '../../registry'
import type { Workspace } from '../../workspace'
import { registerSlidesCoreHandlers } from './core'
import { registerSlidesElementHandlers } from './elements'
import { registerSlidesFileHandlers } from './files'
import { registerSlidesMasterHandlers } from './master'
import { createSlidesState, registerSlidesStateHandlers, type SlidesState } from './state'

export { createSlidesState, type SlidesState } from './state'
export { STUBBED_SLIDES_CHANNELS } from './elements'

export function registerSlidesHandlers(
  registry: Registry,
  workspace: Workspace,
  state: SlidesState,
): SlidesState {
  registerSlidesCoreHandlers(registry, workspace, state)
  registerSlidesElementHandlers(registry, state)
  registerSlidesStateHandlers(registry, state)
  registerSlidesMasterHandlers(registry, state)
  registerSlidesFileHandlers(registry, workspace)
  return state
}
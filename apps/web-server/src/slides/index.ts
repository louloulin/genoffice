/**
 * slides/* — Public entry point for the slides capability.
 *
 * Aggregates real handlers (real.ts) and three batches of placeholder
 * stubs (stubs-{a,b,c}.ts). The placeholder handlers are kept verbatim
 * from the original monolith — Phase 1.2 / 1.3 sub-issues will tighten
 * them.
 */

import { registerSlidesRealHandlers } from './real.js'
import { registerSlidesStubsA } from './stubs-a.js'
import { registerSlidesStubsB } from './stubs-b.js'
import { registerSlidesStubsC } from './stubs-c.js'

export function registerSlidesHandlers(): void {
  registerSlidesRealHandlers()
  registerSlidesStubsA()
  registerSlidesStubsB()
  registerSlidesStubsC()
}

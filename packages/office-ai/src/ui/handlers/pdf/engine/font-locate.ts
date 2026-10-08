/**
 * Copied from `apps/pdf/src/main/font-locate.ts`.
 *
 * System font location moved to @genoffice/font-metrics (shared with the docs
 * metrics pipeline); re-exported here to keep the engine's import paths stable.
 * The workspace package resolves through tsconfig `paths` and is bundled —
 * deliberately not a runtime `dependencies` entry.
 */
export { findFontCovering, findSystemFont, isTruetype } from '@genoffice/font-metrics'
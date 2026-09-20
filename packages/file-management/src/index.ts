/**
 * `@genoffice/file-management` — the shared file-lifecycle kernel.
 *
 * The web-server and the desktop build both need the same answers to the same
 * questions: how do I save without risking the user's file, where do recents
 * live so they survive a restart, how do I delete something recoverably, and
 * what does "create a document" actually mean for a given format. This package
 * holds those answers so the two builds cannot drift apart.
 *
 * Layering (see `docs/webserver-file-management.md`):
 *   • this package is the kernel;
 *   • `apps/web-server/src/common/file-index-store.ts` and friends are
 *     web-server-specific persistence on top of it;
 *   • the IPC handlers are thin adapters that parse args and format results.
 */
export { atomicWriteFile, atomicWriteJson } from './atomic'

export { UnifiedRecents } from './recents'
export type { RecentEntry, RecentsOptions } from './recents'

export { Trash } from './trash'
export type { TrashEntry } from './trash'

export { SaveLocations } from './save-locations'
export type { SaveLocation } from './save-locations'

export { searchFiles, fileProperties, sha256File, scoreMatch } from './properties'
export type { SearchHit, FileProperties } from './properties'

export {
  generatePreview,
  setImageResizer,
  defaultImageGenerator,
  clearPreviewCache,
  previewCacheSize,
} from './preview'
export type { PreviewResult, ImageResizer } from './preview'

export {
  BaseDocumentStore,
  DocsStore,
  MarkdownStore,
  HtmlStore,
  createDocumentStores,
  ensureExtension,
  looksLikePdf,
  looksLikeText,
  looksLikeZip,
  safeName,
} from './document-store'
export type {
  CreateOptions,
  CreatedDocument,
  DocumentMeta,
  DocumentStore,
  DocumentStoreHost,
  SaveResult,
} from './document-store'

export { VersionHistory } from './version-history'
export type { VersionEntry } from './version-history'

export { Mutex, runExclusive } from './mutex'

/**
 * Public surface of the shared `common` module.
 *
 * Each capability directory imports the bits it needs from here so the
 * split stays a pure refactor (no behaviour change, no handler lost).
 */
export { BYTES_TAG, encodeTransportValue, decodeTransportValue } from './codec'
export { randomFileId, atomicWriteJson, reserveDailyPasteQuota, DAILY_PASTE_LIMIT_BYTES, sweepWebTempRoot } from './atomic'
export { readBlankTemplate, writeBlankOfficeFile } from './blank-templates'
export type { TypedArrayTag } from './codec'

export { registerHandle, getHandler, listChannels, handlerCount } from './registry'
export type { IpcHandler } from './registry'

export {
  DATA_DIR,
  FILES_DIR,
  PROJECTS_FILE,
  loadProjects,
  saveProjects,
  FILES_INDEX,
  DOCS_RECENT_FILE,
  loadRecentDocs,
  saveRecentDocs,
  DOCS_RECENT,
  DOCS_STARRED,
  DOCS_STARRED_FILE,
  loadStarredDocs,
  saveStarredDocs,
  initRecentState,
  SHEETS_RECENT_FILE,
  loadRecentSheets,
  saveRecentSheets,
  SLIDES_RECENT_FILE,
  loadRecentSlides,
  saveRecentSlides,
  COLLAB_SESSIONS,
  PRESENCE,
  DOC_PERMISSIONS,
  DOC_VERSIONS,
  DOC_COMMENTS,
  TEMPLATES,
  initDefaultTemplates,
  OFFLINE_QUEUE,
  SEARCH_INDEX,
  USERS,
  PERMISSIONS,
  TENANTS,
  MAILS,
  CALENDARS,
  WORKFLOWS,
  NOTIFICATIONS,
  WEB_WINDOWS,
  TABS,
} from './state'
export type {
  Project,
  FileInfo,
  DocInfo,
  SheetInfo,
  SlideInfo,
  DocVersion,
  DocVersionHistory,
  DocComment,
  CommentReply,
  DocTemplate,
  UserRecord,
  TenantRecord,
  MailRecord,
  CalendarEventRecord,
  WorkflowRecord,
  NotificationRecord,
  TabRecord,
} from './state'

export { MIME_TYPES } from './mime'
export {
  ROOT,
  PORT,
  HOST,
  APPS,
  STATIC_ROOT,
  WEB_TEMP_ROOT,
  isWithin,
  isManagedPath,
  requireManagedPath,
  PATH_OUTSIDE_STORAGE,
  sanitizeFileName,
  WINDOWS_RESERVED,
} from './paths'

export { fileIndexStore, FILES_INDEX_FILE } from './file-index-store'
export { recordRecentDoc } from './document-stores'
export { readStorageOrManagedBytes } from './storage-read'
export { storageKeyFromPath, isRemoteStorage } from './state'
// Audit log (sdk1.md §M5 backlog) — disk-backed JSONL with bounded
// in-memory mirror. Replaces the previous process-local Map.
export {
  recordAudit,
  queryAudit,
  auditSize,
  snapshotAuditLog,
  exportAudit,
  _resetAuditForTests as _resetAuditLogForTests,
} from './audit-log'
export type { AuditRecord, RecordAuditInput, QueryAuditFilters, ExportAuditFilters } from './audit-log'


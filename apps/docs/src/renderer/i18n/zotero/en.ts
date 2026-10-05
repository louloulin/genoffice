import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const en = {
  zoteroCitation: 'Zotero Citation',
  zoteroCitationTip: 'Add a citation with Zotero; place the cursor in a citation to edit it',
  zoteroBibliography: 'Zotero Bibliography',
  zoteroBibliographyTip: 'Add or edit the bibliography with Zotero',
  zoteroRefresh: 'Refresh',
  zoteroRefreshTip: 'Refresh all Zotero citations and bibliographies',
  zoteroDocumentSettings: 'Document Settings',
  zoteroDocumentSettingsTip: 'Zotero document settings',
  zoteroDocumentPreferences: 'Document Preferences',
  zoteroRemoveCodes: 'Remove Field Codes',
  zoteroConnectionError: 'Unable to connect to Zotero. Start Zotero and keep it running.',
  zoteroOperationError: 'The Zotero operation failed.',
  zoteroNoteFieldsUnsupported:
    'This document has Zotero citations in footnotes or endnotes, which GenOffice cannot update yet. Zotero commands are turned off here so the bibliography stays intact.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

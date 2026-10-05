import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const ms = {
  zoteroCitation: 'Petikan Zotero',
  zoteroCitationTip:
    'Tambah petikan dengan Zotero; letakkan kursor dalam petikan untuk mengeditnya',
  zoteroBibliography: 'Bibliografi Zotero',
  zoteroBibliographyTip: 'Tambah atau edit bibliografi dengan Zotero',
  zoteroRefresh: 'Segar semula',
  zoteroRefreshTip: 'Segar semula semua petikan dan bibliografi Zotero',
  zoteroDocumentSettings: 'Tetapan Dokumen',
  zoteroDocumentSettingsTip: 'Tetapan dokumen Zotero',
  zoteroDocumentPreferences: 'Keutamaan Dokumen',
  zoteroRemoveCodes: 'Buang Kod Medan',
  zoteroConnectionError:
    'Tidak dapat menyambung ke Zotero. Mulakan Zotero dan biarkannya terbuka.',
  zoteroOperationError: 'Operasi Zotero gagal.',
  zoteroNoteFieldsUnsupported:
    'Dokumen ini mempunyai petikan Zotero dalam nota kaki atau nota hujung yang belum boleh dikemas kini oleh GenOffice. Perintah Zotero dimatikan di sini supaya bibliografi kekal utuh.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

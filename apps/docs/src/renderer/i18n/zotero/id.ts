import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const id = {
  zoteroCitation: 'Kutipan Zotero',
  zoteroCitationTip:
    'Tambahkan kutipan dengan Zotero; letakkan kursor di kutipan untuk mengeditnya',
  zoteroBibliography: 'Bibliografi Zotero',
  zoteroBibliographyTip: 'Tambahkan atau edit bibliografi dengan Zotero',
  zoteroRefresh: 'Segarkan',
  zoteroRefreshTip: 'Segarkan semua kutipan dan bibliografi Zotero',
  zoteroDocumentSettings: 'Pengaturan Dokumen',
  zoteroDocumentSettingsTip: 'Pengaturan dokumen Zotero',
  zoteroDocumentPreferences: 'Preferensi Dokumen',
  zoteroRemoveCodes: 'Hapus Kode Bidang',
  zoteroConnectionError:
    'Tidak dapat terhubung ke Zotero. Jalankan Zotero dan biarkan tetap terbuka.',
  zoteroOperationError: 'Operasi Zotero gagal.',
  zoteroNoteFieldsUnsupported:
    'Dokumen ini memiliki sitasi Zotero di catatan kaki atau catatan akhir yang belum dapat diperbarui GenOffice. Perintah Zotero dinonaktifkan di sini agar daftar pustaka tetap utuh.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

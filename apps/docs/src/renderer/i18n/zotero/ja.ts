import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const ja = {
  zoteroCitation: 'Zotero 引用',
  zoteroCitationTip: 'Zotero で引用を追加します。既存の引用内にカーソルを置くと編集できます',
  zoteroBibliography: 'Zotero 文献目録',
  zoteroBibliographyTip: 'Zotero で文献目録を追加または編集します',
  zoteroRefresh: '更新',
  zoteroRefreshTip: 'すべての Zotero 引用と文献目録を更新します',
  zoteroDocumentSettings: '文書設定',
  zoteroDocumentSettingsTip: 'Zotero 文書設定',
  zoteroDocumentPreferences: '文書の環境設定',
  zoteroRemoveCodes: 'フィールドコードを削除',
  zoteroConnectionError: 'Zotero に接続できません。Zotero を起動したままにしてください。',
  zoteroOperationError: 'Zotero の操作に失敗しました。',
  zoteroNoteFieldsUnsupported:
    'この文書の脚注または文末脚注に Zotero の引用が含まれていますが、GenOffice はまだ更新できません。参考文献一覧を保つため、この文書では Zotero コマンドを無効にしています。',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

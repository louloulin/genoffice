import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const zhTW = {
  zoteroCitation: 'Zotero 引文',
  zoteroCitationTip: '使用 Zotero 新增引文；游標位於現有引文中時可編輯',
  zoteroBibliography: 'Zotero 參考文獻',
  zoteroBibliographyTip: '使用 Zotero 新增或編輯參考文獻',
  zoteroRefresh: '重新整理',
  zoteroRefreshTip: '重新整理所有 Zotero 引文和參考文獻',
  zoteroDocumentSettings: '文件設定',
  zoteroDocumentSettingsTip: 'Zotero 文件設定',
  zoteroDocumentPreferences: '文件偏好設定',
  zoteroRemoveCodes: '移除欄位代碼',
  zoteroConnectionError: '無法連線至 Zotero。請先啟動 Zotero，並保持桌面程式執行。',
  zoteroOperationError: 'Zotero 操作失敗。',
  zoteroNoteFieldsUnsupported:
    '此文件的註腳或章節附註中含有 Zotero 引文，GenOffice 目前還無法更新它們。為保持參考文獻完整，已停用此文件的 Zotero 命令。',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

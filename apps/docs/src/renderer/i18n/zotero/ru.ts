import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const ru = {
  zoteroCitation: 'Цитата Zotero',
  zoteroCitationTip: 'Добавить цитату через Zotero; для изменения поместите курсор внутрь цитаты',
  zoteroBibliography: 'Библиография Zotero',
  zoteroBibliographyTip: 'Добавить или изменить библиографию через Zotero',
  zoteroRefresh: 'Обновить',
  zoteroRefreshTip: 'Обновить все цитаты и библиографии Zotero',
  zoteroDocumentSettings: 'Параметры документа',
  zoteroDocumentSettingsTip: 'Параметры документа Zotero',
  zoteroDocumentPreferences: 'Настройки документа',
  zoteroRemoveCodes: 'Удалить коды полей',
  zoteroConnectionError:
    'Не удалось подключиться к Zotero. Запустите Zotero и оставьте его открытым.',
  zoteroOperationError: 'Операция Zotero завершилась с ошибкой.',
  zoteroNoteFieldsUnsupported:
    'В сносках или концевых сносках этого документа есть цитаты Zotero, которые GenOffice пока не может обновлять. Команды Zotero здесь отключены, чтобы библиография осталась целой.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

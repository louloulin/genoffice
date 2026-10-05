import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const pl = {
  zoteroCitation: 'Cytowanie Zotero',
  zoteroCitationTip: 'Dodaj cytowanie przez Zotero; umieść kursor w cytowaniu, aby je edytować',
  zoteroBibliography: 'Bibliografia Zotero',
  zoteroBibliographyTip: 'Dodaj lub edytuj bibliografię przez Zotero',
  zoteroRefresh: 'Odśwież',
  zoteroRefreshTip: 'Odśwież wszystkie cytowania i bibliografie Zotero',
  zoteroDocumentSettings: 'Ustawienia dokumentu',
  zoteroDocumentSettingsTip: 'Ustawienia dokumentu Zotero',
  zoteroDocumentPreferences: 'Preferencje dokumentu',
  zoteroRemoveCodes: 'Usuń kody pól',
  zoteroConnectionError: 'Nie można połączyć się z Zotero. Uruchom Zotero i pozostaw je otwarte.',
  zoteroOperationError: 'Operacja Zotero nie powiodła się.',
  zoteroNoteFieldsUnsupported:
    'Ten dokument zawiera cytowania Zotero w przypisach dolnych lub końcowych, których GenOffice nie potrafi jeszcze aktualizować. Polecenia Zotero są tu wyłączone, aby bibliografia pozostała nienaruszona.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

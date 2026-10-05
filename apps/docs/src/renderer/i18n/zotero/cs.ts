import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const cs = {
  zoteroCitation: 'Citace Zotero',
  zoteroCitationTip: 'Přidat citaci pomocí Zotera; pro úpravu umístěte kurzor do citace',
  zoteroBibliography: 'Bibliografie Zotero',
  zoteroBibliographyTip: 'Přidat nebo upravit bibliografii pomocí Zotera',
  zoteroRefresh: 'Aktualizovat',
  zoteroRefreshTip: 'Aktualizovat všechny citace a bibliografie Zotero',
  zoteroDocumentSettings: 'Nastavení dokumentu',
  zoteroDocumentSettingsTip: 'Nastavení dokumentu Zotero',
  zoteroDocumentPreferences: 'Předvolby dokumentu',
  zoteroRemoveCodes: 'Odebrat kódy polí',
  zoteroConnectionError: 'K Zoteru se nelze připojit. Spusťte Zotero a nechte je otevřené.',
  zoteroOperationError: 'Operace Zotero se nezdařila.',
  zoteroNoteFieldsUnsupported:
    'Tento dokument obsahuje citace Zotero v poznámkách pod čarou nebo vysvětlivkách, které GenOffice zatím neumí aktualizovat. Příkazy Zotero jsou zde vypnuté, aby bibliografie zůstala nedotčená.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

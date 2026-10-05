import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const nl = {
  zoteroCitation: 'Zotero-citatie',
  zoteroCitationTip:
    'Voeg een citatie toe met Zotero; plaats de cursor in een citatie om die te bewerken',
  zoteroBibliography: 'Zotero-bibliografie',
  zoteroBibliographyTip: 'Voeg de bibliografie toe of bewerk deze met Zotero',
  zoteroRefresh: 'Vernieuwen',
  zoteroRefreshTip: 'Vernieuw alle Zotero-citaties en bibliografieën',
  zoteroDocumentSettings: 'Documentinstellingen',
  zoteroDocumentSettingsTip: 'Zotero-documentinstellingen',
  zoteroDocumentPreferences: 'Documentvoorkeuren',
  zoteroRemoveCodes: 'Veldcodes verwijderen',
  zoteroConnectionError:
    'Kan geen verbinding maken met Zotero. Start Zotero en laat het geopend.',
  zoteroOperationError: 'De Zotero-bewerking is mislukt.',
  zoteroNoteFieldsUnsupported:
    'Dit document bevat Zotero-citaties in voet- of eindnoten die GenOffice nog niet kan bijwerken. Zotero-opdrachten zijn hier uitgeschakeld zodat de bibliografie intact blijft.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

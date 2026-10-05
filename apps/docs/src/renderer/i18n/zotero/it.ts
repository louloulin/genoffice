import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const it = {
  zoteroCitation: 'Citazione Zotero',
  zoteroCitationTip:
    'Aggiungi una citazione con Zotero; posiziona il cursore in una citazione per modificarla',
  zoteroBibliography: 'Bibliografia Zotero',
  zoteroBibliographyTip: 'Aggiungi o modifica la bibliografia con Zotero',
  zoteroRefresh: 'Aggiorna',
  zoteroRefreshTip: 'Aggiorna tutte le citazioni e bibliografie Zotero',
  zoteroDocumentSettings: 'Impostazioni documento',
  zoteroDocumentSettingsTip: 'Impostazioni del documento Zotero',
  zoteroDocumentPreferences: 'Preferenze documento',
  zoteroRemoveCodes: 'Rimuovi codici di campo',
  zoteroConnectionError: 'Impossibile connettersi a Zotero. Avvia Zotero e lascialo aperto.',
  zoteroOperationError: "L'operazione Zotero non è riuscita.",
  zoteroNoteFieldsUnsupported:
    'Questo documento contiene citazioni Zotero nelle note a piè di pagina o di chiusura, che GenOffice non può ancora aggiornare. I comandi Zotero sono disattivati qui per mantenere intatta la bibliografia.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

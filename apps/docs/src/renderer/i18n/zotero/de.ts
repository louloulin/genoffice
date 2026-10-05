import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const de = {
  zoteroCitation: 'Zotero-Zitat',
  zoteroCitationTip: 'Zitat mit Zotero einfügen; zum Bearbeiten den Cursor in ein Zitat setzen',
  zoteroBibliography: 'Zotero-Literaturverzeichnis',
  zoteroBibliographyTip: 'Literaturverzeichnis mit Zotero einfügen oder bearbeiten',
  zoteroRefresh: 'Aktualisieren',
  zoteroRefreshTip: 'Alle Zotero-Zitate und Literaturverzeichnisse aktualisieren',
  zoteroDocumentSettings: 'Dokumenteinstellungen',
  zoteroDocumentSettingsTip: 'Zotero-Dokumenteinstellungen',
  zoteroDocumentPreferences: 'Dokumenteinstellungen',
  zoteroRemoveCodes: 'Feldcodes entfernen',
  zoteroConnectionError:
    'Verbindung mit Zotero nicht möglich. Starten Sie Zotero und lassen Sie es geöffnet.',
  zoteroOperationError: 'Der Zotero-Vorgang ist fehlgeschlagen.',
  zoteroNoteFieldsUnsupported:
    'Dieses Dokument enthält Zotero-Zitate in Fuß- oder Endnoten, die GenOffice noch nicht aktualisieren kann. Die Zotero-Befehle sind hier deaktiviert, damit das Literaturverzeichnis intakt bleibt.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

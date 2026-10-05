import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const fr = {
  zoteroCitation: 'Citation Zotero',
  zoteroCitationTip:
    'Ajouter une citation avec Zotero ; placer le curseur dedans pour la modifier',
  zoteroBibliography: 'Bibliographie Zotero',
  zoteroBibliographyTip: 'Ajouter ou modifier la bibliographie avec Zotero',
  zoteroRefresh: 'Actualiser',
  zoteroRefreshTip: 'Actualiser toutes les citations et bibliographies Zotero',
  zoteroDocumentSettings: 'Paramètres du document',
  zoteroDocumentSettingsTip: 'Paramètres du document Zotero',
  zoteroDocumentPreferences: 'Préférences du document',
  zoteroRemoveCodes: 'Supprimer les codes de champ',
  zoteroConnectionError:
    'Impossible de se connecter à Zotero. Démarrez Zotero et laissez-le ouvert.',
  zoteroOperationError: "L'opération Zotero a échoué.",
  zoteroNoteFieldsUnsupported:
    'Ce document contient des citations Zotero dans les notes de bas de page ou de fin, que GenOffice ne peut pas encore mettre à jour. Les commandes Zotero sont désactivées ici afin de préserver la bibliographie.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

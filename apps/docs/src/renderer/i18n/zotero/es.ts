import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const es = {
  zoteroCitation: 'Cita de Zotero',
  zoteroCitationTip: 'Añadir una cita con Zotero; coloque el cursor en una cita para editarla',
  zoteroBibliography: 'Bibliografía de Zotero',
  zoteroBibliographyTip: 'Añadir o editar la bibliografía con Zotero',
  zoteroRefresh: 'Actualizar',
  zoteroRefreshTip: 'Actualizar todas las citas y bibliografías de Zotero',
  zoteroDocumentSettings: 'Configuración del documento',
  zoteroDocumentSettingsTip: 'Configuración del documento de Zotero',
  zoteroDocumentPreferences: 'Preferencias del documento',
  zoteroRemoveCodes: 'Eliminar códigos de campo',
  zoteroConnectionError: 'No se puede conectar con Zotero. Inicie Zotero y manténgalo abierto.',
  zoteroOperationError: 'La operación de Zotero ha fallado.',
  zoteroNoteFieldsUnsupported:
    'Este documento tiene citas de Zotero en notas al pie o al final que GenOffice aún no puede actualizar. Los comandos de Zotero están desactivados aquí para mantener intacta la bibliografía.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

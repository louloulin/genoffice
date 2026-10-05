import type { zh } from './zh'

/** Zotero integration strings (References tab). Split out of strings-zotero.ts for per-locale dynamic loading. */
export const pt = {
  zoteroCitation: 'Citação do Zotero',
  zoteroCitationTip: 'Adicione uma citação com o Zotero; posicione o cursor nela para editar',
  zoteroBibliography: 'Bibliografia do Zotero',
  zoteroBibliographyTip: 'Adicione ou edite a bibliografia com o Zotero',
  zoteroRefresh: 'Atualizar',
  zoteroRefreshTip: 'Atualizar todas as citações e bibliografias do Zotero',
  zoteroDocumentSettings: 'Configurações do documento',
  zoteroDocumentSettingsTip: 'Configurações do documento do Zotero',
  zoteroDocumentPreferences: 'Preferências do documento',
  zoteroRemoveCodes: 'Remover códigos de campo',
  zoteroConnectionError:
    'Não foi possível conectar ao Zotero. Inicie o Zotero e mantenha-o aberto.',
  zoteroOperationError: 'A operação do Zotero falhou.',
  zoteroNoteFieldsUnsupported:
    'Este documento tem citações do Zotero em notas de rodapé ou de fim que o GenOffice ainda não consegue atualizar. Os comandos do Zotero estão desativados aqui para manter a bibliografia intacta.',
  zoteroGroup: 'Zotero',
} satisfies Record<keyof typeof zh, string>

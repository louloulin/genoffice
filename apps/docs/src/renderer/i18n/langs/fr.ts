import { fr as app } from '../app/fr'
import { fr as ribbon } from '../ribbon/fr'
import { fr as ai } from '../ai/fr'
import { fr as editor } from '../editor/fr'
import { fr as zotero } from '../zotero/fr'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `fr` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.fr,
  editor,
  ai,
  zotero,
}

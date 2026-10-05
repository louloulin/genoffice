import { ru as app } from '../app/ru'
import { ru as ribbon } from '../ribbon/ru'
import { ru as ai } from '../ai/ru'
import { ru as editor } from '../editor/ru'
import { ru as zotero } from '../zotero/ru'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `ru` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.ru,
  editor,
  ai,
  zotero,
}

import { en as app } from '../app/en'
import { en as ribbon } from '../ribbon/en'
import { en as ai } from '../ai/en'
import { en as editor } from '../editor/en'
import { en as zotero } from '../zotero/en'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `en` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.en,
  editor,
  ai,
  zotero,
}

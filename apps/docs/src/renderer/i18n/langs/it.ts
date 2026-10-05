import { it as app } from '../app/it'
import { it as ribbon } from '../ribbon/it'
import { it as ai } from '../ai/it'
import { it as editor } from '../editor/it'
import { it as zotero } from '../zotero/it'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `it` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.it,
  editor,
  ai,
  zotero,
}

import { id as app } from '../app/id'
import { id as ribbon } from '../ribbon/id'
import { id as ai } from '../ai/id'
import { id as editor } from '../editor/id'
import { id as zotero } from '../zotero/id'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `id` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.id,
  editor,
  ai,
  zotero,
}

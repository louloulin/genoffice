import { pl as app } from '../app/pl'
import { pl as ribbon } from '../ribbon/pl'
import { pl as ai } from '../ai/pl'
import { pl as editor } from '../editor/pl'
import { pl as zotero } from '../zotero/pl'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `pl` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.pl,
  editor,
  ai,
  zotero,
}

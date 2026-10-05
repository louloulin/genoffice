import { ms as app } from '../app/ms'
import { ms as ribbon } from '../ribbon/ms'
import { ms as ai } from '../ai/ms'
import { ms as editor } from '../editor/ms'
import { ms as zotero } from '../zotero/ms'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `ms` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.ms,
  editor,
  ai,
  zotero,
}

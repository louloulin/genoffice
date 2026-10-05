import { hi as app } from '../app/hi'
import { hi as ribbon } from '../ribbon/hi'
import { hi as ai } from '../ai/hi'
import { hi as editor } from '../editor/hi'
import { hi as zotero } from '../zotero/hi'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `hi` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.hi,
  editor,
  ai,
  zotero,
}

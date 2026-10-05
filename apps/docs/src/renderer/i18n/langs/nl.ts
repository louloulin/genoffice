import { nl as app } from '../app/nl'
import { nl as ribbon } from '../ribbon/nl'
import { nl as ai } from '../ai/nl'
import { nl as editor } from '../editor/nl'
import { nl as zotero } from '../zotero/nl'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `nl` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.nl,
  editor,
  ai,
  zotero,
}

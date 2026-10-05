import { th as app } from '../app/th'
import { th as ribbon } from '../ribbon/th'
import { th as ai } from '../ai/th'
import { th as editor } from '../editor/th'
import { th as zotero } from '../zotero/th'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `th` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.th,
  editor,
  ai,
  zotero,
}

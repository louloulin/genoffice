import { de as app } from '../app/de'
import { de as ribbon } from '../ribbon/de'
import { de as ai } from '../ai/de'
import { de as editor } from '../editor/de'
import { de as zotero } from '../zotero/de'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `de` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.de,
  editor,
  ai,
  zotero,
}

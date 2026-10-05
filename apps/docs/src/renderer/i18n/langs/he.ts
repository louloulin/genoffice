import { he as app } from '../app/he'
import { he as ribbon } from '../ribbon/he'
import { he as ai } from '../ai/he'
import { he as editor } from '../editor/he'
import { he as zotero } from '../zotero/he'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `he` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.he,
  editor,
  ai,
  zotero,
}

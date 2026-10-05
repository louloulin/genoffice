import { ar as app } from '../app/ar'
import { ar as ribbon } from '../ribbon/ar'
import { ar as ai } from '../ai/ar'
import { ar as editor } from '../editor/ar'
import { ar as zotero } from '../zotero/ar'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `ar` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.ar,
  editor,
  ai,
  zotero,
}

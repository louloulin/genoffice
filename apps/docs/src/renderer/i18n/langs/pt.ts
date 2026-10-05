import { pt as app } from '../app/pt'
import { pt as ribbon } from '../ribbon/pt'
import { pt as ai } from '../ai/pt'
import { pt as editor } from '../editor/pt'
import { pt as zotero } from '../zotero/pt'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `pt` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.pt,
  editor,
  ai,
  zotero,
}

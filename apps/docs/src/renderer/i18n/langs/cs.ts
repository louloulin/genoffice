import { cs as app } from '../app/cs'
import { cs as ribbon } from '../ribbon/cs'
import { cs as ai } from '../ai/cs'
import { cs as editor } from '../editor/cs'
import { cs as zotero } from '../zotero/cs'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `cs` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.cs,
  editor,
  ai,
  zotero,
}

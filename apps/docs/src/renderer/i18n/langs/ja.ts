import { ja as app } from '../app/ja'
import { ja as ribbon } from '../ribbon/ja'
import { ja as ai } from '../ai/ja'
import { ja as editor } from '../editor/ja'
import { ja as zotero } from '../zotero/ja'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `ja` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.ja,
  editor,
  ai,
  zotero,
}

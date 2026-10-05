import { ko as app } from '../app/ko'
import { ko as ribbon } from '../ribbon/ko'
import { ko as ai } from '../ai/ko'
import { ko as editor } from '../editor/ko'
import { ko as zotero } from '../zotero/ko'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `ko` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.ko,
  editor,
  ai,
  zotero,
}

import { zhTW as app } from '../app/zh-TW'
import { zhTW as ribbon } from '../ribbon/zh-TW'
import { zhTW as ai } from '../ai/zh-TW'
import { zhTW as editor } from '../editor/zh-TW'
import { zhTW as zotero } from '../zotero/zh-TW'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `zh-TW` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings['zh-TW'],
  editor,
  ai,
  zotero,
}

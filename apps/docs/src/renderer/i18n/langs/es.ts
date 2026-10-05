import { es as app } from '../app/es'
import { es as ribbon } from '../ribbon/es'
import { es as ai } from '../ai/es'
import { es as editor } from '../editor/es'
import { es as zotero } from '../zotero/es'
import { tableStrings } from '../strings-table'
import type { DomainDicts } from '../domains'

/** Locale entry for `es` — one lazy chunk pulls every domain shard for this language. */
export const langStrings: DomainDicts = {
  app,
  ribbon,
  table: tableStrings.es,
  editor,
  ai,
  zotero,
}

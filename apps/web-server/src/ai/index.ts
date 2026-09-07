/**
 * ai/* — Public entry for AI capability channels.
 *
 * Sub-modules: settings (multi-provider AiSettings state), chat
 * (real client backed by @genoffice/ai-provider), provider (structured
 * AiProviderError codes), search (placeholder), content (generic helpers),
 * skills-{doc,sheet,slide} (per-app skills).
 */

import { registerAiChatHandlers } from './chat.js'
import { registerAiContentHandlers } from './content.js'
import { registerAiSearchHandlers } from './search.js'
import { registerAiSettingsHandlers } from './settings.js'
import { registerAiSkillsDocHandlers } from './skills-doc.js'
import { registerAiSkillsSheetHandlers } from './skills-sheet.js'
import { registerAiSkillsSlideHandlers } from './skills-slide.js'

export function registerAiHandlers(): void {
  registerAiSettingsHandlers()
  registerAiChatHandlers()
  registerAiSearchHandlers()
  registerAiContentHandlers()
  registerAiSkillsDocHandlers()
  registerAiSkillsSheetHandlers()
  registerAiSkillsSlideHandlers()
}

/**
 * Barrel for the chat primitives. Every helper that apps or higher-level
 * UI consumes from the shared chat input lives here so a single import
 * line covers the whole surface.
 */
export {
  activeSlashQuery,
  applyComposerCommand,
  filterComposerCommands,
  firstEnabledIndex,
  flattenComposerGroups,
  groupComposerCommands,
  nextEnabledIndex,
  type ComposerCommand,
  type ComposerCommandGroup,
  type ComposerCommandKind,
  type SlashQuery,
} from './composer-commands'

export {
  activeMentionQuery,
  applyMentionPick,
  filterMentionEntries,
  flattenMentionGroups,
  indexOfMention,
  mentionInsertText,
  nextEnabledMentionIndex,
  parseMentionTokens,
  type MentionEntry,
  type MentionFilterResult,
  type MentionGroup,
  type MentionKind,
  type MentionPick,
  type MentionQuery,
  type MentionToken,
} from './mentions'

export { useVoiceInput, isVoiceInputAvailable, type UseVoiceInputOptions, type UseVoiceInputReturn } from './useVoiceInput'
export { useEditLast, findLastUserText, type EditLastEntry, type UseEditLastOptions, type UseEditLastReturn } from './useEditLast'
export {
  computeTokenCounter,
  estimateTokens,
  type CounterTone,
  type TokenCounter,
  type TokenCounterOptions,
} from './token-counter'

export {
  CHAT_MODES,
  CHAT_MODE_SPECS,
  DEFAULT_CHAT_MODE,
  chatModeDirective,
  chatModeSpec,
  composeSystemSuffix,
  isChatMode,
  isReadOnlyMode,
  normalizeChatMode,
  skillDirective,
  type ChatMode,
  type ChatModeSpec,
} from './modes'

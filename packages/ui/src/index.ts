export {
  AiComposer,
  type ComposerCommandPick,
  type ComposerModeOption,
} from './AiComposer'
export { AiComposerMenu, type AiComposerMenuProps } from './AiComposerMenu'
// Chat composer primitives: the slash-command model and the Ask/Craft/Plan
// mode directives. Pure logic, so apps can also unit-test their command tables.
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
} from './chat/composer-commands'
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
} from './chat/modes'
export { AiScopeQuote, type AiScopeQuoteData } from './AiScopeQuote'
export {
  AI_CUSTOM_FONT_MAX_PX,
  AI_CUSTOM_FONT_MIN_PX,
  AI_FONT_BASE_PX,
  AI_FONT_SIZES,
  DEFAULT_AI_PANEL_PREFS,
  aiPanelFontPx,
  clampAiCustomFontSize,
  isAiFontSize,
  normalizeAiPanelPrefs,
  type AiFontSize,
  type AiPanelPrefs,
} from './ai-panel-prefs'
export { applyAiPanelPrefs, useAiPanelPrefs } from './ai-panel-prefs-store'
export {
  ColorPicker,
  THEME_COLORS,
  THEME_COLOR_SHADES,
  STANDARD_COLORS,
  type ColorPickerProps,
  type ColorPickerStrings,
  type ColorSwatch,
} from './color-picker'
export { installScreenTips } from './screentip'
export {
  installPopoverDismiss,
  useDismissablePopover,
  type PopoverDismissOptions,
} from './popover-dismiss'
export { Dropdown, type DropdownOption } from './dropdown'
export {
  FindPanel,
  type FindFocusRequest,
  type FindPanelStrings,
  type FindTarget,
} from './find-panel'
export { findInText, foldCase, isWordChar, type FindOptions } from './find-text'
export {
  useRibbonCollapse,
  RibbonCollapseButton,
  RibbonExpandButton,
  installRibbonPeekDismiss,
  isRibbonToggleShortcut,
  readRibbonCollapsed,
  RIBBON_TOGGLE_SHORTCUT,
  type RibbonCollapse,
  type RibbonCollapseLabels,
} from './ribbon-collapse'
export { AiTypingIndicator } from './AiTypingIndicator'
export { IconSend, IconStop, type IconProps } from './icons'
export { Markdown, type MarkdownNav } from './Markdown'
export { isSymbolFontFamily } from './symbol-fonts'
export { BUILTIN_FONT_FAMILIES, fontFamiliesFor } from './font-list'
export {
  WORDART_PRESETS,
  wordArtSolidColor,
  wordArtStrokePx,
  type WordArtPreset,
} from './wordart-presets'
export {
  SHAPE_GALLERY_GROUPS,
  ShapePreview,
  shapeClipCss,
  shapePreviewBox,
  shapePreviewPath,
  type ShapeGalleryGroup,
  type ShapeGalleryShape,
} from './shape-gallery'
export {
  CropDialog,
  CutoutDialog,
  cropImagePng,
  DEFAULT_CUTOUT_TOLERANCE,
  type CropFractions,
  type ImageDialogLabels,
} from './image-dialogs'
export {
  removeBackground,
  sampleBackgroundColors,
  type CutoutResult,
  type PixelImage,
  type RGB,
} from './cutout'
export {
  encodeAutoSaveOverride,
  isAutoSaveDefault,
  NO_AUTO_SAVE_DEFAULT,
  resolveAutoSave,
  useAutoSavePref,
  type AutoSaveDefault,
  type AutoSaveDefaultApi,
} from './auto-save-pref'

// M3 — shared AI runtime primitives (replaces per-app inline copies of
// run headers, tool timelines, change-plan summaries, error recovery,
// attachment strips, and provider badges).
export {
  AiRunHeader,
  type AiRunHeaderProps,
} from './AiRunHeader'
export {
  AiProviderBadge,
  type AiProviderBadgeProps,
} from './AiProviderBadge'
export {
  AiAttachmentStrip,
  type AiAttachmentStripProps,
} from './AiAttachmentStrip'
export {
  AiToolTimeline,
  type AiToolTimelineProps,
} from './AiToolTimeline'
export {
  AiChangeSummary,
  type AiChangeSummaryProps,
} from './AiChangeSummary'
export {
  AiErrorRecovery,
  type AiErrorRecoveryProps,
} from './AiErrorRecovery'

// Inline AI primitives (selection-anchored launcher, translate dialog, change marker)
export {
  AiInlineLauncher,
  type AiInlineLauncherProps,
  type AiInlineLauncherStrings,
  type AiInlineLauncherAnchorRect,
  type AiInlineAction,
} from './AiInlineLauncher'
export {
  TranslateDialog,
  type TranslateDialogProps,
  type TranslateDialogStrings,
  type TranslateLanguageOption,
} from './TranslateDialog'
export { ChangeMarker, type ChangeMarkerProps } from './ChangeMarker'

// Extended icon set used by the runtime primitives.
export {
  IconAttachment,
  IconCheck,
  IconClose,
  IconEdit,
  IconRetry,
  IconSparkle,
  IconStopFilled,
  IconTool,
  IconWarning,
} from './icons'

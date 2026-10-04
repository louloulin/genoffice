/* Local minimal Web Speech API shape — covers what we use; full DOM lib types
 * are heavier than this single file needs. */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult: ((ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => void) | null  /* event type simplified */
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import type { Editor } from '@tiptap/core'
// Browser-safe entry point: `./document` carries no provider / Node import, so
// the renderer can share the whole-file pipeline instead of re-implementing it.
import { translateDocument } from '@genoffice/translation-core/document'
import type { EditorRange, TranslationUnit } from '@genoffice/translation-core/document'
// subpath, not the bare entry: `translation-core`'s index re-exports the
// provider / file-translate / persistent-memory modules, which pull Node
// built-ins (fs, child_process) into a browser bundle.
import {
  deriveTranslatedName,
  translatedNameSuffixFor,
} from '@genoffice/translation-core/translated-file-name'
import type { Block } from '@genoffice/docx-engine'

/**
 * Map a ProseMirror node name onto the pipeline's `kind` vocabulary.
 *
 * The old inline extraction typed `kind` as `string` and passed the node name
 * straight through, so the value only ever had to satisfy the *transport*
 * (which echoes it back untouched). `translateDocument` types it as a closed
 * union — which is the point: an unmapped node name would silently widen the
 * contract. Unknown shapes fall back to `paragraph`, the one kind every
 * apply strategy already handles.
 */
function documentUnitKind(nodeTypeName: string): TranslationUnit['kind'] {
  switch (nodeTypeName) {
    case 'heading':
      return 'heading'
    case 'listItem':
    case 'list_item':
      return 'list-item'
    case 'tableCell':
    case 'table_cell':
      return 'table-cell'
    default:
      return 'paragraph'
  }
}

/**
 * Normalise an editor range for the preview state.
 *
 * `EditorRange` has optional `from` / `to` (the translation-core wire shape);
 * the preview needs concrete numbers because the dialog renders an editable
 * range per row. A range without bounds is not selectable, so it degrades to
 * an empty span at the document start rather than to `undefined` — a row with
 * no range is exactly the "translated but can't be applied" case.
 */
function documentRange(range: EditorRange | null | undefined): {
  from: number
  to: number
  scope?: 'document'
} {
  const from = range?.from ?? 1
  const to = range?.to ?? from
  return { from, to, scope: 'document' }
}

/** Narrow a unit status off the wire; see the note on the web-bridge twin. */
function narrowUnitStatus(value: unknown): 'translated' | 'memory-hit' | 'failed' | undefined {
  return value === 'translated' || value === 'memory-hit' || value === 'failed' ? value : undefined
}

/**
 * Walk the document and produce the translatable units, in document order.
 *
 * Only text blocks with content become units; everything else (images, tables
 * as containers, empty paragraphs) is traversed into. The range is stamped now
 * because the live selection may have wandered by the time the user hits Apply.
 */
function extractDocumentUnits(editor: Editor): TranslationUnit[] {
  const units: TranslationUnit[] = []
  let order = 0
  editor.state.doc.descendants((node, pos) => {
    if (!node.isTextblock) return true
    const sourceText = node.textBetween(0, node.content.size, '\n', '\ufffc')
    if (!sourceText.trim()) return true
    units.push({
      unitId: `paragraph-${order}`,
      kind: documentUnitKind(node.type.name),
      sourceText,
      order,
      range: { from: pos + 1, to: pos + 1 + node.content.size, scope: 'document' },
    })
    order += 1
    return true
  })
  return units
}
import { AgentLoop, composeSkills, streamText, type AgentImage } from '@genoffice/agent-core'
import { imageGenerationAvailable } from '@genoffice/ai-provider/browser'
import type { AiSettings, AttachmentAddResult, AttachmentMeta } from '../../shared/ipc'
import { ATTACHMENT_IMAGE_EXTS } from '../../shared/ipc'
import type { PmNode } from '../editor/convert'
import { TABLE_TRAILING_SKIP } from '../editor/extensions'
import { countWords, findNumId, type NumIds } from './protocol'
import { DOC_NAV_SCHEME, navigateToBlock, parseDocNavHref } from './doc-nav'
import { markDocSeen, type AiCommentsAccess, type AiHeaderFooterAccess } from './tools'
import { createDocsSkill } from './docs-skill'
import {
  buildDocWriterRequest,
  countFragmentBlocks,
  DOC_MAX_CHARS,
  extractFragment,
  type DocWriteResult,
  type DocWriteSpec,
} from './doc-writer'
import { EditQueueCard } from './EditQueueCard'
import { createElectronTransport } from './transport'
import {
  buildQueueInstruction,
  buildQueueSummary,
  liveItems,
  resolveQueue,
  type DocsEditQueueItem,
} from './edit-queue'
import { setInactiveSelectionShown } from '../editor/inactive-selection'
import { applyRevisionsBy } from '../editor/revisions'
import { DOCS_CONTINUE_INSTRUCTION } from './continuation'
import { waitForFullContent } from '../phased-content'
import { currentDocGeneration } from '../file-actions'
import { createFilesSkill } from './files-skill'
import { createAiTransport } from './transports'
import { useI18n, t as tModule, aiLangDirective, type StringKey } from '../i18n/locale'
import { Markdown } from '@genoffice/ui'
import { AiComposer, AiScopeQuote, AiTypingIndicator, type AiScopeQuoteData } from '@genoffice/ui'
import {
  DEFAULT_CHAT_MODE,
  chatModeDirective,
  composeSystemSuffix,
  skillDirective,
  type ChatMode,
  type ComposerCommand,
  type ComposerCommandPick,
  type ComposerModeOption,
} from '@genoffice/ui'
import {
  DOCS_QUICK_ACTIONS,
  buildDocsComposerCommands,
  docsSkillOptions,
  skillIdOfCommand,
} from './composer-commands'
import { docsMentionFiles, docsMentionSkills } from './composer-mentions'
import {
  AiRunHeader,
  AiToolTimeline,
  AiErrorRecovery,
  AiInlineLauncher,
  TranslateDialog,
  TranslationStoragePanel,
  ChangeMarker,
  type AiInlineLauncherAnchorRect,
  type TranslateLanguageOption,
  type TranslateDialogStrings,
  type AiInlineLauncherStrings,
} from '@genoffice/ui'
import { postToEmbedParent } from '@genoffice/web-sdk/dataflare/guest'
import type { ChatRunStatus, ChatToolCallRecord } from '@genoffice/chat-runtime/types'
import { IconBook, ProviderMark } from '../components/icons'
import sendEnterOn from '../assets/send-enter-on.png'
import sendEnterOff from '../assets/send-enter-off.png'
import sendStop from '../assets/send-stop.png'
import attachIcon from '../assets/attach-icon.png'
import filePdfIcon from '../assets/file-pdf.png'
import fileWordIcon from '../assets/file-word.png'
import fileExcelIcon from '../assets/file-excel.png'
import filePptIcon from '../assets/file-ppt.png'
import fileImageIcon from '../assets/file-image.png'
import fileVideoIcon from '../assets/file-video.png'
import fileVoiceIcon from '../assets/file-voice.png'
import fileDocumentIcon from '../assets/file-document.png'
import fileGeneralIcon from '../assets/file-general.png'
import { IconNewChat, IconSidebarCollapse } from '../components/icons'

interface ToolActivity {
  name: string
  summary: string
  /** still executing: rendered as a spinner chip, replaced in place when the tool finishes */
  running?: boolean
  isError?: boolean
  /** Tool output (truncated on the UI side); when set, the row can be expanded for details */
  output?: string
}

/** Max characters of tool output in the UI expansion panel */
const TOOL_OUTPUT_MAX_CHARS = 2000

/** progress chip refresh while a write streams */
const CHIP_UPDATE_MS = 400

/** Cap on tool args/output persisted in the transcript (the store layer has another 16k truncation fallback) */
const PERSIST_TOOL_FIELD_MAX = 16_000

/** Tool args → JSON string (truncated; returns undefined on serialization failure, doesn't block persistence) */
function safeJsonInput(input: unknown): string | undefined {
  try {
    const s = JSON.stringify(input)
    return s && s !== '{}' ? s.slice(0, PERSIST_TOOL_FIELD_MAX) : undefined
  } catch {
    return undefined
  }
}

interface ChatEntry {
  role: 'user' | 'assistant'
  text: string
  error?: string
  streaming?: boolean
  turnLimit?: boolean
  /** the run failed because Genspark is signed out — render an inline sign-in button */
  loginRequired?: boolean
  /** tool executions performed during this assistant turn */
  tools?: ToolActivity[]
  /** document state before this turn's first edit — rendered as an inline roll-back action */
  snapshot?: PmNode
  /** attachments consumed from the composer by this user message (read-only echo chips) */
  attachments?: AttachmentMeta[]
  /** the selection this user message targeted, frozen at send */
  scope?: AiScopeQuoteData
}

/** longest selection excerpt echoed on a user bubble */
const SCOPE_TEXT_MAX = 200

/** clickable starter prompts for the empty state (fill the input, do not send) —
 * blank documents get generation starters, documents with content get edit starters */
const DRAFT_STARTER_PROMPTS: StringKey[] = [
  'aiStarterWeeklyReport',
  'aiStarterLaunchPost',
  'aiStarterEventOutline',
]
const EDIT_STARTER_PROMPTS: StringKey[] = [
  'aiStarterSummarize',
  'aiStarterPolishAll',
  'aiStarterContinue',
  'aiStarterFillTemplate',
]

/** resizable panel width: persisted, clamped so neither pane collapses */
const PANEL_WIDTH_KEY = 'docs-ai-panel-width'
const PANEL_WIDTH_DEFAULT = 360
const PANEL_WIDTH_MIN = 280

function maxPanelWidth(): number {
  // The viewport can be transiently tiny (a WebContentsView is 0×0 until the
  // shell lays it out), so never let the ceiling drop below the minimum
  return Math.max(PANEL_WIDTH_MIN, Math.min(720, Math.round(window.innerWidth * 0.6)))
}

function clampPanelWidth(w: number): number {
  return Math.min(Math.max(w, PANEL_WIDTH_MIN), maxPanelWidth())
}

function loadPanelWidth(): number {
  const saved = Number(localStorage.getItem(PANEL_WIDTH_KEY))
  // static bounds only — clamping against the window here would bake a
  // transiently small viewport into the restored preference
  return Number.isFinite(saved) && saved > 0
    ? Math.min(Math.max(saved, PANEL_WIDTH_MIN), 720)
    : PANEL_WIDTH_DEFAULT
}

/** persisted UI preference: highlight AI edits in yellow and ask for confirmation */
const TRACK_CHANGES_KEY = 'ai-docs-track-changes'

/** Clipboard bitmap MIME → attachment extension (corresponds to ATTACHMENT_IMAGE_EXTS) */
const PASTE_MIME_EXT: Record<string, string> = {
  'image/png': 'png',
  'image/jpeg': 'jpg',
  'image/gif': 'gif',
  'image/webp': 'webp',
}

/** File-type icons for attachment cards (Genspark attachment icon set); exts the
 *  attachment allowlist doesn't accept yet are mapped ahead so they light up when added */
const ATTACHMENT_CARD_ICON_GROUPS: [icon: string, exts: string[]][] = [
  [fileWordIcon, ['doc', 'docx']],
  [fileExcelIcon, ['xls', 'xlsx', 'xlsm', 'csv', 'tsv']],
  [filePptIcon, ['ppt', 'pptx']],
  [filePdfIcon, ['pdf']],
  [fileImageIcon, ['png', 'jpg', 'jpeg', 'gif', 'webp', 'bmp', 'svg', 'tiff', 'heic']],
  [fileVideoIcon, ['mp4', 'mov', 'avi', 'mkv', 'webm', 'm4v']],
  [fileVoiceIcon, ['mp3', 'wav', 'm4a', 'aac', 'flac', 'ogg', 'opus']],
  [
    fileDocumentIcon,
    [
      'txt',
      'md',
      'markdown',
      'rtf',
      'log',
      'json',
      'yaml',
      'yml',
      'xml',
      'html',
      'htm',
      'js',
      'ts',
      'tsx',
      'jsx',
      'py',
      'java',
      'c',
      'h',
      'cpp',
      'go',
      'rs',
      'rb',
      'sh',
      'sql',
      'css',
    ],
  ],
]

const ATTACHMENT_CARD_ICONS: Record<string, string> = Object.fromEntries(
  ATTACHMENT_CARD_ICON_GROUPS.flatMap(([icon, exts]) => exts.map((ext) => [ext, icon])),
)

function AttachmentCardIcon({ ext }: { ext: string }) {
  return <img src={ATTACHMENT_CARD_ICONS[ext] ?? fileGeneralIcon} alt="" aria-hidden />
}

/** Card name slot width: 190 card - 2 border - 8/14 padding - 40 icon - 10 gap */
const CARD_NAME_MAX_WIDTH = 116
let cardNameCtx: CanvasRenderingContext2D | null = null

/** Ellipsize like the design: cut at the limit, strip trailing -_./spaces so
 *  punctuation never sits against the …; CSS text-overflow stays as fallback */
function truncateCardName(name: string): string {
  cardNameCtx ??= document.createElement('canvas').getContext('2d')
  if (!cardNameCtx) return name
  // must match the stack the card name actually renders with (body font in styles.css)
  cardNameCtx.font =
    "500 13px 'Segoe UI', -apple-system, BlinkMacSystemFont, 'PingFang SC', 'Microsoft YaHei', sans-serif"
  if (cardNameCtx.measureText(name).width <= CARD_NAME_MAX_WIDTH) return name
  let lo = 1
  let hi = name.length
  while (lo < hi) {
    const mid = (lo + hi + 1) >> 1
    if (cardNameCtx.measureText(`${name.slice(0, mid)}…`).width <= CARD_NAME_MAX_WIDTH) lo = mid
    else hi = mid - 1
  }
  return `${name.slice(0, lo).replace(/[-_.\s]+$/, '')}…`
}

function formatAttachmentSize(bytes: number): string {
  return bytes >= 1024 * 1024
    ? `${(bytes / (1024 * 1024)).toFixed(2)} MB`
    : `${(bytes / 1024).toFixed(2)} KB`
}

/** Read-only echo of the attachments a user message consumed from the composer
 *  (image previews when the file is still readable; otherwise the placeholder icon) */
function SentAttachments({
  atts,
  previews,
}: {
  atts: AttachmentMeta[]
  previews: Record<string, string>
}) {
  return (
    <div className="ai-msg-attachments">
      {atts.map((a) =>
        ATTACHMENT_IMAGE_EXTS.has(a.ext) ? (
          <span key={a.path} className="ai-attachment-thumb" title={a.name}>
            {previews[a.path] ? (
              <img src={previews[a.path]} alt={a.name} />
            ) : (
              <span className="ai-attachment-thumb-pending" aria-hidden>
                <img src={fileImageIcon} alt="" />
              </span>
            )}
          </span>
        ) : (
          <span key={a.path} className="ai-attachment-card" title={a.name}>
            <span className="ai-attachment-card-icon">
              <AttachmentCardIcon ext={a.ext} />
            </span>
            <span className="ai-attachment-card-meta">
              <span className="ai-attachment-card-name">{truncateCardName(a.name)}</span>
              <span className="ai-attachment-card-size">{formatAttachmentSize(a.sizeBytes)}</span>
            </span>
          </span>
        ),
      )}
    </div>
  )
}

/** author name on AI-generated tracked revisions (accept/reject via Review) */
export const AI_REVISION_AUTHOR = 'AI Assistant'

interface AiPanelProps {
  editor: Editor
  blocks: Block[]
  settings: AiSettings
  /** the document has no text yet — the empty-state copy offers drafting instead of editing */
  docEmpty?: boolean
  /** fallback numbering ids for documents created from the blank template */
  numIdFallback?: NumIds | null
  /** preset instruction pushed from the ribbon or start screen; autoRun sends it immediately */
  preset?: { text: string; revision: number; autoRun?: boolean } | null
  /** false shows only the collapsed rail; the component stays mounted so panel state survives */
  open?: boolean
  /** expand from the collapsed rail */
  onExpand?: () => void
  /** collapse the panel to the sidebar rail */
  onCollapse?: () => void
  /** Absolute path of the currently open file (used for chat-history persistence) */
  filePath?: string | null
  /** queued selection-scoped edits (owned by App, which also owns the anchors) */
  editQueue?: DocsEditQueueItem[]
  onQueueEditInstruction?: (qid: string, instruction: string) => void
  onQueueRemove?: (qid: string) => void
  onQueueClear?: () => void
  /** scroll to and select the anchored passage */
  onQueueFocus?: (qid: string) => void
  /** submission consumed these items: drop them and their anchors */
  onQueueConsume?: (qids: string[]) => void
  /** comments store for the AI comment tools (read/reply/resolve) */
  commentsAccess?: AiCommentsAccess
  /** header/footer state for the set_header_footer tool and per-turn context */
  hfAccess?: AiHeaderFooterAccess
  /**
   * Persist the current bytes to a *sibling* cloud-drive file (the
   * non-destructive "save the translation as a copy" target). Undefined
   * outside the Dataflare embed, which is the only environment with a
   * save-as endpoint — without it the dialog hides the choice entirely rather
   * than offering one that cannot be honoured.
   */
  onSaveTranslatedCopy?: (fileName: string) => Promise<boolean>
}

export function AiPanel({
  editor,
  blocks,
  settings,
  docEmpty,
  numIdFallback,
  preset,
  open = true,
  onExpand,
  onCollapse,
  filePath,
  onSaveTranslatedCopy,
  editQueue = [],
  onQueueEditInstruction,
  onQueueRemove,
  onQueueClear,
  onQueueFocus,
  onQueueConsume,
  commentsAccess,
  hfAccess,
}: AiPanelProps) {
  const { t, lang } = useI18n()
  // Panel chrome follows the UI language; message text follows its own content (dir=auto below)
  const isRtl = lang === 'ar' || lang === 'he'
  const [input, setInput] = useState('')
  const [busy, setBusy] = useState(false)
  // Composer working mode (Ask / Craft / Plan) and the skill picked through
  // the `/` palette. Both reach the model through the loop's system suffix.
  const [mode, setMode] = useState<ChatMode>(DEFAULT_CHAT_MODE)
  /** Web Speech API bridge — only present in Chromium/Safari with a secure
   *  context. The hook owns the recognizer; AiPanel just hands the active
   *  state to AiComposer as the `voice` prop. Interim transcripts flow
   *  through `setPrompt` so the user sees words land as they speak. */
  const [voiceActive, setVoiceActive] = useState(false)
  const voiceBaseRef = useRef('')
  const voiceRef = useRef<{ recog: unknown; base: string } | null>(null)
  const voiceAvailable =
    typeof window !== 'undefined' &&
    Boolean((window as unknown as { SpeechRecognition?: unknown; webkitSpeechRecognition?: unknown }).SpeechRecognition ||
      (window as unknown as { webkitSpeechRecognition?: unknown }).webkitSpeechRecognition)
  const startVoice = useCallback(() => {
    if (voiceRef.current) return
    const w = window as unknown as {
      SpeechRecognition?: new () => SpeechRecognitionLike
      webkitSpeechRecognition?: new () => SpeechRecognitionLike
    }
    const Ctor = w.SpeechRecognition ?? w.webkitSpeechRecognition
    if (!Ctor) return
    const recog = new Ctor()
    recog.lang = (typeof navigator !== 'undefined' && navigator.language) || 'zh-CN'
    recog.interimResults = true
    recog.continuous = true
    const base = voiceBaseRef.current
    recog.onresult = (ev: { resultIndex: number; results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }> }) => {
      let interim = ''
      let finalText = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i] as { isFinal: boolean; 0: { transcript: string } }
        const txt = r[0].transcript
        if (r.isFinal) finalText += txt
        else interim += txt
      }
      const merged = base + (finalText || interim)
      voiceBaseRef.current = merged
      setInput(merged)
      if (finalText && voiceRef.current) {
        voiceRef.current.base = base + finalText
      }
    }
    recog.onerror = () => setVoiceActive(false)
    recog.onend = () => setVoiceActive(false)
    recog.start()
    voiceRef.current = { recog, base }
    setVoiceActive(true)
  }, [])
  const stopVoice = useCallback(() => {
    const v = voiceRef.current
    if (!v) return
    try { (v.recog as { stop?: () => void }).stop?.() } catch { /* ignore */ }
    voiceRef.current = null
    setVoiceActive(false)
  }, [])
  const voice = useMemo(
    () => (voiceAvailable
      ? { available: true as const, active: voiceActive, label: t('aiVoiceInput'), onStart: startVoice, onStop: stopVoice }
      : undefined),
    [voiceAvailable, voiceActive, t, startVoice, stopVoice],
  )
  const [activeSkillId, setActiveSkillId] = useState<string | null>(null)
  /** Wall-clock start of the current run, drives the elapsed badge */
  const runStartedAtRef = useRef(0)
  // Shared-component state mirror: ChatRuntime-fed timeline / run header.
  // Kept additive so the existing inline tool cards keep rendering untouched;
  // the shared components read from this state without touching AgentLoop.
  const [sharedToolTimeline, setSharedToolTimeline] = useState<ChatToolCallRecord[]>([])
  const [sharedRunStatus, setSharedRunStatus] = useState<ChatRunStatus>('idle')
  /** Last error from a finished run; consumed by <AiErrorRecovery>. */
  const [lastError, setLastError] = useState<string | null>(null)
  const sharedToolSeqRef = useRef(0)
  function emitSharedToolStart(name: string, input: unknown) {
    sharedToolSeqRef.current += 1
    const rec: ChatToolCallRecord = {
      id: `tool-${sharedToolSeqRef.current}`,
      name,
      input: (input ?? {}) as Record<string, unknown>,
      status: 'running',
      startedAt: Date.now(),
    }
    setSharedToolTimeline((prev) => [...prev, rec])
    return rec.id
  }
  function resetSharedTimeline() {
    sharedToolSeqRef.current = 0
    setSharedToolTimeline([])
  }
  /** a send waiting on a phased open's tail; Stop / New chat abort it before it runs */
  const pendingSendRef = useRef<{ aborted: boolean } | null>(null)
  const [chat, setChat] = useState<ChatEntry[]>([])
  /** a streamed write stopped early: the draft stays in the document until the user keeps or discards it */
  const [activePartial, setActivePartial] = useState<{ blocks: number } | null>(null)
  const partialResolverRef = useRef<((keep: boolean) => void) | null>(null)
  /** bumped by New chat / unmount: a writer resuming after its abort must not open the keep card */
  const writerEpochRef = useRef(0)
  /** Past conversation restored from JSONL (read-only transcript, not fed to the model) */
  const [historicChat, setHistoricChat] = useState<ChatEntry[]>([])
  const [trackChanges, setTrackChanges] = useState(
    () => localStorage.getItem(TRACK_CHANGES_KEY) === '1',
  )
  const [copiedIdx, setCopiedIdx] = useState<number | null>(null)
  const [attachments, setAttachments] = useState<AttachmentMeta[]>([])
  const [attachNotice, setAttachNotice] = useState<string | null>(null)
  /** data-URL previews for image attachments, keyed by path (Genspark composer thumbnails) */
  const [attachmentPreviews, setAttachmentPreviews] = useState<Record<string, string>>({})
  /** image paths with a read already issued — one readAttachmentImage per attach, even while pending */
  const previewRequestedRef = useRef(new Set<string>())
  /** Attachments consumed by earlier sends this session: sending clears the composer, but the
      files skill must keep reading them mid-run and in follow-up turns. Deduped by path
      against the live composer list. */
  const sentAttachmentsRef = useRef<AttachmentMeta[]>([])
  useEffect(() => {
    // previews cover the composer plus every image echoed on a sent/history message
    // (history chips re-read the file by its stored path; a deleted file keeps the placeholder)
    const wanted = [
      ...attachments,
      ...chat.flatMap((e) => e.attachments ?? []),
      ...historicChat.flatMap((e) => e.attachments ?? []),
    ]
    const alive = new Set(wanted.map((a) => a.path))
    // drop previews (and request markers) of removed attachments, so memory is reclaimed and a re-attach re-reads
    setAttachmentPreviews((prev) => {
      const stale = Object.keys(prev).filter((p) => !alive.has(p))
      if (stale.length === 0) return prev
      const next = { ...prev }
      for (const p of stale) delete next[p]
      return next
    })
    for (const p of previewRequestedRef.current) {
      if (!alive.has(p)) previewRequestedRef.current.delete(p)
    }
    for (const a of wanted) {
      if (!ATTACHMENT_IMAGE_EXTS.has(a.ext) || previewRequestedRef.current.has(a.path)) continue
      previewRequestedRef.current.add(a.path)
      void window.desktop
        .readAttachmentImage(a.path)
        .then((r) => {
          if (!previewRequestedRef.current.has(a.path)) return // removed while the read was in flight
          if (r.ok && r.base64 && r.mime) {
            setAttachmentPreviews((prev) => ({
              ...prev,
              [a.path]: `data:${r.mime};base64,${r.base64}`,
            }))
          }
        })
        .catch(() => {
          // A rejected read (bridge error, teardown race) must not leave the
          // path marked requested forever — that would permanently skip the
          // thumbnail with no retry. Clear it so the next effect run retries.
          previewRequestedRef.current.delete(a.path)
        })
    }
  }, [attachments, chat, historicChat])
  /** paints the strip's scrollbar thumb while the user scrolls it (cleared 800ms after the last event) */
  const attachScrollFadeRef = useRef(0)
  const onAttachmentsScroll = (e: React.UIEvent<HTMLDivElement>): void => {
    const el = e.currentTarget
    el.classList.add('is-scrolling')
    window.clearTimeout(attachScrollFadeRef.current)
    attachScrollFadeRef.current = window.setTimeout(() => el.classList.remove('is-scrolling'), 800)
  }
  const [dragOver, setDragOver] = useState(false)
  // preferred = the user's chosen width (the only value persisted); panelWidth =
  // what fits the current window. Deriving the display width from the preference
  // means a transiently small window never permanently shrinks the panel.
  const preferredWidthRef = useRef(loadPanelWidth())
  const [panelWidth, setPanelWidth] = useState(() => clampPanelWidth(preferredWidthRef.current))
  const [resizing, setResizing] = useState(false)
  const asideRef = useRef<HTMLElement>(null)

  // The .ai-dock wrapper owns the animated width (Excel-parity 180ms slide);
  // it tracks the resizable panel width through this variable
  // `open` dep: the aside ref only exists while expanded
  useEffect(() => {
    const dock = asideRef.current?.closest('.ai-dock') as HTMLElement | null
    dock?.style.setProperty('--ai-panel-width', `${panelWidth}px`)
  }, [panelWidth, open])

  // Re-derive the display width on window resize (max is 60% of the window);
  // growing the window back restores the preferred width
  useEffect(() => {
    const onResize = () => setPanelWidth(clampPanelWidth(preferredWidthRef.current))
    window.addEventListener('resize', onResize)
    return () => window.removeEventListener('resize', onResize)
  }, [])
  // a pending keep/discard must not outlive the panel: settle it as discard
  useEffect(
    () => () => {
      writerEpochRef.current++
      partialResolverRef.current?.(false)
      partialResolverRef.current = null
    },
    [],
  )
  // bumped on selection/doc changes so the scope hint & quick actions stay fresh
  const [scopeTick, setScopeTick] = useState(0)
  /** the scope chip's expandable preview of the selected text */
  const [scopePreviewOpen, setScopePreviewOpen] = useState(false)
  const logRef = useRef<HTMLDivElement>(null)
  const inputRef = useRef<HTMLTextAreaElement>(null)
  /** false once the user scrolls up to read; re-arms near the bottom */
  const stickToBottomRef = useRef(true)
  /** projectId/chatId of the current chat */
  const chatRefIds = useRef<{ projectId: string; chatId: string } | null>(null)

  // latest props for the loop's closures (the loop instance outlives renders)
  const editorRef = useRef(editor)
  editorRef.current = editor
  const settingsRef = useRef(settings)
  settingsRef.current = settings
  /** gsk login state for the generate_image gate (refreshed on mount and window focus) */
  const gskLoggedInRef = useRef(false)
  useEffect(() => {
    let alive = true
    const refresh = () => {
      // tests render the panel without a preload bridge
      void window.desktop
        ?.aiGskStatus?.()
        .then((s) => {
          if (alive) gskLoggedInRef.current = !!s?.loggedIn
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      alive = false
      window.removeEventListener('focus', refresh)
    }
  }, [])
  const blocksRef = useRef(blocks)
  blocksRef.current = blocks
  const numIdFallbackRef = useRef(numIdFallback)
  numIdFallbackRef.current = numIdFallback
  const attachmentsRef = useRef(attachments)
  attachmentsRef.current = attachments
  /** attachments consumed by the most recent send — retry resends the same set */
  const lastAttachmentsRef = useRef<AttachmentMeta[]>([])
  /** the scope quote of the last send, so a retry reuses it instead of re-reading the live selection */
  const lastScopeRef = useRef<AiScopeQuoteData | undefined>(undefined)
  /** composer attachments plus everything already sent this session (deduped by path) */
  const availableAttachments = (): AttachmentMeta[] => {
    const seen = new Set<string>()
    return [...sentAttachmentsRef.current, ...attachmentsRef.current].filter((a) =>
      seen.has(a.path) ? false : (seen.add(a.path), true),
    )
  }
  const trackChangesRef = useRef(trackChanges)
  trackChangesRef.current = trackChanges
  const commentsAccessRef = useRef(commentsAccess)
  commentsAccessRef.current = commentsAccess
  const hfAccessRef = useRef(hfAccess)
  hfAccessRef.current = hfAccess

  /** drop every aiChanged flag; silent = skip undo history (auto-accept path) */
  const clearAiHighlights = (silent = false) => {
    const view = editorRef.current.view
    let tr = view.state.tr
    let touched = false
    view.state.doc.forEach((node, offset) => {
      if (node.attrs.aiChanged) {
        tr = tr.setNodeMarkup(offset, undefined, { ...node.attrs, aiChanged: false })
        touched = true
      }
    })
    if (silent) tr = tr.setMeta('addToHistory', false)
    if (touched) {
      view.dispatch(tr)
      // AI-pipeline housekeeping, not a user edit: keep the freshness baseline current
      markDocSeen(editorRef.current)
    }
  }
  /** instruction of the in-flight run */
  const instructionRef = useRef('')
  /** document state before the run's first edit — attached to the turn's final
      segment at run end (mid-turn segments never show the action toolbar) */
  const runSnapshotRef = useRef<PmNode | null>(null)
  /** last sent instruction, for one-click retry */
  const lastInstructionRef = useRef('')
  /** Tool activity of the whole run (with args/output, accumulated across turns) — for full
      transcript persistence, and so persisting needn't do side effects inside a setState updater */
  const runToolsRef = useRef<
    Array<{ name: string; summary: string; isError?: boolean; input?: string; output?: string }>
  >([])

  // ── Chat-history persistence ────────────────────────────────────────────
  useEffect(() => {
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!api) return
    const tempChatId = `unsaved-${Date.now()}`
    void api
      .resolveChat({ filePath: filePath ?? null, tempChatId })
      .then((ids) => {
        chatRefIds.current = ids
        return api.loadChat({ projectId: ids.projectId, chatId: ids.chatId, limit: 200 })
      })
      .then((msgs) => {
        if (msgs.length === 0) return
        setHistoricChat(
          msgs.map((m) => ({
            role: m.role,
            text: m.text,
            tools: m.tools?.map((t) => ({
              name: t.name,
              summary: t.summary,
              isError: t.isError,
              output: t.output ? t.output.slice(0, TOOL_OUTPUT_MAX_CHARS) : undefined,
            })),
            // stored metadata only: no thumbnail read for history, the chips render name/size
            attachments: m.attachments
              ?.filter((a) => a.path)
              .map((a) => ({
                name: a.name,
                path: a.path ?? '',
                ext: a.ext ?? '',
                sizeBytes: a.sizeBytes ?? 0,
              })),
            ...(m.scope ? { scope: m.scope } : {}),
          })),
        )
        // restore model context: follow-ups after reopening a file continue the previous conversation (only when the loop is idle with no history)
        loopRef.current?.restore(msgs.map((m) => ({ role: m.role, text: m.text })))
      })
      .catch(() => {
        /* history load failures are silent */
      })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])

  /** After an unsaved document's first save yields a real path, bind the unsaved-* history to that file (recoverable by path on reopen) */
  useEffect(() => {
    const ids = chatRefIds.current
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!api || !ids || !filePath || !ids.chatId.startsWith('unsaved-')) return
    void api
      .rebindChat({ projectId: ids.projectId, tempChatId: ids.chatId, newFilePath: filePath })
      .then((r) => {
        if (r?.chatId) chatRefIds.current = r
      })
      .catch(() => {
        /* silent */
      })
  }, [filePath])

  const persistMessage = (
    role: 'user' | 'assistant',
    text: string,
    tools?: Array<{
      name: string
      summary: string
      isError?: boolean
      input?: string
      output?: string
    }>,
    attachments?: AttachmentMeta[],
    scope?: AiScopeQuoteData,
  ) => {
    const ids = chatRefIds.current
    const api = (window as Window & { projectApi?: typeof window.projectApi }).projectApi
    if (!ids || !api) return
    void api
      .appendChat({
        projectId: ids.projectId,
        chatId: ids.chatId,
        role,
        text,
        ...(tools && tools.length > 0 ? { tools } : {}),
        ...(attachments && attachments.length > 0
          ? {
              attachments: attachments.map((a) => ({
                name: a.name,
                path: a.path,
                ext: a.ext,
                sizeBytes: a.sizeBytes,
              })),
            }
          : {}),
        ...(scope ? { scope } : {}),
      })
      .catch(() => {
        /* silent */
      })
  }

  const patchLastAssistant = (
    patch: Partial<ChatEntry> | ((last: ChatEntry) => Partial<ChatEntry>),
  ) => {
    setChat((prev) => {
      const next = [...prev]
      const last = next[next.length - 1]
      if (!last || last.role !== 'assistant') return prev
      next[next.length - 1] = { ...last, ...(typeof patch === 'function' ? patch(last) : patch) }
      return next
    })
  }

  const transportRef = useRef<ReturnType<typeof createElectronTransport> | null>(null)
  if (!transportRef.current)
    transportRef.current = createElectronTransport(() => settingsRef.current)

  /**
   * Long-form writing: one tool-less request whose reply is the fragment, streamed
   * into the document as a draft by the tool. A stream that stops early leaves the
   * user a keep-or-discard choice; a stream that produced nothing is retried once.
   */
  const runDocWriter = async (
    spec: DocWriteSpec,
    onProgress: (html: string) => void,
    signal?: AbortSignal,
  ): Promise<DocWriteResult> => {
    const { system, user } = buildDocWriterRequest(spec, aiLangDirective())
    const epoch = writerEpochRef.current
    let closed = false
    let chipTimer: ReturnType<typeof setTimeout> | null = null
    let latest = ''
    const updateChip = () => {
      chipTimer = null
      if (closed) return
      const blocks = countFragmentBlocks(latest)
      patchLastAssistant((last) => ({
        tools: last.tools?.map((tl) =>
          tl.running ? { ...tl, summary: tModule('aiWritingDocument', { blocks }) } : tl,
        ),
      }))
    }
    const attempt = () =>
      streamText({
        transport: transportRef.current!,
        system,
        user,
        signal,
        maxChars: DOC_MAX_CHARS,
        extract: (raw) => ({ text: extractFragment(raw) }),
        onProgress: (html) => {
          if (closed) return
          latest = html
          onProgress(html)
          if (chipTimer === null) chipTimer = setTimeout(updateChip, CHIP_UPDATE_MS)
        },
      })
    let outcome = await attempt()
    if (outcome.status === 'empty' && !signal?.aborted) outcome = await attempt()
    closed = true
    if (chipTimer !== null) clearTimeout(chipTimer)
    if (outcome.status === 'complete') return { ok: true, html: outcome.text }
    if (outcome.status === 'empty') return { ok: false, error: outcome.error }
    if (epoch !== writerEpochRef.current) return { ok: false, error: 'the chat was reset' }
    // the draft stays in the document while the user decides
    const keep = await new Promise<boolean>((resolve) => {
      partialResolverRef.current = resolve
      setActivePartial({ blocks: countFragmentBlocks(outcome.text) })
    })
    return keep
      ? { ok: true, html: outcome.text, truncated: true }
      : {
          ok: false,
          error: `${outcome.reason}${outcome.error ? `: ${outcome.error}` : ''}; the user discarded the partial content`,
        }
  }
  const runDocWriterRef = useRef(runDocWriter)
  runDocWriterRef.current = runDocWriter

  const decidePartial = (keep: boolean): void => {
    partialResolverRef.current?.(keep)
    partialResolverRef.current = null
    setActivePartial(null)
  }
  /** New chat / unmount: discard an open keep card and keep a still-settling writer from opening one */
  const abandonWriter = (): void => {
    writerEpochRef.current++
    decidePartial(false)
  }

  // ── composer command table + working mode ───────────────────────────────
  // One table drives both the quick-action chips and the `/` palette; the
  // skills it lists are the ones this panel's loop actually composes.
  const composerSkills = useMemo(
    () =>
      docsSkillOptions({
        imageGenAvailable: imageGenerationAvailable(settingsRef.current, gskLoggedInRef.current),
      }),
    [settings],
  )
  const composerSkillsRef = useRef(composerSkills)
  composerSkillsRef.current = composerSkills
  const modeRef = useRef(mode)
  modeRef.current = mode
  const activeSkillIdRef = useRef(activeSkillId)
  activeSkillIdRef.current = activeSkillId

  const modeOptions = useMemo<ComposerModeOption[]>(
    () => [
      { id: 'ask', label: t('aiModeAsk'), title: t('aiModeAskHint') },
      { id: 'craft', label: t('aiModeCraft'), title: t('aiModeCraftHint') },
      { id: 'plan', label: t('aiModePlan'), title: t('aiModePlanHint') },
    ],
    [t],
  )

  const quickActions = useMemo(
    () =>
      DOCS_QUICK_ACTIONS.map((action) => ({
        ...action,
        label: t(action.labelKey),
        prompt: t(action.promptKey),
      })),
    [t],
  )

  const composerCommands = useMemo<ComposerCommand[]>(
    () =>
      buildDocsComposerCommands({ t, skills: composerSkills, quickActions: DOCS_QUICK_ACTIONS }),
    [t, composerSkills],
  )

  /**
   * @-mention palette. Built every render so attachment removals show up
   * immediately; cheap because the input is bounded (≤ 8 files + 5 skills).
   */
  const composerMentions = useMemo(
    () => [
      ...docsMentionFiles({
        attachments,
        recent: chat.flatMap((e) => e.attachments ?? []).slice(-3),
      }),
      ...docsMentionSkills(
        composerSkills.map((s) => ({
          id: s.id,
          trigger: s.trigger,
          label: t(s.labelKey),
          description: t(s.descriptionKey),
          available: s.available,
        })),
      ),
    ],
    [attachments, chat, composerSkills, t],
  )

  const onComposerMentionPick = useCallback((pick: { entry: { id: string }; value: string; caret: number }) => {
    // The composer already mutated the value to insert `@label `. We just
    // log the pick so future host code (e.g. resolveMentionTokens) can hook
    // in without touching this file. Keep the handler minimal so the
    // textarea state stays the single source of truth.
    void pick
  }, [])

  /** Optional token-budget badge — shows how full the prompt is. The model
   *  context window changes per provider; 8k is a safe default for the docs
   *  panel because we keep the document in a separate tool call, not in the
   *  prompt. */
  const tokenBudget = 8000

  const activeSkill =
    activeSkillId === null
      ? null
      : (composerSkills.find((skill) => skill.id === activeSkillId) ?? null)

  /** The loop's per-turn suffix: UI language + working mode + picked skill. */
  const composerSystemSuffix = useCallback((): string => {
    const pickedId = activeSkillIdRef.current
    const picked =
      pickedId === null
        ? null
        : (composerSkillsRef.current.find((skill) => skill.id === pickedId) ?? null)
    return composeSystemSuffix(
      aiLangDirective(),
      chatModeDirective(modeRef.current),
      picked === null
        ? ''
        : skillDirective({
            name: t(picked.labelKey),
            description: t(picked.descriptionKey),
            instructions: picked.instructions,
          }),
    )
  }, [t])

  const onComposerCommandPick = useCallback((pick: ComposerCommandPick) => {
    const { command } = pick
    // A skill loads its rules for the following turns; an action or a template
    // has already written its text into the box and needs nothing more.
    if (command.kind !== 'run') return
    const skillId = skillIdOfCommand(command.id)
    if (skillId !== null) setActiveSkillId(skillId)
  }, [])

  const loopRef = useRef<AgentLoop<PmNode> | null>(null)
  if (!loopRef.current) {
    const numIds = (): NumIds => ({
      bullet: findNumId(blocksRef.current, 'bullet') ?? numIdFallbackRef.current?.bullet ?? null,
      ordered: findNumId(blocksRef.current, 'ordered') ?? numIdFallbackRef.current?.ordered ?? null,
    })
    loopRef.current = new AgentLoop<PmNode>({
      transport: createAiTransport(() => settingsRef.current),
      systemSuffix: composerSystemSuffix,
      skill: composeSkills('docs+files', '', [
        createDocsSkill(
          () => editorRef.current,
          numIds,
          () => (trackChangesRef.current ? { author: AI_REVISION_AUTHOR } : undefined),
          () => commentsAccessRef.current,
          () => hfAccessRef.current,
          () => imageGenerationAvailable(settingsRef.current, gskLoggedInRef.current),
          () => ({
            write: (spec, onProgress, signal) => runDocWriterRef.current(spec, onProgress, signal),
          }),
        ),
        createFilesSkill(availableAttachments),
      ]),
      captureSnapshot: () => editorRef.current.getJSON() as PmNode,
      events: {
        onText: (text) => {
          patchLastAssistant({ text })
          setSharedRunStatus('streaming')
        },
        onToolStart: (call) => {
          // Live "running" chip: replaced in place by onToolExecuted
          patchLastAssistant((last) => ({
            tools: [
              ...(last.tools ?? []),
              { name: call.name, summary: call.name.replace(/[_-]+/g, ' '), running: true },
            ],
          }))
          emitSharedToolStart(call.name, call.input)
        },
        onToolExecuted: ({ call, execution, snapshotBefore }) => {
          // The run's first pre-edit state wins so one roll-back undoes the whole run
          if (snapshotBefore && !runSnapshotRef.current) runSnapshotRef.current = snapshotBefore
          if (execution.mutated) {
            // tracking off: accept immediately (same tick, so the yellow never paints);
            // tracking on: revisions stay pending, handled in the Review tab
            if (!trackChangesRef.current) clearAiHighlights(true)
          }
          runToolsRef.current.push({
            name: call.name,
            summary: execution.summary,
            isError: execution.isError,
            input: safeJsonInput(call.input),
            output: execution.output
              ? execution.output.slice(0, PERSIST_TOOL_FIELD_MAX)
              : undefined,
          })
          // Mirror to shared timeline (find the running record by tool name + recency).
          setSharedToolTimeline((prev) => {
            const idx = [...prev]
              .reverse()
              .findIndex((t) => t.status === 'running' && t.name === call.name)
            if (idx < 0) return prev
            const realIdx = prev.length - 1 - idx
            const target = prev[realIdx]
            const next = prev.slice()
            next[realIdx] = {
              ...target,
              status: execution.isError ? 'error' : 'executed',
              output: execution.output ? String(execution.output).slice(0, 500) : target.output,
              finishedAt: Date.now(),
              isError: !!execution.isError,
            }
            return next
          })
          patchLastAssistant((last) => {
            // Swap out the running placeholder pushed by onToolStart (parse-fail calls have none)
            const tools = [...(last.tools ?? [])]
            if (tools.at(-1)?.running) tools.pop()
            return {
              tools: [
                ...tools,
                {
                  name: call.name,
                  summary: execution.summary,
                  isError: execution.isError,
                  output: execution.output
                    ? execution.output.slice(0, TOOL_OUTPUT_MAX_CHARS)
                    : undefined,
                },
              ],
            }
          })
        },
        onTurnEnd: () => {
          patchLastAssistant({ streaming: false })
          setChat((prev) => [...prev, { role: 'assistant', text: '', streaming: true }])
        },
        onDone: ({ text, cancelled, turnLimit, truncated }) => {
          // module-level t: the loop instance is created only once; the component's t goes stale with the first-render closure
          const baseText = turnLimit
            ? [text, tModule('aiTurnLimit')].filter(Boolean).join('\n\n')
            : text || (cancelled ? tModule('aiStopped') : '')
          setSharedRunStatus(cancelled ? 'cancelled' : 'done')
          const finalText = truncated
            ? [baseText, tModule('aiTruncatedNote')].filter(Boolean).join('\n\n')
            : baseText
          patchLastAssistant((last) => ({
            streaming: false,
            turnLimit,
            text: finalText || (last.tools?.length ? last.text : tModule('aiNoReply')),
            // A stop mid-tool can leave a running placeholder behind — drop it
            tools: last.tools?.filter((tl) => !tl.running),
            snapshot: runSnapshotRef.current ?? undefined,
          }))
          setBusy(false)
          // App listens: a run that generated content into a never-saved document
          // triggers a silent first save with a content-derived file name
          window.dispatchEvent(new Event('ai-docs-run-done'))
          // persist outside the updater (a double-invoked updater would write history twice); tools stores the whole run's full activity.
          // Edits-only runs (tools ran, no text) persist too, or the whole turn vanishes from the restored transcript
          if (!cancelled && (finalText || runToolsRef.current.length > 0)) {
            persistMessage('assistant', finalText, runToolsRef.current)
          }
        },
        onError: (error) => {
          setSharedRunStatus('error')
          setLastError(error)
          setChat((prev) => {
            const next = [...prev]
            const last = next.at(-1)
            if (last?.role === 'assistant') {
              next[next.length - 1] = {
                ...last,
                streaming: false,
                error,
                tools: last.tools?.filter((tl) => !tl.running),
                snapshot: runSnapshotRef.current ?? undefined,
              }
            }
            return next
          })
          // Signed-out failures get an inline sign-in button; detected via
          // gsk status rather than matching the localized error text
          void window.desktop
            .aiGskStatus()
            .then((status) => {
              if (status.loggedIn) return
              setChat((prev) => {
                const next = [...prev]
                const last = next.at(-1)
                if (last?.role === 'assistant' && last.error) {
                  next[next.length - 1] = { ...last, loginRequired: true }
                }
                return next
              })
            })
            .catch(() => {})
          setBusy(false)
        },
      },
    })
  }

  useEffect(() => {
    if (!preset) return
    if (preset.autoRun) runWith(preset.text)
    else {
      setInput(preset.text)
      inputRef.current?.focus()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset?.revision])

  // keep the scope hint & quick actions in sync with the editor selection
  useEffect(() => {
    const bump = () => {
      if (editor.state.selection.empty) setScopePreviewOpen(false)
      setScopeTick((t) => t + 1)
    }
    editor.on('selectionUpdate', bump)
    editor.on('update', bump)
    return () => {
      editor.off('selectionUpdate', bump)
      editor.off('update', bump)
    }
  }, [editor])

  // scope chip data, recomputed per render (the scope tick above keeps it fresh)
  const liveSelection = editor.state.selection
  const selectionText = liveSelection.empty
    ? ''
    : editor.state.doc.textBetween(liveSelection.from, liveSelection.to, '\n', ' ').trim()
  const hasScopeSelection = selectionText.length > 0

  // ─── M2 — inline launcher (selection-anchored quick chips) ───
  // AiInlineLauncher anchors itself to the selection and TranslateDialog owns its
  // own busy flag and result text, so this panel only tracks the dialog's
  // open/error state.
  const [translateOpen, setTranslateOpen] = useState(false)
  // Glossary / memory panel: browsing and adding terms is a document-level
  // task, not a chat turn, so it is its own dialog rather than a prompt.
  const [storagePanelOpen, setStoragePanelOpen] = useState(false)
  const [translateError, setTranslateError] = useState<string | null>(null)
  const [translateScope, setTranslateScope] = useState<'selection' | 'document'>('selection')
  const [documentTranslationUnits, setDocumentTranslationUnits] = useState<
    Array<{
      id: string
      /** Same closed vocabulary the pipeline uses — see `documentUnitKind`. */
      kind: TranslationUnit['kind']
      order: number
      sourceText: string
      translatedText?: string
      status?: 'translated' | 'memory-hit' | 'failed'
      matchedTerms?: string[]
      warnings?: string[]
      range: { from: number; to: number; scope?: 'document' }
    }>
  >([])
  const [documentTranslationQuality, setDocumentTranslationQuality] = useState<{
    overallScore?: number
    warnings?: string[]
  }>()
  const [bilingual, setBilingual] = useState<boolean>(false)
  /**
   * 译文落点。默认 `copy`（另存翻译副本）而不是 `overwrite`：整篇翻译往往是在
   * 拿别人的原件读，默认路径不该悄悄把原文顶掉。桌面构建没有云盘可另存，
   * `canSaveTranslatedCopy` 为假时整个选择器不渲染，`overwrite` 之外的选项
   * 也就不会出现。
   */
  const [saveTarget, setSaveTarget] = useState<'overwrite' | 'copy'>('copy')
  const canSaveTranslatedCopy = Boolean(onSaveTranslatedCopy)
  /**
   * 只在**整篇**翻译时给保存方式。选区翻译改的是文档里一小段，把它整篇另存成
   * `xxx.translated.docx` 会让用户以为译文覆盖了全文；选区翻译走「改完按 Ctrl+S」
   * 这条既有路径，不额外发明一个落点。
   */
  const showSaveTarget = canSaveTranslatedCopy && translateScope === 'document'
  /** 副本名在选双语开关时会变，所以显示给用户的名字也要跟着重算 */
  const translatedFileName = useMemo(() => {
    if (!canSaveTranslatedCopy) return null
    const name = (filePath ?? '').split(/[\\/]/).pop() || 'untitled.docx'
    return deriveTranslatedName(name, translatedNameSuffixFor(bilingual ? 'bilingual' : 'replace'))
  }, [canSaveTranslatedCopy, filePath, bilingual])
  const translationCancelledRef = useRef(false)
  /** Abort handle for the in-flight whole-file run; `cancelTranslation` trips it. */
  const translationAbortRef = useRef<AbortController | null>(null)

  useEffect(() => {
    const openEmbeddedTranslation = (event: Event) => {
      const detail = (
        event as CustomEvent<{
          scope?: 'selection' | 'document'
          sourceLanguage?: string
          targetLanguage?: string
          preserveFormatting?: boolean
          memoryEnabled?: boolean
          qualityCheck?: boolean
          glossaryCategory?: string
          bilingual?: boolean
        }>
      ).detail
      setTranslateScope(detail.scope || 'selection')
      setSourceLang(detail.sourceLanguage?.trim() || 'auto')
      if (detail.targetLanguage?.trim()) setTargetLang(detail.targetLanguage.trim())
      setPreserveFormat(detail.preserveFormatting !== false)
      setMemoryEnabled(detail.memoryEnabled !== false)
      setQualityCheck(detail.qualityCheck !== false)
      setGlossaryCategory(detail.glossaryCategory?.trim() || 'general')
      setBilingual(detail.bilingual === true)
      setTranslateError(null)
      setDocumentTranslationUnits([])
      setDocumentTranslationQuality(undefined)
      setTranslateOpen(true)
    }
    window.addEventListener('dataflare:open-translate', openEmbeddedTranslation)
    const onCancelEmbeddedTranslation = () => cancelTranslation()
    window.addEventListener('dataflare:cancel-translation', onCancelEmbeddedTranslation)
    return () => {
      window.removeEventListener('dataflare:open-translate', openEmbeddedTranslation)
      window.removeEventListener('dataflare:cancel-translation', onCancelEmbeddedTranslation)
    }
  }, [])
  const [targetLang, setTargetLang] = useState<string>(() => {
    // UI language → BCP-47 (best effort)
    const map: Record<string, string> = {
      zh: 'zh-CN',
      'zh-TW': 'zh-TW',
      en: 'en-US',
      ja: 'ja-JP',
      ko: 'ko-KR',
      fr: 'fr-FR',
      de: 'de-DE',
      es: 'es-ES',
      it: 'it-IT',
      pt: 'pt-PT',
      ru: 'ru-RU',
      ar: 'ar-SA',
      hi: 'hi-IN',
      th: 'th-TH',
      id: 'id-ID',
      ms: 'ms-MY',
      nl: 'nl-NL',
      pl: 'pl-PL',
      cs: 'cs-CZ',
      he: 'he-IL',
    }
    return map[lang] ?? 'en-US'
  })
  const [sourceLang, setSourceLang] = useState<string>('auto')
  const [preserveFormat, setPreserveFormat] = useState<boolean>(true)
  const [memoryEnabled, setMemoryEnabled] = useState<boolean>(true)
  const [qualityCheck, setQualityCheck] = useState<boolean>(true)
  const [glossaryCategory, setGlossaryCategory] = useState<string>('general')
  const [lastChangePlan, setLastChangePlan] = useState<
    import('@genoffice/chat-runtime/types').ChatChangePlan | null
  >(null)

  const getSelectionAnchorRect = useCallback((): AiInlineLauncherAnchorRect | null => {
    const ed = editor
    if (!ed || ed.state.selection.empty) return null
    const view = ed.view
    const from = view.coordsAtPos(ed.state.selection.from)
    const to = view.coordsAtPos(ed.state.selection.to)
    return {
      left: Math.min(from.left, to.left),
      top: Math.min(from.top, to.top),
      right: Math.max(from.right, to.right),
      bottom: Math.max(from.bottom, to.bottom),
      viewTop: 0,
      viewBottom: window.innerHeight,
    }
  }, [editor])

  const inlineLauncherStrings: AiInlineLauncherStrings = useMemo(
    () => ({
      title: t('aiInlineLauncherTitle'),
      polish: t('aiInlineLauncherPolish'),
      expand: t('aiInlineLauncherExpand'),
      shorten: t('aiInlineLauncherShorten'),
      summarize: t('aiInlineLauncherSummarize'),
      translate: t('aiInlineLauncherTranslate'),
    }),
    [t],
  )

  const TRANSLATE_LANGS: TranslateLanguageOption[] = useMemo(
    () => [
      { value: 'zh-CN', label: '简体中文' },
      { value: 'zh-TW', label: '繁體中文' },
      { value: 'en-US', label: 'English' },
      { value: 'ja-JP', label: '日本語' },
      { value: 'ko-KR', label: '한국어' },
      { value: 'fr-FR', label: 'Français' },
      { value: 'de-DE', label: 'Deutsch' },
      { value: 'es-ES', label: 'Español' },
      { value: 'it-IT', label: 'Italiano' },
      { value: 'pt-PT', label: 'Português' },
      { value: 'ru-RU', label: 'Русский' },
      { value: 'ar-SA', label: 'العربية' },
      { value: 'hi-IN', label: 'हिन्दी' },
      { value: 'th-TH', label: 'ไทย' },
    ],
    [],
  )

  const translationStorageStrings = useMemo(
    () => ({
      title: t('aiGlossaryPanelTitle'),
      glossaryTab: t('aiGlossaryTab'),
      memoryTab: t('aiMemoryTab'),
      sourceTerm: t('aiGlossarySource'),
      targetTerm: t('aiGlossaryTarget'),
      add: t('aiGlossaryAdd'),
      remove: t('aiGlossaryRemove'),
      close: t('ribbonClose'),
      emptyGlossary: t('aiGlossaryEmpty'),
      emptyMemory: t('aiMemoryEmpty'),
      scopeShared: t('aiScopeShared'),
      scopeSpace: t('aiScopeSpace'),
      loading: t('aiThinking'),
      retry: t('aiGlossaryRetry'),
      unavailable: t('aiStorageUnavailable'),
    }),
    [],
  )

  const translateDialogStrings: TranslateDialogStrings = useMemo(
    () => ({
      title: t('aiTranslateDialogTitle'),
      targetLang: t('aiTranslateTargetLang'),
      sourceLang: t('aiTranslateSourceLang'),
      preserveFormat: t('aiTranslatePreserveFormat'),
      bilingual: t('aiTranslateBilingual'),
      saveTarget: t('aiTranslateSaveTarget'),
      saveTargetOverwrite: t('aiTranslateSaveOverwrite'),
      saveTargetCopy: t('aiTranslateSaveCopy'),
      saveTargetCopyHint: t('aiTranslateSaveCopyHint'),
      swapLanguages: t('aiTranslateSwapLanguages'),
      start: t('aiTranslateStart'),
      apply: t('aiTranslateApply'),
      original: t('aiTranslateOriginal'),
      translated: t('aiTranslateTranslated'),
      previewTitle: t('aiTranslatePreviewTitle'),
      previewLoading: t('aiTranslatePreviewLoading'),
      // 曾经这里是硬编码的 `'Cancel'`：中文界面里「取消」按钮显示成 Cancel，
      // 旁边其它按钮全是中文，一眼就是漏网的。跟 save-memory 那几条一起归位。
      cancel: t('aiTranslateCancel'),
      saveMemory: t('aiTranslateSaveMemory'),
      savingMemory: t('aiTranslateSavingMemory'),
      memorySavedCount: t('aiTranslateMemorySavedCount'),
      memorySaved: t('aiTranslateMemorySaved'),
      unsupported: t('aiTranslateUnsupported'),
    }),
    [t],
  )

  const handleInlinePick = useCallback(
    (action: 'polish' | 'expand' | 'shorten' | 'summarize' | 'translate') => {
      if (action === 'translate') {
        setTranslateError(null)
        setTranslateOpen(true)
        return
      }
      // For other actions, pre-fill the composer with the relevant prompt (existing behavior).
      const map: Record<string, string> = {
        polish: 'aiPolishSelectionPrompt',
        expand: 'aiExpandPrompt',
        shorten: 'aiShortenPrompt',
        summarize: 'aiSummarizeSelectionPrompt',
      }
      const key = map[action]
      const prompt = key ? t(key as Parameters<typeof t>[0]) : ''
      if (prompt) setInput(prompt)
      inputRef.current?.focus()
    },
    [t, setInput],
  )

  const runTranslate = useCallback(async (): Promise<string | null> => {
    const sourceText =
      translateScope === 'document'
        ? editor.state.doc.textBetween(1, editor.state.doc.content.size, '\n', ' ').trim()
        : selectionText
    if (!sourceText) return null
    setTranslateError(null)
    translationCancelledRef.current = false
    try {
      if (translateScope === 'document') {
        const units = extractDocumentUnits(editor)
        if (units.length === 0) return null
        const abort = new AbortController()
        translationAbortRef.current?.abort()
        translationAbortRef.current = abort
        // Preview rows accumulate as units settle, so the dialog fills in while
        // the run is still going instead of appearing all at once at the end.
        const preview = new Map<string, (typeof documentTranslationUnits)[number]>()
        const run = await translateDocument(
          {
            units,
            sourceLang,
            targetLang,
            preserveFormat,
            memoryEnabled,
            qualityCheck,
            glossaryCategory,
            scene: 'document',
            applyMode: bilingual ? 'bilingual' : 'replace',
          },
          {
            // The renderer never imports the provider: it reaches it through
            // `window.desktop` (Electron IPC or the Dataflare bridge), and that
            // is also where the space-scoped glossary / memory get injected.
            translateBatch: (request, signal, onUnit) => {
              const call = window.desktop.aiTranslateBatchStream ?? window.desktop.aiTranslateBatch
              return call(request, { onUnit, signal })
            },
            signal: abort.signal,
            // Write-back is the dialog's Apply step, not the translate step — the
            // user reviews each unit first. So `apply` is intentionally a no-op
            // and `TranslateDocumentResult.applied` does not decide success here.
            apply: () => {},
            onProgress: (event) => {
              if (event.unit) {
                const source = units.find((unit) => unit.unitId === event.unit!.unitId)
                if (source) {
                  preview.set(source.unitId, {
                    id: source.unitId,
                    kind: source.kind,
                    order: source.order,
                    sourceText: source.sourceText,
                    translatedText: event.unit.translatedText,
                    status: narrowUnitStatus(event.unit.status),
                    matchedTerms: event.unit.matchedTerms,
                    warnings: event.unit.warnings,
                    range: documentRange(event.unit.range ?? source.range),
                  })
                  setDocumentTranslationUnits(
                    [...preview.values()].sort((left, right) => left.order - right.order),
                  )
                }
              }
              if (event.quality) setDocumentTranslationQuality(event.quality)
              // 翻译步的 `completed` **不**转发给宿主。
              //
              // `translateDocument` 在这一层就把 `apply` 接成了空实现（写回是弹窗的
              // 「应用译文」那一步，用户要先逐段看过），所以它报的 `completed` 意思是
              // 「译文都算出来了」，不是「译文已经进文档 / 已经落盘」。原样转发时宿主
              // 顶部进度条会在用户**还没点应用**时就跳到 100% 并显示「翻译完成」——
              // 真机实测：进度条「翻译完成 100%」，而文档一个字没变、云盘也没有副本，
              // 那一刻两个后端日志里都没有任何保存记录。
              //
              // 终态改由下面的 `applyTranslate` 在真正写完之后发。
              if (event.status === 'completed') return
              postToEmbedParent({
                type: 'ai-progress',
                status: event.status,
                progress: event.progress,
                completedUnits: event.completedUnits,
                totalUnits: event.totalUnits,
                unit: event.unit,
                quality: event.quality,
                error: event.error,
              })
            },
          },
        )
        translationAbortRef.current = null
        if (run.status === 'cancelled') return null
        if (run.status === 'failed') {
          setTranslateError(run.error ?? 'Document translation failed')
          throw new Error(run.error ?? 'Document translation failed')
        }
        setDocumentTranslationUnits(
          run.units.map((unit) => ({
            id: unit.unitId,
            kind: unit.kind,
            order: unit.order,
            sourceText: unit.sourceText,
            translatedText: unit.translatedText,
            status: narrowUnitStatus(unit.status),
            matchedTerms: unit.matchedTerms,
            warnings: unit.warnings,
            range: documentRange(unit.range),
          })),
        )
        setDocumentTranslationQuality(run.quality)
        return run.units.map((unit) => unit.translatedText).join('\n')
      }
      const res = await window.desktop.aiTranslate({
        instruction: sourceText,
        sourceLang,
        targetLang,
        preserveFormat,
        range: { from: liveSelection.from, to: liveSelection.to, scope: 'selection' },
        memoryEnabled,
        qualityCheck,
        glossaryCategory,
      })
      const r = res as { ok?: boolean; translated?: string; error?: string }
      if (!r?.ok) {
        const err = r?.error ?? 'Translation failed'
        setTranslateError(err)
        // throw so the dialog's catch branch surfaces the real provider error
        throw new Error(err)
      }
      return r.translated ?? ''
    } catch (e) {
      const err = e instanceof Error ? e.message : String(e)
      if (translationCancelledRef.current) return null
      setTranslateError(err)
      if (translateScope === 'document')
        postToEmbedParent({ type: 'ai-progress', status: 'failed', progress: 0 })
      // re-throw so TranslateDialog catches and shows the real provider error
      throw e
    }
  }, [
    editor,
    selectionText,
    sourceLang,
    targetLang,
    preserveFormat,
    liveSelection,
    translateScope,
    documentTranslationUnits,
    bilingual,
  ])

  const cancelTranslation = useCallback(() => {
    translationCancelledRef.current = true
    // Trip the shared pipeline's abort handle: without this the in-flight
    // batch keeps settling and the run reports `completed` after the user
    // already stopped it.
    translationAbortRef.current?.abort()
    setTranslateOpen(false)
    postToEmbedParent({ type: 'ai-progress', status: 'cancelled', progress: 0 })
  }, [])

  const retryDocumentUnit = useCallback(
    async (unitId: string) => {
      const unit = documentTranslationUnits.find((candidate) => candidate.id === unitId)
      if (!unit) throw new Error('Translation unit is no longer available')
      const streamOrBatch = window.desktop.aiTranslateBatchStream ?? window.desktop.aiTranslateBatch
      const result = await streamOrBatch({
        units: [
          {
            unitId: unit.id,
            kind: unit.kind,
            sourceText: unit.sourceText,
            order: unit.order,
            range: unit.range,
          },
        ],
        sourceLang,
        targetLang,
        preserveFormat,
        scene: 'document',
        memoryEnabled,
        qualityCheck,
        glossaryCategory,
      })
      const next = result.units?.[0]
      if (!result.ok || !next?.translatedText)
        throw new Error(next?.errorMessage || result.error || 'Translation retry failed')
      setDocumentTranslationUnits((current) =>
        current.map((candidate) =>
          candidate.id === unitId
            ? {
                ...candidate,
                translatedText: next.translatedText,
                status: next.status,
                matchedTerms: next.matchedTerms,
                warnings: next.warnings,
              }
            : candidate,
        ),
      )
    },
    [documentTranslationUnits, sourceLang, targetLang, preserveFormat],
  )

  const saveTranslationMemory = useCallback(
    async (request: {
      sourceLang: string
      targetLang: string
      units: Array<{ unitId: string; sourceText: string; translatedText: string }>
    }) => {
      const result = await window.desktop.saveTranslationMemory({
        requestId: `memory-${Date.now().toString(36)}`,
        documentId: undefined,
        scene: translateScope,
        sourceLang: request.sourceLang,
        targetLang: request.targetLang,
        // The glossary the panel is translating under has to travel with the
        // entry. Saving it unscoped made one customer's sentence a cache hit
        // for every other customer on the next run — the same cross-customer
        // leak the reader-side bucket key was added to prevent.
        ...(glossaryCategory ? { glossaryCategory } : {}),
        units: request.units,
      })
      if (!result.ok) throw new Error(result.error || 'Failed to save translation memory')
      return { savedCount: result.savedCount, skippedCount: result.skippedCount }
    },
    [translateScope, glossaryCategory],
  )

  type TranslationItem = {
    sourceText: string
    targetText: string
    targetLang: string
    preserveFormat?: boolean
    range?: { from: number; to: number; scope?: string } | null
    applyMode?: 'replace' | 'bilingual'
  }

  /**
   * Full node ranges of every text block, in document order.
   *
   * Bilingual undo works off this instead of a recorded offset: after a
   * bilingual apply the source paragraphs are untouched, so a source range
   * still identifies its own block, and the translation is simply the next
   * block. Re-deriving beats remembering — every insert shifts everything
   * after it, so a stored post-insert offset is wrong the moment the user
   * types.
   */
  const textBlockSpans = (ed: Editor): Array<{ from: number; to: number; text: string }> => {
    const spans: Array<{ from: number; to: number; text: string }> = []
    ed.state.doc.descendants((node, pos) => {
      if (!node.isTextblock) return true
      spans.push({
        from: pos + 1,
        to: pos + 1 + node.content.size,
        text: node.textContent,
      })
      return true
    })
    return spans
  }

  const applyTranslateImpl = useCallback(
    async (
      plan: import('@genoffice/chat-runtime/types').ChatChangePlan,
      _targetText: string,
      applySaveTarget?: 'overwrite' | 'copy',
    ) => {
      const op = plan.ops[0]
      if (op?.kind !== 'translate') return
      const item = op.ops[0]
      if (!item) return
      const ed = editor
      if (!ed) return
      // The plan stamps the range captured at translate-time (see TranslateDialog);
      // we deliberately don't read `liveSelection` here — by the time the user
      // hits Apply the selection may have wandered to a different paragraph.
      const items: TranslationItem[] = op.ops as TranslationItem[]
      const bilingual = items.some((entry) => entry.applyMode === 'bilingual')
      // Descending order is mandatory for both modes: every write shifts every
      // later position, so applying in document order corrupts the rest.
      const orderedItems = [...items].sort((a, b) => (b.range?.from || 0) - (a.range?.from || 0))
      const appliedItems = orderedItems.filter((entry) => entry.range && entry.targetText)
      // 少写一条就等于这一段还是原文，而用户看到的是「翻译完成」。真机实测就是
      // 文档最后一段没拿到 range，被这里静默过滤掉了。宁可报错也不要假装成功。
      if (appliedItems.length < items.length) {
        throw new Error(
          `有 ${items.length - appliedItems.length}/${items.length} 段译文缺少可写入的位置信息（通常是文档最后一段），已中止写入以免产出半译文。`,
        )
      }
      if (appliedItems.length === 0) {
        // 曾经这里是裸 `return`：一条都写不进去时，点了「应用译文」既不改文档、
        // 也不关弹窗、也没有任何提示，宿主进度条就一直挂在「翻译中」。
        throw new Error(
          `没有可写入的译文段落（共 ${items.length} 条计划，其中缺 range 或译文的 ${items.length - appliedItems.length} 条）。请重新翻译后再应用。`,
        )
      }
      for (const entry of appliedItems) {
        const currentText = ed.state.doc.textBetween(
          entry.range!.from,
          entry.range!.to,
          '\n',
          '\ufffc',
        )
        if (currentText !== entry.sourceText) {
          throw new Error('文档内容已发生变化，请重新翻译后再应用')
        }
      }
      // 逐条提交，每条写完立刻重取文档坐标。
      //
      // 曾经这里是「攒一个 chain 连做 N 次 insertContentAt 再 run()」，看着等价，
      // 实测在 4 段文档上**只有 1 段译文真的落进文档**：同一条事务里反复按同一份
      // 事务前坐标插入，后写的会吞掉先写的。而 `lastChangePlan` 仍按 N 条记账 ——
      // 用户按一次撤销退不回去，说的和做的对不上，比「少翻几段」更难解释。
      //
      // 降序（从文末往文首）保证「先插的靠后」不会挪动「后插的靠前」的坐标；
      // 每次重取 `doc.content.size` 再夹一次范围，去掉对事务前长度的依赖。
      // 代价是 undo 变成多步 —— 可接受，正确性优先。
      const written: TranslationItem[] = []
      for (const entry of appliedItems) {
        const size = ed.state.doc.content.size
        if (bilingual) {
          // 译文必须是**独立段落**，且必须真的插进去。
          //
          // 两个坑都踩过：
          //  1. 原来插 `'\n\n' + 文本` —— 段落内部的换行只是文本节点里的换行符，
          //     不会 split 块，译文被塞进原文那一段的末尾（真机实测渲染成同一个
          //     `<p>`）。要独立段落就得插 paragraph **节点**。
          //  2. **节点名不是 `paragraph`。** docs 编辑器的段落节点叫 `docParagraph`
          //     （`editor/extensions.ts`），Tiptap 报的错很直白：
          //     `RangeError: Unknown node type: paragraph`。而 Tiptap 对无法解析的
          //     content 只打一条 warn 就**跳过**，不抛 —— 于是 4 段译文一段都没进去，
          //     `lastChangePlan` 却仍按 4 条记账，「翻译完成」照常上报。
          //  3. 位置用 `range.to`（段落**内部**末尾），由 Tiptap 负责 split 成两个块。
          //     曾经试过 `to + 1`（下一段开头），对中间段落没问题，但**文档最后一段**
          //     的 `to + 1` 正好等于 doc 末尾，块节点插不进去 —— 真机实测 4 段里
          //     最后一段的译文永远丢失，而界面报「翻译完成」。夹到 `size - 1` 是为了
          //     再兜一层，保证落在合法位置内。
          const at = Math.max(1, Math.min(entry.range!.to, Math.max(1, size - 1)))
          ed.chain()
            .focus()
            .insertContentAt(at, { type: 'docParagraph', content: [{ type: 'text', text: entry.targetText }] })
            .run()
        } else {
          const from = Math.max(1, Math.min(entry.range!.from, size))
          const to = Math.max(from, Math.min(entry.range!.to, size))
          ed.chain().focus().insertContentAt({ from, to }, entry.targetText).run()
        }
        written.push(entry)
      }
      // 应用后回读校验：译文没真正进文档就必须说出来，而且**弹窗要留着**。
      //
      // 之前这条 setTranslateError 写在 setTranslateOpen(false) 前面，等于设完
      // 立刻把弹窗关掉 —— 错误提示一起消失，用户只看到宿主进度条上的「翻译完成」。
      // 「静默少应用」是最糟的结局：导出的文件少了一半译文，而界面上一切正常。
      const finalText = ed.state.doc.textBetween(0, ed.state.doc.content.size, '\n', '\ufffc')
      const missing = written.filter((entry) => !finalText.includes(entry.targetText))
      if (missing.length > 0) {
        // 计划里只记真正写进去的那些，撤销才对得上；失败信息抛给弹窗渲染。
        setLastChangePlan({
          ...plan,
          ops: [{ kind: 'translate', description: op.description, ops: written.filter((e) => !missing.includes(e)) }],
        })
        throw new Error(
          `有 ${missing.length}/${written.length} 段译文未能写入文档（已写入 ${written.length - missing.length} 段）。请撤销后重试，或改用「覆盖当前文件」保存方式。`,
        )
      }
      setLastChangePlan({
        ...plan,
        ops: [{ kind: 'translate', description: op.description, ops: written }],
      })
      setTranslateOpen(false)
      // 覆盖模式：译文已经写进当前文档，这就是终点。宿主进度条需要一个终态 ——
      // 翻译步的 `completed` 已经被有意压掉（那时还没写），所以这里补上。
      // 副本模式由下面的 onSaveTranslatedCopy 分支负责报，不在这里报两次。
      if (applySaveTarget !== 'copy') {
        postToEmbedParent({ type: 'ai-progress', status: 'completed', progress: 1 })
      }
      // 另存副本：写的是**另一个**云盘条目，所以这里刻意不动 `doc.filePath`、
      // 不清 dirty —— 详见 file-actions 的翻译副本分支注释。原文仍留在云盘里。
      if (applySaveTarget === 'copy' && translatedFileName && onSaveTranslatedCopy) {
        postToEmbedParent({
          type: 'ai-progress',
          status: 'running',
          progress: 1,
        })
        const ok = await onSaveTranslatedCopy(translatedFileName)
        // 失败文案由 file-actions 的状态栏 + toast 负责，这里只把结果回给宿主
        // 面板（DriveOfficeView 的进度条）。两处各弹一次会让用户以为出了两次错。
        postToEmbedParent({
          type: 'ai-progress',
          status: ok ? 'completed' : 'failed',
          progress: 1,
        })
      }
    },
    [editor, onSaveTranslatedCopy, translatedFileName],
  )

  /**
   * 「应用译文」的对外入口。
   *
   * 内层跑真正的写回；这里只做一件事：**把失败同时告诉宿主**。写回失败时弹窗会
   * 显示红字（TranslateDialog 现在 await 了这个 Promise），但宿主顶部进度条是
   * 独立的一条 —— 不发 `ai-progress: failed` 的话它会永远停在「翻译中…」，
   * 用户在两个界面里看到互相矛盾的状态。
   */
  const applyTranslate = useCallback(
    async (
      plan: import('@genoffice/chat-runtime/types').ChatChangePlan,
      targetText: string,
      applySaveTarget?: 'overwrite' | 'copy',
    ) => {
      try {
        await applyTranslateImpl(plan, targetText, applySaveTarget)
      } catch (err) {
        const message = err instanceof Error ? err.message : String(err)
        setTranslateError(message)
        postToEmbedParent({ type: 'ai-progress', status: 'failed', progress: 0, error: message })
        throw err
      }
    },
    [applyTranslateImpl],
  )

  const undoChange = useCallback(
    (p: import('@genoffice/chat-runtime/types').ChatChangePlan) => {
      const op = p.ops[0]
      if (op?.kind !== 'translate') return
      const items = op.ops
      if (!items.length) return
      const ed = editor
      if (!ed) return
      const isBilingual = items.some((item) => (item as TranslationItem).applyMode === 'bilingual')
      if (isBilingual) {
        // Bilingual undo is a *delete*, not a rewrite. Rewriting `[from, from+len)`
        // back to the source would append a second copy of every source
        // paragraph — the source was never removed in the first place.
        const spans = textBlockSpans(ed)
        let chain = ed.chain().focus()
        for (const item of [...items].sort((a, b) => (b.range?.from || 0) - (a.range?.from || 0))) {
          const source = (item as TranslationItem).range
          if (!source) continue
          const index = spans.findIndex((span) => span.from === source.from && span.text === (item as TranslationItem).sourceText)
          if (index < 0) continue
          const next = spans[index + 1]
          // Only remove it if it really is the translation we inserted; a
          // mismatched next block means the document changed under us and
          // deleting it would eat the user's own text.
          if (!next || next.text !== (item as TranslationItem).targetText) continue
          const from = next.from - 1
          const to = from + 1 + next.text.length
          chain = chain.insertContentAt({ from, to }, '')
        }
        chain.run()
        setLastChangePlan(null)
        return
      }
      // True restore: rewrite the translated range back to the original source text.
      // The plan-stamped range points at the post-translate span (since apply
      // kept it untouched in the op). Fall back to live selection if missing.
      const docSize = ed.state.doc.content.size
      let chain = ed.chain().focus()
      for (const item of [...items].sort((a, b) => (b.range?.from || 0) - (a.range?.from || 0))) {
        const from = Math.max(1, Math.min(item.range?.from ?? 1, docSize))
        const to = Math.max(from, Math.min(from + item.targetText.length, docSize))
        if (from !== to) chain = chain.insertContentAt({ from, to }, item.sourceText)
      }
      chain.run()
      setLastChangePlan(null)
    },
    [editor],
  )

  /** the × on the scope chip: collapse the selection so the run targets the whole document */
  const clearScopeSelection = () => {
    editor.commands.setTextSelection(editor.state.selection.to)
  }

  const selectionScopeQuote = (): AiScopeQuoteData | undefined => {
    const { from, to, empty } = editor.state.selection
    if (empty) return undefined
    const text = editor.state.doc.textBetween(from, to, ' ', ' ').replace(/\s+/g, ' ').trim()
    if (!text) return undefined
    return {
      label: t('aiScopeSelection', { words: countWords(text) }),
      text: text.length > SCOPE_TEXT_MAX ? `${text.slice(0, SCOPE_TEXT_MAX)}…` : text,
    }
  }

  // the frozen-range highlight ends with the run, or as soon as the editor is focused again
  useEffect(() => {
    if (!busy) setInactiveSelectionShown(editor, false)
  }, [busy, editor])
  useEffect(() => {
    const off = () => setInactiveSelectionShown(editor, false)
    editor.on('focus', off)
    return () => {
      editor.off('focus', off)
    }
  }, [editor])

  /** [label](docnav://block/N) links in replies select and scroll to that block */
  const docNav = {
    scheme: DOC_NAV_SCHEME,
    onNavigate: (href: string) => {
      const index = parseDocNavHref(href)
      if (index !== null) navigateToBlock(editorRef.current, index)
    },
  }

  // follow the stream, but stop yanking once the user scrolls up to read;
  // `open` dep: re-expanding lands on messages streamed while collapsed
  useEffect(() => {
    if (stickToBottomRef.current) {
      logRef.current?.scrollTo({ top: logRef.current.scrollHeight })
    }
  }, [chat, open])

  const onLogScroll = () => {
    const el = logRef.current
    if (!el) return
    stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < 48
  }

  const run = () => runWith(input.trim())

  /** Image attachments are read as base64 and go multimodal with this user message (≤5MB per image, max 20) */
  const MAX_IMAGES_PER_MESSAGE = 20
  const collectImageAttachments = async (atts: AttachmentMeta[]): Promise<AgentImage[]> => {
    const imageAtts = atts.filter((a) => ATTACHMENT_IMAGE_EXTS.has(a.ext))
    const images: AgentImage[] = []
    const failures: string[] = []
    for (const att of imageAtts.slice(0, MAX_IMAGES_PER_MESSAGE)) {
      const result = await window.desktop.readAttachmentImage(att.path)
      if (result.ok && result.base64 && result.mime) {
        images.push({ base64: result.base64, mime: result.mime })
      } else {
        failures.push(result.error ?? t('aiImageReadFail', { name: att.name }))
      }
    }
    if (imageAtts.length > MAX_IMAGES_PER_MESSAGE) {
      failures.push(t('aiTooManyImages', { max: MAX_IMAGES_PER_MESSAGE }))
    }
    if (failures.length > 0) {
      setAttachNotice(failures.join(';'))
      window.setTimeout(() => setAttachNotice(null), 5000)
    }
    return images
  }

  const runWith = (
    instruction: string,
    displayInstruction = instruction,
    attachmentsOverride?: AttachmentMeta[],
    /** null = a retry that had no scope; undefined = capture the live selection */
    retryScope?: AiScopeQuoteData | null,
  ) => {
    const loop = loopRef.current
    if (!instruction || !loop || loop.busy || pendingSendRef.current) return
    setInput('')
    // The message consumes the composer attachments: they ride along (echoed on the
    // bubble, images multimodal, files via the files skill) and the composer clears.
    const sentAtts = attachmentsOverride ?? attachmentsRef.current
    if (!attachmentsOverride && sentAtts.length > 0) {
      const seen = new Set(sentAttachmentsRef.current.map((a) => a.path))
      sentAttachmentsRef.current = [
        ...sentAttachmentsRef.current,
        ...sentAtts.filter((a) => !seen.has(a.path)),
      ]
      setAttachments([])
    }
    lastAttachmentsRef.current = sentAtts
    // the queue batch and the continue action carry their own display text: no selection quote
    const scope =
      retryScope !== undefined
        ? (retryScope ?? undefined)
        : displayInstruction === instruction
          ? selectionScopeQuote()
          : undefined
    lastScopeRef.current = scope
    // the popover input / composer own the DOM selection now: keep the targeted range visible until the run ends
    if (scope) setInactiveSelectionShown(editor, true)
    instructionRef.current = instruction
    lastInstructionRef.current = instruction
    runToolsRef.current = []
    runSnapshotRef.current = null
    stickToBottomRef.current = true
    resetSharedTimeline()
    setSharedRunStatus('running')
    setChat((prev) => [
      ...prev,
      {
        role: 'user',
        text: displayInstruction,
        ...(sentAtts.length > 0 ? { attachments: sentAtts } : {}),
        ...(scope ? { scope } : {}),
      },
      { role: 'assistant', text: '', streaming: true },
    ])
    runStartedAtRef.current = Date.now()
    setBusy(true)
    // claimed before the async image read so Stop / New chat can flag this send at any point
    const generation = currentDocGeneration()
    const pending = { aborted: false }
    pendingSendRef.current = pending
    persistMessage('user', instruction, undefined, sentAtts, scope)
    // a rejected image read must not strand the run (busy would stay true forever): degrade to a no-image send
    void collectImageAttachments(sentAtts)
      .catch((): AgentImage[] => {
        setAttachNotice(t('aiImagesSendFailed'))
        window.setTimeout(() => setAttachNotice(null), 5000)
        return []
      })
      // a phased open still streaming its tail: the context must describe the whole document
      .then(async (images) => {
        await waitForFullContent()
        // a newer send (after New chat) owns the panel now: leave its state alone
        if (pendingSendRef.current !== pending) return
        pendingSendRef.current = null
        // the wait ended because another document replaced this one, or the
        // user stopped / reset the chat meanwhile: nothing to run
        if (pending.aborted || currentDocGeneration() !== generation) {
          setChat((prev) =>
            prev.filter(
              (m, i) => !(i === prev.length - 1 && m.role === 'assistant' && m.streaming),
            ),
          )
          setBusy(false)
          return
        }
        return loop.run(instruction, images)
      })
  }

  const cancel = () => {
    if (pendingSendRef.current) pendingSendRef.current.aborted = true
    loopRef.current?.cancel()
  }

  /** submit every still-anchored queued edit as one batch run */
  const sendQueue = () => {
    const loop = loopRef.current
    if (!loop || loop.busy || editQueue.length === 0) return
    const entries = liveItems(resolveQueue(editorRef.current, editQueue))
    if (entries.length === 0) {
      onQueueClear?.()
      return
    }
    const instruction = buildQueueInstruction(entries)
    const display = buildQueueSummary(t('aiQueueSubmitted', { count: entries.length }), entries)
    // consumed at send: the run rewrites the anchored passages, which would
    // orphan the anchors anyway; a failed run is retried via the retry action
    onQueueConsume?.(editQueue.map((item) => item.qid))
    runWith(instruction, display)
  }

  const retry = () =>
    runWith(
      lastInstructionRef.current,
      lastInstructionRef.current,
      lastAttachmentsRef.current,
      lastScopeRef.current ?? null,
    )

  const continueRun = () => runWith(DOCS_CONTINUE_INSTRUCTION, t('aiContinue'))

  const newChat = () => {
    if (pendingSendRef.current) {
      pendingSendRef.current.aborted = true
      pendingSendRef.current = null
    }
    abandonWriter()
    loopRef.current?.reset()
    setBusy(false)
    setChat([])
    // Restored history is painted above the live turn: without this the
    // previous conversation survives "New chat" on screen (#195).
    setHistoricChat([])
    // Unsent composer attachments would otherwise ride into the next chat's
    // file context (availableAttachments merges sent + live). The typed
    // draft itself is kept — only staged files are dropped.
    setAttachments([])
    setAttachNotice(null)
    sentAttachmentsRef.current = []
    inputRef.current?.focus()
  }

  const copyMessage = (text: string, idx: number) => {
    void navigator.clipboard.writeText(text)
    setCopiedIdx(idx)
    window.setTimeout(() => setCopiedIdx((cur) => (cur === idx ? null : cur)), 1200)
  }

  const mergeAttachments = (result: AttachmentAddResult | null) => {
    if (!result) return
    if (result.accepted.length > 0) {
      setAttachments((prev) => {
        const seen = new Set(prev.map((a) => a.path))
        return [...prev, ...result.accepted.filter((a) => !seen.has(a.path))]
      })
    }
    if (result.rejected.length > 0) {
      setAttachNotice(result.rejected.join(';'))
      window.setTimeout(() => setAttachNotice(null), 5000)
    }
  }

  const pickAttachments = async () => mergeAttachments(await window.desktop.pickAttachments())

  const onDrop = async (e: React.DragEvent) => {
    e.preventDefault()
    e.stopPropagation()
    setDragOver(false)
    const paths = Array.from(e.dataTransfer.files)
      .map((f) => window.desktop.getPathForFile(f))
      .filter(Boolean)
    if (paths.length > 0) mergeAttachments(await window.desktop.addAttachmentPaths(paths))
  }

  /** Files pasted into the input: ones with a local path go through regular attachments; pure bitmaps like screenshots hit a temp file first */
  const onPasteFiles = async (files: File[]) => {
    const paths: string[] = []
    for (const f of files) {
      const p = window.desktop.getPathForFile(f)
      if (p) {
        paths.push(p)
        continue
      }
      const ext = PASTE_MIME_EXT[f.type] ?? f.name.split('.').pop()?.toLowerCase() ?? 'bin'
      mergeAttachments(await window.desktop.addPastedImage(await f.arrayBuffer(), ext))
    }
    if (paths.length > 0) mergeAttachments(await window.desktop.addAttachmentPaths(paths))
  }

  const removeAttachment = (path: string) =>
    setAttachments((prev) => prev.filter((a) => a.path !== path))

  const acceptChanges = () => {
    applyRevisionsBy(editorRef.current, AI_REVISION_AUTHOR, 'accept')
    clearAiHighlights()
  }

  const toggleTrackChanges = () => {
    const next = !trackChanges
    setTrackChanges(next)
    localStorage.setItem(TRACK_CHANGES_KEY, next ? '1' : '0')
    // switching off keeps nothing pending: accept whatever is still highlighted
    if (!next) acceptChanges()
  }

  const rollback = (entryIdx: number, snapshot: PmNode) => {
    editor
      .chain()
      .setMeta(TABLE_TRAILING_SKIP, true)
      .setContent(snapshot as never)
      .run()
    // The document rewound to before this turn, so this and every later
    // rollback point now describe discarded futures
    setChat((prev) =>
      prev.map((e, i) => (i >= entryIdx && e.snapshot ? { ...e, snapshot: undefined } : e)),
    )
  }

  const resizeCleanupRef = useRef<(() => void) | null>(null)
  useEffect(() => () => resizeCleanupRef.current?.(), [])

  /** drag the panel's right edge to resize; panel is flush with the window's left edge */
  const startResize = (e: React.PointerEvent<HTMLDivElement>) => {
    e.preventDefault()
    const resizer = e.currentTarget
    setResizing(true)
    document.body.style.cursor = 'col-resize'
    document.body.style.userSelect = 'none'
    const onMove = (ev: PointerEvent) => {
      const w = clampPanelWidth(ev.clientX)
      preferredWidthRef.current = w
      setPanelWidth(w)
    }
    let done = false
    const cleanup = () => {
      if (done) return
      done = true
      resizeCleanupRef.current = null
      window.removeEventListener('pointermove', onMove)
      window.removeEventListener('pointerup', cleanup)
      window.removeEventListener('pointercancel', cleanup)
      resizer.removeEventListener('lostpointercapture', cleanup)
      document.body.style.cursor = ''
      document.body.style.userSelect = ''
      setResizing(false)
      localStorage.setItem(PANEL_WIDTH_KEY, String(Math.round(preferredWidthRef.current)))
    }
    resizeCleanupRef.current = cleanup
    window.addEventListener('pointermove', onMove)
    window.addEventListener('pointerup', cleanup)
    window.addEventListener('pointercancel', cleanup)
    // lostpointercapture also fires if the resizer is unmounted mid-drag (panel collapse)
    resizer.addEventListener('lostpointercapture', cleanup)
    resizer.setPointerCapture(e.pointerId)
  }

  // collapsed: rail only — after all hooks, so the instance and its state survive
  if (!open) {
    return (
      <button
        className="ai-rail"
        data-tip={t('appExpandAiPanel')}
        aria-label={t('appExpandAiPanel')}
        onClick={onExpand}
      >
        <ProviderMark provider={settingsRef.current.provider} size={22} />
      </button>
    )
  }

  return (
    <aside
      ref={asideRef}
      style={{ width: '100%' }}
      dir={isRtl ? 'rtl' : undefined}
      className={`ai-panel${dragOver ? ' ai-panel-dragover' : ''}${resizing ? ' ai-panel-resizing' : ''}`}
      onDragOver={(e) => {
        if (e.dataTransfer.types.includes('Files')) {
          e.preventDefault()
          e.stopPropagation()
          setDragOver(true)
        }
      }}
      onDragLeave={(e) => {
        if (!e.currentTarget.contains(e.relatedTarget as Node | null)) setDragOver(false)
      }}
      onDrop={onDrop}
    >
      <div
        className="ai-panel-resizer"
        onPointerDown={startResize}
        role="separator"
        aria-orientation="vertical"
        aria-label={t('aiPanelTitle')}
      />
      <div className="ai-panel-header">
        <span className="ai-panel-title">
          <ProviderMark provider={settingsRef.current.provider} size={22} />
          {t('aiPanelTitle')}
        </span>
        <div className="ai-panel-header-actions">
          {(chat.length > 0 || historicChat.length > 0) && (
            <button
              className="ai-header-btn"
              onClick={newChat}
              data-tip={t('aiNewChatTitle')}
              aria-label={t('aiNewChatTitle')}
            >
              <IconNewChat size={16} />
            </button>
          )}
          <button
            className="ai-header-btn"
            onClick={() => setStoragePanelOpen(true)}
            data-tip={t('aiGlossaryPanelTitle')}
            aria-label={t('aiGlossaryPanelTitle')}
          >
            <IconBook size={16} />
          </button>
          {/* Glossary / memory access. Placed after "new chat" on purpose: the
              header's leading button is the conversation reset, and both tests and
              muscle memory reach for the first `.ai-header-btn`. */}
          {onCollapse && (
            <button
              className="ai-header-btn"
              onClick={onCollapse}
              data-tip={t('aiCollapseTitle')}
              aria-label={t('aiCollapseTitle')}
            >
              <IconSidebarCollapse size={15} />
            </button>
          )}
        </div>
      </div>

      <div ref={logRef} className="ai-chat" onScroll={onLogScroll}>
        {/* Shared ChatRuntime components (M4). Additive: existing inline UI stays. */}
        <AiRunHeader
          status={sharedRunStatus}
          model={settingsRef.current.provider}
          onStop={undefined}
        />
        <AiToolTimeline tools={sharedToolTimeline} />
        {sharedRunStatus === 'error' && lastError && (
          <AiErrorRecovery
            error={lastError}
            onEdit={() => inputRef.current?.focus()}
            onDismiss={() => {
              setLastError(null)
              setSharedRunStatus('idle')
            }}
          />
        )}
        {/* past conversation (read-only transcript, not fed to the model), shown continuously with the current turn */}
        {historicChat.length > 0 && (
          <>
            {historicChat.map((entry, i) => (
              <div key={`h${i}`} className={`ai-msg ai-msg-${entry.role} ai-msg-historic`}>
                {entry.role === 'user' && entry.scope && <AiScopeQuote scope={entry.scope} />}
                {entry.role === 'user' && entry.attachments && entry.attachments.length > 0 && (
                  <SentAttachments atts={entry.attachments} previews={attachmentPreviews} />
                )}
                {entry.tools && entry.tools.length > 0 && <ToolChipList tools={entry.tools} />}
                {entry.text && (
                  <div dir="auto">
                    <Markdown text={entry.text} nav={docNav} />
                  </div>
                )}
              </div>
            ))}
            <div className="ai-history-sep">{t('aiHistorySep')}</div>
          </>
        )}
        {chat.length === 0 && historicChat.length === 0 && (
          <div className="ai-chat-empty">
            <div className="ai-chat-empty-title">
              {t(docEmpty ? 'aiEmptyDraftTitle' : 'aiEmptyTitle')}
            </div>
            <div className="ai-chat-empty-body">
              {t(docEmpty ? 'aiEmptyDraftBody1' : 'aiEmptyBody1')}
              <br />
              {t(docEmpty ? 'aiEmptyDraftBody2' : 'aiEmptyBody2')}
            </div>
            <div className="ai-starter-list">
              {(docEmpty ? DRAFT_STARTER_PROMPTS : EDIT_STARTER_PROMPTS).map((p) => (
                <button
                  key={p}
                  className="ai-starter"
                  onClick={() => {
                    setInput(t(p))
                    inputRef.current?.focus()
                  }}
                >
                  {t(p)}
                </button>
              ))}
            </div>
          </div>
        )}
        {chat.map((entry, i) => {
          if (
            entry.role === 'assistant' &&
            !entry.text &&
            !entry.streaming &&
            !entry.error &&
            !entry.tools?.length
          ) {
            return null
          }
          const isLast = i === chat.length - 1
          // Action row appears once per completed reply: on the turn's final segment only
          // (mid-turn segments have a following assistant entry; the live turn ends when !busy)
          const nextEntry = chat[i + 1]
          const turnEnded = nextEntry ? nextEntry.role === 'user' : !busy
          const showToolbar =
            entry.role === 'assistant' &&
            !entry.streaming &&
            turnEnded &&
            // edits-only turns have no text but still carry the rollback point
            !!(entry.text || entry.error || entry.snapshot)
          return (
            <div
              key={i}
              className={`ai-msg ai-msg-${entry.role}${entry.role === 'assistant' && entry.streaming ? ' ai-msg-streaming' : ''}`}
            >
              {entry.role === 'user' && entry.scope && <AiScopeQuote scope={entry.scope} />}
              {entry.role === 'user' && entry.attachments && entry.attachments.length > 0 && (
                <SentAttachments atts={entry.attachments} previews={attachmentPreviews} />
              )}
              {entry.role === 'assistant' && !entry.text && entry.streaming ? (
                <span className="ai-typing-row">
                  <AiTypingIndicator
                    label={entry.tools?.length ? t('aiWorking') : t('aiThinking')}
                  />
                </span>
              ) : entry.role === 'assistant' ? (
                <div dir="auto">
                  <Markdown text={entry.text} nav={docNav} />
                </div>
              ) : (
                <span dir="auto">{entry.text}</span>
              )}
              {entry.tools && entry.tools.length > 0 && <ToolChipList tools={entry.tools} />}
              {entry.error && (
                <div className="ai-msg-error">{t('aiErrorPrefix', { error: entry.error })}</div>
              )}
              {entry.loginRequired && (
                <button className="ai-login-btn" onClick={() => void window.desktop.aiGskLogin()}>
                  {t('aiGskLoginBtn')}
                </button>
              )}
              {showToolbar && (
                <div className="ai-msg-toolbar">
                  {entry.text && (
                    <button
                      className="ai-msg-tool-btn"
                      onClick={() => copyMessage(entry.text, i)}
                      aria-label={t('aiCopyReplyTitle')}
                      data-tip={t('aiCopyReplyTitle')}
                    >
                      {copiedIdx === i ? (
                        <svg
                          width="14"
                          height="14"
                          viewBox="0 0 24 24"
                          fill="none"
                          stroke="currentColor"
                          strokeWidth="1.8"
                          strokeLinecap="round"
                          strokeLinejoin="round"
                        >
                          <polyline points="20 6 9 17 4 12" />
                        </svg>
                      ) : (
                        <svg width="20" height="20" viewBox="0 0 20 20" fill="none">
                          <path
                            d="M14.6113 5.34253C16.0608 5.3428 17.2363 6.518 17.2363 7.96753V15.5066C17.2361 16.956 16.0607 18.1313 14.6113 18.1316H7.07227C5.62267 18.1316 4.44751 16.9561 4.44727 15.5066V7.96753C4.44732 6.51783 5.62255 5.34253 7.07227 5.34253H14.6113ZM7.07227 6.59253C6.31291 6.59253 5.69732 7.20819 5.69727 7.96753V15.5066C5.69751 16.2658 6.31302 16.8816 7.07227 16.8816H14.6113C15.3703 16.8813 15.9861 16.2656 15.9863 15.5066V7.96753C15.9863 7.20835 15.3705 6.5928 14.6113 6.59253H7.07227ZM10.0176 2.8689C10.3626 2.86905 10.6426 3.14882 10.6426 3.4939C10.6425 3.83888 10.3626 4.11874 10.0176 4.1189H4.59961C3.84022 4.1189 3.22461 4.73451 3.22461 5.4939V11.324C3.22433 11.6689 2.94461 11.949 2.59961 11.949C2.25461 11.949 1.97489 11.6689 1.97461 11.324V5.4939C1.97461 4.04415 3.14987 2.8689 4.59961 2.8689H10.0176Z"
                            fill="currentColor"
                          />
                        </svg>
                      )}
                    </button>
                  )}
                  {isLast && !busy && lastInstructionRef.current && (
                    <button
                      className="ai-msg-tool-btn"
                      onClick={retry}
                      aria-label={t('aiRegenerateTitle')}
                      data-tip={t('aiRegenerateTitle')}
                    >
                      {/* 24-canvas glyph at 18px (near-full-bleed paths, sized for optical
                          parity with the copy icon): stroke 1.5 paints 1.125px (1:16) */}
                      <svg
                        style={{ width: 18, height: 18 }}
                        viewBox="0 0 24 24"
                        fill="none"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        strokeLinejoin="round"
                        aria-hidden
                      >
                        <path d="M3.68881 9.85339C4.1791 8.0054 5.28205 6.30704 6.9459 5.09101C10.8046 2.27085 16.2188 3.11279 19.0389 6.97147C19.7242 7.90904 20.1932 8.93842 20.4553 10.0001" />
                        <path d="M2.00452 8.46411L2.87229 10.7059C2.96814 10.9535 3.24658 11.0765 3.4942 10.9807L5.73594 10.1129" />
                        <path d="M20.3308 14.4908C19.8405 16.3388 18.7376 18.0372 17.0738 19.2532C13.215 22.0734 7.80083 21.2314 4.98071 17.3728C4.22167 16.3342 3.72792 15.183 3.48686 13.9999" />
                        <path d="M22.0151 15.8801L21.1474 13.6384C21.0515 13.3908 20.7731 13.2677 20.5255 13.3636L18.2837 14.2314" />
                      </svg>
                    </button>
                  )}
                  {entry.snapshot && (
                    <>
                      {/* hairline between reply actions (icons) and the document action (icon+label);
                          CSS shows it only when an icon button actually precedes it */}
                      <span className="ai-rollback-sep" aria-hidden />
                      <RollbackButton
                        disabled={busy}
                        onClick={() => rollback(i, entry.snapshot!)}
                      />
                    </>
                  )}
                </div>
              )}
              {entry.turnLimit && isLast && !busy && (
                <button className="ai-continue-btn" onClick={continueRun}>
                  {t('aiContinue')}
                </button>
              )}
            </div>
          )
        })}
        <AiInlineLauncher
          getAnchorRect={getSelectionAnchorRect}
          strings={inlineLauncherStrings}
          onPick={handleInlinePick}
          revision={scopeTick}
        />

        <TranslateDialog
          open={translateOpen}
          sourceText={
            translateScope === 'document'
              ? editor.state.doc.textBetween(1, editor.state.doc.content.size, '\n', ' ').trim()
              : selectionText
          }
          sourceRange={
            translateScope === 'document'
              ? { from: 1, to: editor.state.doc.content.size }
              : hasScopeSelection
                ? { from: liveSelection.from, to: liveSelection.to }
                : null
          }
          previewItems={documentTranslationUnits.length > 0 ? documentTranslationUnits : undefined}
          previewQuality={documentTranslationQuality}
          onRetryUnit={translateScope === 'document' ? retryDocumentUnit : undefined}
          onSaveMemory={
            window.dataflareOfficeBridge?.isEmbedded ? saveTranslationMemory : undefined
          }
          bilingual={bilingual}
          onBilingualChange={setBilingual}
          saveTarget={showSaveTarget ? saveTarget : undefined}
          onSaveTargetChange={showSaveTarget ? setSaveTarget : undefined}
          translatedFileName={translatedFileName}
          defaultSourceLang={sourceLang === 'auto' ? undefined : sourceLang}
          defaultTargetLang={targetLang}
          languages={TRANSLATE_LANGS}
          strings={translateDialogStrings}
          onTranslate={async () => {
            const result = await runTranslate()
            if (result === null) {
              if (translationCancelledRef.current) return null
              throw new Error(translateError ?? 'Translation failed')
            }
            return result
          }}
          onApply={applyTranslate}
          onCancel={cancelTranslation}
          app="docs"
        />

        <TranslationStoragePanel
          open={storagePanelOpen}
          onClose={() => setStoragePanelOpen(false)}
          client={window.desktop?.translationStorage ?? null}
          strings={translationStorageStrings}
          targetLanguage={targetLang}
        />

        {lastChangePlan && (
          <div style={{ position: 'sticky', top: 0, padding: '8px 16px', zIndex: 5 }}>
            <ChangeMarker
              plan={lastChangePlan}
              strings={{
                original: t('aiTranslateOriginal'),
                translated: t('aiTranslateTranslated'),
                undo: t('aiTranslateUndo'),
                undoFailed: t('aiTranslateUndoFailed'),
              }}
              onUndo={undoChange}
            />
          </div>
        )}
      </div>

      <div className="ai-composer">
        {attachNotice && <div className="ai-attach-notice">{attachNotice}</div>}
        {activePartial && (
          <div className="ai-queue ai-partial-card" role="group" aria-label={t('aiPartialTitle')}>
            <div className="ai-queue-head">
              <span className="ai-queue-title">{t('aiPartialTitle')}</span>
            </div>
            <div className="ai-queue-hint">
              {t('aiPartialBody', { blocks: activePartial.blocks })}
            </div>
            <div className="ai-queue-foot">
              <button
                type="button"
                className="ai-queue-discard"
                onClick={() => decidePartial(false)}
              >
                {t('aiPartialDiscard')}
              </button>
              <button type="button" className="ai-queue-send" onClick={() => decidePartial(true)}>
                {t('aiPartialAdopt')}
              </button>
            </div>
          </div>
        )}
        <EditQueueCard
          items={editQueue}
          editor={editor}
          busy={busy}
          onEditInstruction={(qid, text) => onQueueEditInstruction?.(qid, text)}
          onRemove={(qid) => onQueueRemove?.(qid)}
          onDiscardAll={() => onQueueClear?.()}
          onSend={sendQueue}
          onFocus={(qid) => onQueueFocus?.(qid)}
        />
        {!busy && (
          <div className="ai-quick-actions" role="toolbar">
            {quickActions.map((action) => (
              <button
                key={action.id}
                type="button"
                className="ai-quick-action"
                data-tip={action.label}
                onClick={() => {
                  setInput(action.prompt)
                  inputRef.current?.focus()
                }}
              >
                <span className="ai-quick-action-icon" aria-hidden>
                  {action.icon}
                </span>
                {action.label}
              </button>
            ))}
          </div>
        )}
        <AiComposer
          commands={composerCommands}
          onCommandPick={onComposerCommandPick}
          commandMenuLabel={t('aiSlashMenuTitle')}
          commandMenuEmptyLabel={t('aiSlashMenuEmpty')}
          commandMenuFootHint={t('aiSlashMenuFoot')}
          mentions={composerMentions}
          onMentionPick={onComposerMentionPick}
          mentionMenuLabel={t('aiMentionMenuTitle')}
          mentionMenuEmptyLabel={t('aiMentionMenuEmpty')}
          mentionMenuFootHint={t('aiMentionMenuFoot')}
          tokenBudget={tokenBudget}
          slashTriggerTitle={t('aiSlashTriggerTitle')}
          modes={modeOptions}
          mode={mode}
          onModeChange={setMode}
          modeSwitchLabel={t('aiModeSwitchTitle')}
          voice={voice}
          onEditLast={() => {
            // Walk the chat back to the most recent user entry and load its
            // text into the textarea so the user can edit-and-resend.
            const idx = [...chat].reverse().findIndex((e) => e.role === 'user')
            if (idx < 0) return
            const real = chat.length - 1 - idx
            const entry = chat[real]
            if (!entry || typeof entry.text !== 'string') return
            setInput(entry.text)
            inputRef.current?.focus()
          }}
          leading={
            activeSkill !== null && (
              <div className="ai-skill-row">
                <span className="ai-skill-chip" data-tip={t(activeSkill.descriptionKey)}>
                  <span className="ai-skill-chip-label">{t('aiActiveSkill')}</span>
                  <span className="ai-skill-chip-name">{t(activeSkill.labelKey)}</span>
                  <button
                    type="button"
                    className="ai-skill-chip-clear"
                    title={t('aiActiveSkillClear')}
                    aria-label={t('aiActiveSkillClear')}
                    onClick={() => setActiveSkillId(null)}
                  >
                    <svg width="12" height="12" viewBox="0 0 32 32" aria-hidden>
                      <path
                        d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
                        fill="currentColor"
                      />
                    </svg>
                  </button>
                </span>
              </div>
            )
          }
          header={
            (hasScopeSelection || attachments.length > 0) && (
              <>
                {hasScopeSelection && (
                  <div className="ai-scope-row">
                    <span className="ai-scope-hint">
                      <button
                        type="button"
                        className="ai-scope-label"
                        onClick={() => setScopePreviewOpen((v) => !v)}
                        aria-expanded={scopePreviewOpen}
                        data-tip={t('aiScopeSelectionTip')}
                      >
                        {t('aiScopeSelection', { words: countWords(selectionText) })}
                      </button>
                      <button
                        type="button"
                        className="ai-scope-clear"
                        onClick={clearScopeSelection}
                        data-tip={t('aiScopeClearTitle')}
                        aria-label={t('aiScopeClearTitle')}
                      >
                        <svg width="12" height="12" viewBox="0 0 32 32" aria-hidden>
                          <path
                            d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
                            fill="currentColor"
                          />
                        </svg>
                      </button>
                    </span>
                    {scopePreviewOpen && (
                      <div className="ai-scope-preview">
                        {selectionText.length > 400
                          ? `${selectionText.slice(0, 400)}…`
                          : selectionText}
                      </div>
                    )}
                  </div>
                )}
                {attachments.length > 0 && (
                  <div className="ai-attachments" onScroll={onAttachmentsScroll}>
                    {attachments.map((a) =>
                      ATTACHMENT_IMAGE_EXTS.has(a.ext) ? (
                        <span key={a.path} className="ai-attachment-thumb" data-tip={a.path}>
                          {attachmentPreviews[a.path] ? (
                            <img src={attachmentPreviews[a.path]} alt={a.name} />
                          ) : (
                            <span className="ai-attachment-thumb-pending" aria-hidden>
                              <img src={fileImageIcon} alt="" />
                            </span>
                          )}
                          <button
                            className="ai-attachment-thumb-remove"
                            onClick={() => removeAttachment(a.path)}
                            data-tip={t('aiRemoveAttachmentTitle')}
                            aria-label={t('aiRemoveAttachmentTitle')}
                          >
                            <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden>
                              <path
                                d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
                                fill="currentColor"
                                stroke="currentColor"
                                strokeWidth="0.25"
                              />
                            </svg>
                          </button>
                        </span>
                      ) : (
                        <span key={a.path} className="ai-attachment-card" data-tip={a.path}>
                          <span className="ai-attachment-card-icon">
                            <AttachmentCardIcon ext={a.ext} />
                          </span>
                          <span className="ai-attachment-card-meta">
                            <span className="ai-attachment-card-name">
                              {truncateCardName(a.name)}
                            </span>
                            <span className="ai-attachment-card-size">
                              {formatAttachmentSize(a.sizeBytes)}
                            </span>
                          </span>
                          <button
                            className="ai-attachment-thumb-remove"
                            onClick={() => removeAttachment(a.path)}
                            data-tip={t('aiRemoveAttachmentTitle')}
                            aria-label={t('aiRemoveAttachmentTitle')}
                          >
                            <svg width="16" height="16" viewBox="0 0 32 32" aria-hidden>
                              <path
                                d="M24 9.4L22.6 8L16 14.6L9.4 8L8 9.4l6.6 6.6L8 22.6L9.4 24l6.6-6.6l6.6 6.6l1.4-1.4l-6.6-6.6L24 9.4z"
                                fill="currentColor"
                                stroke="currentColor"
                                strokeWidth="0.25"
                              />
                            </svg>
                          </button>
                        </span>
                      ),
                    )}
                  </div>
                )}
              </>
            )
          }
          value={input}
          busy={busy}
          placeholder={t('aiInputPlaceholder')}
          hintIdle={t('aiHintIdle')}
          hintBusy={t('aiHintBusy')}
          hintIdleTitle={t('aiHintIdleTitle')}
          sendLabel={t('aiSend')}
          stopLabel={t('aiStop')}
          iconOnly
          sendIconEnabled={<img src={sendEnterOn} alt="" aria-hidden />}
          sendIconDisabled={<img src={sendEnterOff} alt="" aria-hidden />}
          stopIcon={<img src={sendStop} alt="" aria-hidden />}
          textareaRef={inputRef}
          onChange={setInput}
          onSend={run}
          onStop={cancel}
          onPasteFiles={(files) => void onPasteFiles(files)}
          footerStart={
            <>
              <button
                className="ai-attach-btn"
                onClick={pickAttachments}
                data-tip={t('aiAttachTitle')}
                aria-label={t('aiAttachTitle')}
              >
                <img src={attachIcon} alt="" aria-hidden />
              </button>
              <button
                className={`ai-track-btn${trackChanges ? ' on' : ''}`}
                onClick={toggleTrackChanges}
                data-tip={trackChanges ? t('aiTrackOnTitle') : t('aiTrackOffTitle')}
              >
                <span className="ai-track-dot" aria-hidden />
                {t('aiTrackChanges')}
              </button>
            </>
          }
        />
      </div>
    </aside>
  )
}

/** Tool row list (unified with slides/sheets): dot + summary; expandable details when there's output; arrow shows on hover */
/** Step-row status icons (timeline glyphs: 14px in a 20px slot, 1.6 stroke) */
function StepIcon({ status }: { status: 'running' | 'done' | 'error' }) {
  if (status === 'running') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M6.5 3.5h11M6.5 20.5h11M8 3.5v3.2c0 2.6 4 4.2 4 5.3 0 1.1 4 2.7 4 5.3v3.2M16 3.5v3.2c0 2.6-4 4.2-4 5.3 0 1.1-4 2.7-4 5.3v3.2" />
      </svg>
    )
  }
  if (status === 'error') {
    return (
      <svg
        viewBox="0 0 24 24"
        width="14"
        height="14"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.6"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <circle cx="12" cy="12" r="9" />
        <path d="m9.2 9.2 5.6 5.6M14.8 9.2l-5.6 5.6" />
      </svg>
    )
  }
  return (
    <svg
      viewBox="0 0 24 24"
      width="14"
      height="14"
      fill="none"
      stroke="currentColor"
      strokeWidth="1.6"
      strokeLinecap="round"
      strokeLinejoin="round"
      aria-hidden
    >
      <circle cx="12" cy="12" r="9" />
      <path d="m8.5 12.4 2.4 2.4 4.6-5" />
    </svg>
  )
}

/** Quiet roll-back action in the message toolbar: restores the document to before the run's edits */
function RollbackButton({ disabled, onClick }: { disabled: boolean; onClick: () => void }) {
  const { t: tr } = useI18n()
  return (
    <button type="button" className="ai-rollback-btn" disabled={disabled} onClick={onClick}>
      {/* 24-canvas glyph at 18px (optical parity with the toolbar icons): stroke 1.5 paints 1.125px (1:16) */}
      <svg
        width="18"
        height="18"
        viewBox="0 0 24 24"
        fill="none"
        stroke="currentColor"
        strokeWidth="1.5"
        strokeLinecap="round"
        strokeLinejoin="round"
        aria-hidden
      >
        <path d="M5.91026 4L2.5 7.14791L5.91026 10.8205" />
        <path d="M3.96154 7.41028H15.1636C18.5169 7.41028 21.3646 10.1484 21.4953 13.5C21.6334 17.0416 18.707 20.0769 15.1636 20.0769H6.88384" />
      </svg>
      {tr('aiRollback')}
    </button>
  )
}

/** Tool activity group: a single quiet summary row
 *  that auto-opens while tools run, auto-collapses into "Worked · N steps" when they finish,
 *  and a manual toggle that always wins. Rows inside are step rows with 1px connectors. */
function ToolChipList({ tools }: { tools: ToolActivity[] }) {
  const { t: tr } = useI18n()
  const [expanded, setExpanded] = useState<Set<number>>(new Set())
  const [userOpen, setUserOpen] = useState<boolean | null>(null)

  const toggle = (j: number) => {
    setExpanded((prev) => {
      const next = new Set(prev)
      if (next.has(j)) next.delete(j)
      else next.add(j)
      return next
    })
  }

  const anyRunning = tools.some((tool) => tool.running)
  const open = userOpen ?? anyRunning
  const label = anyRunning ? tr('aiGroupWorking') : tr('aiWorkedSteps', { n: tools.length })

  return (
    <div className="ai-work-group">
      <button
        type="button"
        className={`ai-work-group-summary${anyRunning ? ' running' : ''}`}
        aria-expanded={open}
        onClick={() => setUserOpen(!open)}
      >
        {anyRunning && !open && <span className="ai-tool-chip-spinner" aria-hidden />}
        <span className="ai-work-group-label">{label}</span>
        <span className={`ai-tool-chip-caret${open ? ' open' : ''}`} aria-hidden>
          ›
        </span>
      </button>
      <div className={`ai-work-group-body${open ? ' open' : ''}`}>
        <div className="ai-work-group-body-inner">
          {tools.map((tool, j) => {
            const hasOutput = !tool.running && !!tool.output
            const isOpen = expanded.has(j)
            const stepStatus = tool.running ? 'running' : tool.isError ? 'error' : 'done'
            return (
              <div key={j} className="ai-step-row">
                <span className={`ai-step-icon ${stepStatus}`} aria-hidden>
                  <StepIcon status={stepStatus} />
                </span>
                <div className="ai-step-content">
                  {hasOutput ? (
                    <button
                      type="button"
                      className="ai-step-title clickable"
                      data-tip={tool.name}
                      aria-expanded={isOpen}
                      onClick={() => toggle(j)}
                    >
                      {tool.summary}
                    </button>
                  ) : (
                    <span className="ai-step-title" data-tip={tool.name}>
                      {tool.summary}
                    </span>
                  )}
                  {hasOutput && isOpen && (
                    <div className="ai-step-detail">
                      <div className="ai-tool-output">
                        <div className="ai-tool-output-pre">{tool.output}</div>
                      </div>
                    </div>
                  )}
                </div>
              </div>
            )
          })}
        </div>
      </div>
    </div>
  )
}

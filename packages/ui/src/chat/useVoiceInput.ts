/**
 * useVoiceInput — Web Speech API bridge for the shared AI composer.
 *
 * Wraps the Web Speech API (`SpeechRecognition` / `webkitSpeechRecognition`)
 * into a single hook so every app gets the same behaviour:
 *   - interim transcripts are merged into the textarea live
 *   - finalised chunks are appended; the user can edit between dictation
 *     and send
 *   - tap-to-toggle (matches ChatGPT / workbuddy; push-and-hold would need
 *     a different gesture surface, kept out of scope)
 *   - `available` is `false` outside Chromium/Safari with a secure context
 *
 * Returns:
 *   - `available`: feature-detect result
 *   - `active`:    is the recogniser currently running
 *   - `start()` / `stop()`: tap-to-toggle
 *   - `error`:    last error string, cleared on the next start()
 *
 * The host decides what to do with the resulting text — typically set it
 * into the composer state via `setValue`.
 */
import { useCallback, useEffect, useRef, useState } from 'react'

/** Local minimal Web Speech API shape — full DOM lib types are heavier. */
interface SpeechRecognitionLike {
  lang: string
  interimResults: boolean
  continuous: boolean
  onresult:
    | ((ev: {
        resultIndex: number
        results: ArrayLike<{ isFinal: boolean; 0: { transcript: string } }>
      }) => void)
    | null
  onerror: (() => void) | null
  onend: (() => void) | null
  start: () => void
  stop: () => void
}

declare global {
  interface Window {
    SpeechRecognition?: new () => SpeechRecognitionLike
    webkitSpeechRecognition?: new () => SpeechRecognitionLike
  }
}

export interface UseVoiceInputOptions {
  /** IETF tag for the recogniser (defaults to navigator.language). */
  lang?: string
  /**
   * Called for every result event with the *merged* text the user sees in the
   * textarea. Implementations usually call `setValue(next)` from here.
   *
   * The hook keeps a `base` snapshot so subsequent runs do not append to
   * leftover dictation. Call `setBase(value)` (returned) when the textarea
   * has been cleared (e.g. after a successful send) so the next run starts
   * from a known prefix.
   */
  onResult: (next: string) => void
  /** Optional error surface — typically `setError` for a small toast. */
  onError?: (msg: string) => void
}

export interface UseVoiceInputReturn {
  readonly available: boolean
  readonly active: boolean
  readonly error: string | null
  start: () => void
  stop: () => void
  /** Update the baseline the next `start()` merges into (e.g. after a send). */
  setBase: (base: string) => void
}

/**
 * Detect whether the current environment exposes a usable SpeechRecognition.
 * Cheap to call on every render; safe to feed into `useMemo`.
 */
export function isVoiceInputAvailable(): boolean {
  if (typeof window === 'undefined') return false
  return Boolean(window.SpeechRecognition || window.webkitSpeechRecognition)
}

export function useVoiceInput(options: UseVoiceInputOptions): UseVoiceInputReturn {
  const { lang, onResult, onError } = options
  const available = isVoiceInputAvailable()
  const [active, setActive] = useState(false)
  const [error, setError] = useState<string | null>(null)

  // Mutable refs survive the strict-mode double-render without re-binding.
  const recogRef = useRef<SpeechRecognitionLike | null>(null)
  const baseRef = useRef<string>('')

  const start = useCallback(() => {
    if (!available) return
    if (recogRef.current) return
    const Ctor = window.SpeechRecognition ?? window.webkitSpeechRecognition
    if (!Ctor) return
    const recog = new Ctor()
    recog.lang = lang || (typeof navigator !== 'undefined' ? navigator.language : 'zh-CN')
    recog.interimResults = true
    recog.continuous = true
    const base = baseRef.current
    recog.onresult = (ev) => {
      let interim = ''
      let finalText = ''
      for (let i = ev.resultIndex; i < ev.results.length; i++) {
        const r = ev.results[i] as { isFinal: boolean; 0: { transcript: string } }
        const txt = r[0].transcript
        if (r.isFinal) finalText += txt
        else interim += txt
      }
      const merged = base + (finalText || interim)
      baseRef.current = merged
      onResult(merged)
      if (finalText && recogRef.current) recogRef.current && (recogRef.current as unknown as { _committedBase?: string })._committedBase
    }
    recog.onerror = () => {
      const msg = 'voice recognition failed'
      setError(msg)
      onError?.(msg)
      setActive(false)
    }
    recog.onend = () => {
      setActive(false)
    }
    try {
      recog.start()
    } catch (e) {
      const msg = e instanceof Error ? e.message : String(e)
      setError(msg)
      onError?.(msg)
      return
    }
    recogRef.current = recog
    setError(null)
    setActive(true)
  }, [available, lang, onResult, onError])

  const stop = useCallback(() => {
    const r = recogRef.current
    if (!r) return
    try {
      r.stop?.()
    } catch {
      /* ignore */
    }
    recogRef.current = null
    setActive(false)
  }, [])

  // Best-effort cleanup on unmount — releasing the recogniser also lets the
  // browser release the mic indicator.
  useEffect(() => {
    return () => {
      try {
        recogRef.current?.stop?.()
      } catch {
        /* ignore */
      }
      recogRef.current = null
    }
  }, [])

  const setBase = useCallback((base: string) => {
    baseRef.current = base
  }, [])

  return { available, active, error, start, stop, setBase }
}

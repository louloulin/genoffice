import { useEffect, useRef } from 'react'
import { createEditor, type EditorHandle, type SavedEvent, type DirtyChangedEvent, type ErrorEvent, type EditorApp, type EditorTheme, type EditorLang, type EditorToolbar } from '@genoffice/web-sdk'

export interface GenOfficeEditorProps {
  host: string
  documentId: string
  app: EditorApp
  jwt: string
  theme?: EditorTheme
  lang?: EditorLang
  toolbar?: EditorToolbar
  onReady?: () => void
  onSaved?: (e: SavedEvent) => void
  onDirtyChanged?: (e: DirtyChangedEvent) => void
  onError?: (e: ErrorEvent) => void
  onClosed?: () => void
}

/**
 * Drop-in React component for the GenOffice iframe Embed.
 *
 * Forwards the most useful editor events to props so the host app can
 * react without manually wiring postMessage listeners.
 */
export function GenOfficeEditor(props: GenOfficeEditorProps) {
  const containerRef = useRef<HTMLDivElement>(null)
  const editorRef = useRef<EditorHandle | null>(null)

  useEffect(() => {
    if (!containerRef.current) return
    const editor = createEditor({
      host: props.host,
      documentId: props.documentId,
      app: props.app,
      jwt: props.jwt,
      theme: props.theme,
      lang: props.lang,
      toolbar: props.toolbar,
      container: containerRef.current,
      onReady: props.onReady,
      onError: props.onError,
    })
    editorRef.current = editor
    if (props.onSaved) editor.on('saved', props.onSaved)
    if (props.onDirtyChanged) editor.on('dirtyChanged', props.onDirtyChanged)
    if (props.onClosed) editor.on('closed', props.onClosed)
    return () => {
      editor.destroy()
      editorRef.current = null
    }
  }, [props.host, props.documentId, props.app, props.jwt, props.theme, props.lang, props.toolbar])

  return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />
}

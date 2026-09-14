import { useCallback, useEffect, useRef, useState } from 'react'
import { HtmlIcon } from './HtmlIcon'

type Status = 'loading' | 'ready' | 'error'

const STORAGE_PREFIX = 'genoffice:html:last'

interface HtmlApi {
  readFile(path: string): Promise<string>
  saveFile(path: string, content: string): Promise<{ ok: boolean; path?: string }>
  consumePending(): Promise<string | null>
  getLanguage?(): Promise<string>
  getTheme?(): Promise<string>
}

declare global {
  interface Window {
    htmlApi: HtmlApi
  }
}

function getPathFromHash(): string | null {
  const hash = window.location.hash.slice(1)
  const params = new URLSearchParams(hash)
  const open = params.get('open')
  return open || null
}

function setStatusMessage(text: string): void {
  const el = document.getElementById('html-status-text')
  if (el) el.textContent = text
}

export default function App(): JSX.Element {
  const [status, setStatus] = useState<Status>('loading')
  const [path, setPath] = useState<string | null>(null)
  const [source, setSource] = useState('')
  const [savedSource, setSavedSource] = useState('')
  const [previewMode, setPreviewMode] = useState<'split' | 'source' | 'preview'>('split')
  const [error, setError] = useState<string | null>(null)
  const editorRef = useRef<HTMLTextAreaElement>(null)
  const previewRef = useRef<HTMLIFrameElement>(null)
  const dirtyRef = useRef(false)

  // initial load: consume-pending or hash
  useEffect(() => {
    let alive = true
    void (async () => {
      try {
        let pending: string | null = null
        if (window.htmlApi?.consumePending) {
          pending = await window.htmlApi.consumePending()
        }
        if (!pending) pending = getPathFromHash()
        if (!pending) {
          if (alive) {
            setStatus('ready')
            setError('没有指定 HTML 文件。请从首页创建一个新 HTML 文档。')
          }
          return
        }
        if (alive) setPath(pending)
        try {
          const text = await window.htmlApi.readFile(pending)
          if (!alive) return
          setSource(text)
          setSavedSource(text)
          setStatus('ready')
          try {
            localStorage.setItem(STORAGE_PREFIX, pending)
          } catch {}
        } catch (e) {
          if (alive) {
            setStatus('error')
            setError(`无法读取文件: ${(e as Error).message}`)
          }
        }
      } catch (e) {
        if (alive) {
          setStatus('error')
          setError(`初始化失败: ${(e as Error).message}`)
        }
      }
    })()
    return () => {
      alive = false
    }
  }, [])

  // live preview update (no debounce; small files, browser handles it)
  useEffect(() => {
    const iframe = previewRef.current
    if (!iframe) return
    const doc = iframe.contentDocument
    if (!doc) return
    doc.open()
    doc.write(source || '<!doctype html><html><body></body></html>')
    doc.close()
  }, [source])

  // track dirty state
  useEffect(() => {
    dirtyRef.current = source !== savedSource
    setStatusMessage(dirtyRef.current ? '已修改' : '已保存')
  }, [source, savedSource])

  const save = useCallback(async (): Promise<void> => {
    if (!path) {
      setError('尚未关联文件路径。')
      return
    }
    try {
      const result = await window.htmlApi.saveFile(path, source)
      if (result?.ok) {
        setSavedSource(source)
        setError(null)
        setStatusMessage('已保存')
      }
    } catch (e) {
      setError(`保存失败: ${(e as Error).message}`)
    }
  }, [path, source])

  // ctrl/cmd-s to save
  useEffect(() => {
    const onKey = (e: KeyboardEvent): void => {
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
        e.preventDefault()
        void save()
      }
    }
    window.addEventListener('keydown', onKey)
    return () => window.removeEventListener('keydown', onKey)
  }, [save])

  if (status === 'loading') {
    return (
      <div className="html-root html-loading">
        <HtmlIcon />
        <p>正在加载…</p>
      </div>
    )
  }

  return (
    <div className="html-root">
      <header className="html-toolbar">
        <div className="html-toolbar-left">
          <HtmlIcon />
          <span className="html-title">{path ? path.split('/').pop() : '未命名 HTML'}</span>
        </div>
        <div className="html-toolbar-right">
          <div className="html-mode-picker" role="tablist" aria-label="视图">
            <button
              type="button"
              role="tab"
              aria-selected={previewMode === 'source'}
              className={previewMode === 'source' ? 'active' : ''}
              onClick={() => setPreviewMode('source')}
            >
              源代码
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewMode === 'split'}
              className={previewMode === 'split' ? 'active' : ''}
              onClick={() => setPreviewMode('split')}
            >
              分屏
            </button>
            <button
              type="button"
              role="tab"
              aria-selected={previewMode === 'preview'}
              className={previewMode === 'preview' ? 'active' : ''}
              onClick={() => setPreviewMode('preview')}
            >
              预览
            </button>
          </div>
          <button
            type="button"
            className="html-save"
            disabled={!path || source === savedSource}
            onClick={() => void save()}
          >
            保存
          </button>
        </div>
      </header>

      {error && (
        <div className="html-error" role="alert">
          {error}
        </div>
      )}

      <main className={`html-main html-mode-${previewMode}`}>
        {(previewMode === 'source' || previewMode === 'split') && (
          <textarea
            ref={editorRef}
            className="html-source"
            value={source}
            spellCheck={false}
            onChange={(e) => setSource(e.target.value)}
            placeholder={path ? '<!-- 在此处输入 HTML -->' : '请先从首页创建一个 HTML 文档'}
          />
        )}
        {(previewMode === 'preview' || previewMode === 'split') && (
          <iframe
            ref={previewRef}
            className="html-preview"
            title="预览"
            sandbox="allow-same-origin"
          />
        )}
      </main>

      <footer className="html-statusbar">
        <span id="html-status-text">{source === savedSource ? '已保存' : '已修改'}</span>
        <span className="html-status-spacer" />
        <span>{source.length} 字符</span>
        <span>UTF-8</span>
      </footer>
    </div>
  )
}

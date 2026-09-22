/**
 * SDK 2.0 sessionBinding.autoRelease: false demo (sdk1.md §11.32.4 #2).
 *
 * The README documents `autoRelease: false` for hosts that want to
 * manage release themselves (e.g. fire release from a global
 * page-unload handler that runs AFTER `destroy()`). This example
 * shows the full flow:
 *
 *   1. `createEmbedNonce({ host, documentId, app, jwt })`
 *      → server mints a `sessionId` + `nonce` pair
 *   2. `createEditor({ sessionBinding: { sessionId, nonce, autoRelease: false }, ... })`
 *      → SDK wires server-minted nonce into the embed URL but does NOT
 *        call releaseEmbedNonce on destroy()
 *   3. App-level event handlers (`pagehide`, `beforeunload`, custom
 *      router teardown) call `releaseEmbedNonce({ sessionId, host, jwt })`
 *      explicitly to free the server-side slot
 *
 * Without step 3 the server-side LRU still cleans up after 5 min TTL —
 * the explicit release just lets you free the slot the moment you know
 * you're done.
 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createEditor,
  createEmbedNonce,
  releaseEmbedNonce,
  type EditorHandle,
} from '@genoffice/web-sdk'

interface Args { host: string; documentId: string; app: 'docs' | 'sheets' | 'slides' | 'pdf' | 'markdown' | 'html'; jwt: string }

function Editor({ args, onReady }: { args: Args; onReady: (h: EditorHandle) => void }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    let mounted = true
    let handle: EditorHandle | null = null
    void (async () => {
      // 1. Server mints a sessionId+nonce pair bound to the host + docId.
      const { embedUrl, sessionId, nonce } = await createEmbedNonce({
        host: args.host,
        documentId: args.documentId,
        app: args.app,
        jwt: args.jwt,
      })
      if (!mounted) return
      // 2. Mount with server-minted sessionBinding but autoRelease: false.
      // The SDK will echo the server-minted nonce on the handshake
      // (so the embed handler accepts the iframe) but will NOT call
      // releaseEmbedNonce on destroy().
      handle = createEditor({
        host: args.host,
        url: embedUrl,
        container: ref.current!,
        app: args.app,
        documentId: args.documentId,
        jwt: args.jwt,
        sessionBinding: { sessionId, nonce, autoRelease: false },
      })
      onReady(handle)
    })()
    return () => {
      mounted = false
      handle?.destroy()
    }
  }, [args.host, args.documentId, args.app, args.jwt])
  return <div ref={ref} className="frame-wrap" />
}

function App() {
  const [jwt, setJwt] = useState('')
  const [docId, setDocId] = useState('doc_autorelease')
  const [logs, setLogs] = useState<string[]>([])
  const log = (s: string) => setLogs((p) => [`${new Date().toISOString().slice(11, 19)}  ${s}`, ...p].slice(0, 30))

  const handleRef = useRef<EditorHandle | null>(null)

  // 3. App-level explicit release. The host decides when — here we
  // expose a button, but in a real app this fires from `pagehide` /
  // `beforeunload` / a router teardown.
  async function manualRelease() {
    if (!handleRef.current) return
    const sessionId = (handleRef.current as unknown as { sessionBinding?: { sessionId: string } }).sessionBinding?.sessionId
    if (!sessionId) {
      log('!! no sessionBinding on handle — cannot release')
      return
    }
    handleRef.current.destroy()
    handleRef.current = null
    log('· editor destroyed (autoRelease: false — no DELETE fired)')
    try {
      // Note: in a real app, `jwt` and `host` come from your app
      // context, not the EditorHandle (we don't expose them through
      // the public API for security).
      const result = await releaseEmbedNonce({ sessionId, host: window.location.origin, jwt })
      log(`✓ manual releaseEmbedNonce → released=${result.released}`)
    } catch (e) {
      log(`!! releaseEmbedNonce threw: ${(e as Error).message}`)
    }
  }

  // Mirror what a real page-unload handler does so the demo is closer
  // to production wiring: register a `pagehide` listener so users see
  // the explicit release path fire on tab close too.
  useEffect(() => {
    function onPageHide() {
      if (!handleRef.current) return
      const sessionId = (handleRef.current as unknown as { sessionBinding?: { sessionId: string } }).sessionBinding?.sessionId
      if (!sessionId || !jwt) return
      // Fire-and-forget on unload (same pattern as the SDK's own
      // destroy-time autoRelease, but called by the host's unload
      // handler instead of the SDK).
      void releaseEmbedNonce({ sessionId, host: window.location.origin, jwt })
        .then((r) => log(`✓ pagehide → releaseEmbedNonce released=${r.released}`))
        .catch(() => {})
    }
    window.addEventListener('pagehide', onPageHide)
    return () => window.removeEventListener('pagehide', onPageHide)
  }, [jwt])

  const ready = !!jwt

  return (
    <>
      <h1>SDK 2.0 · sessionBinding.autoRelease: false</h1>
      <p>
        Mint a server-bound nonce session, mount the editor with
        <code>sessionBinding: &#123; sessionId, nonce, autoRelease: false &#125;</code>,
        then call <code>releaseEmbedNonce()</code> yourself from a
        page-unload handler (or the button below).
      </p>
      <nav style={{ marginBottom: 16 }}>
        <a href="./">Basic</a> · <a href="./kestrel.html">Kestrel (SDK 2.0)</a>
      </nav>
      <div className="row">
        <label>JWT</label>
        <input value={jwt} onChange={(e) => setJwt(e.target.value)} placeholder="eyJ…" />
      </div>
      <div className="row">
        <label>Document ID</label>
        <input value={docId} onChange={(e) => setDocId(e.target.value)} />
      </div>
      {ready && (
        <>
          <Editor
            args={{ host: window.location.origin, documentId: docId, app: 'docs', jwt }}
            onReady={(h) => { handleRef.current = h; log(`✓ mounted (autoRelease: false)`) }}
          />
          <div style={{ marginTop: 12 }}>
            <button onClick={manualRelease}>Manual release (destroy + releaseEmbedNonce)</button>
          </div>
        </>
      )}
      <div className="log">
        {logs.map((l, i) => <p key={i} style={{ margin: 0 }}>{l}</p>)}
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

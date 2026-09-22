/**
 * SDK 2.0 Kestrel end-to-end demo (sdk1.md §B.5.6 verification gate #3).
 *
 * Exercises four Kestrel surfaces in one React page:
 *
 *   1. **Multi-instance** — two editors side-by-side, each with its
 *      own `instanceId` and looked up via `getEditor(id)` from a
 *      sibling handler.
 *   2. **Plugin Runtime** — `mountSidebar` / `postToSidebar` /
 *      `sidebarMessage` round-trip against a fake panel URL.
 *   3. **Comments API** — `addComment` / `listComments` /
 *      `resolveComment` + `commentAdded` / `commentResolved` events.
 *   4. **Telemetry** — `createEditor({ telemetry: true })` + a
 *      `usage` event subscriber (the interval is real so the host
 *      waits at least 30 s for the first event in dev — the demo
 *      gracefully handles "no event yet" while the wait is in
 *      flight).
 *
 * The page is deliberately single-page so reviewers can scan all
 * four surfaces without tab-hopping. The `handle*` functions
 * demonstrate that `getEditor(instanceId)` works from anywhere in
 * the host code — not just from inside `useEffect`.
 */
import { useEffect, useRef, useState } from 'react'
import { createRoot } from 'react-dom/client'
import {
  createEditor,
  getEditor,
  type EditorHandle,
  type UsageEvent,
  type Comment,
  type SidebarMessageEvent,
} from '@genoffice/web-sdk'

interface MountArgs {
  host: string
  documentId: string
  jwt: string
}

function SidebarMountPanel({ args }: { args: MountArgs }) {
  const ref = useRef<HTMLDivElement>(null)
  const handleRef = useRef<EditorHandle | null>(null)
  const [panelId, setPanelId] = useState<string | null>(null)
  const [messages, setMessages] = useState<SidebarMessageEvent[]>([])

  useEffect(() => {
    if (!ref.current) return
    const handle = createEditor({
      host: args.host,
      documentId: args.documentId,
      app: 'docs',
      jwt: args.jwt,
      container: ref.current,
      telemetry: true,
    })
    handleRef.current = handle
    handle.on('sidebarMessage', (e) => {
      setMessages((p) => [e, ...p].slice(0, 10))
    })
    return () => {
      handle.destroy()
      handleRef.current = null
    }
  }, [args.host, args.documentId, args.jwt])

  async function mount() {
    if (!handleRef.current) return
    // Use a tiny static page hosted by Vite dev server as the panel.
    // The panel protocol is `unknown`-shaped by design — the host just
    // forwards whatever JSON the panel emits back.
    const result = await handleRef.current.command('mountSidebar', {
      panelUrl: `${args.host}/panel-stub.html`,
      width: 320,
      title: 'AI assistant',
    })
    setPanelId(result.panelId)
  }

  async function unmount() {
    if (!panelId || !handleRef.current) return
    await handleRef.current.command('unmountSidebar', { panelId })
    setPanelId(null)
  }

  async function pushToPanel() {
    if (!panelId || !handleRef.current) return
    // `message` is `unknown` — the panel author decides the shape.
    await handleRef.current.command('postToSidebar', {
      panelId,
      message: { type: 'ASK', prompt: 'summarise this document' },
    })
  }

  return (
    <div className="panel">
      <div className="frame" ref={ref} />
      <div className="controls">
        <button onClick={mount} disabled={!!panelId}>Mount sidebar</button>
        <button onClick={pushToPanel} disabled={!panelId}>Post "ASK"</button>
        <button onClick={unmount} disabled={!panelId}>Unmount</button>
      </div>
      <ul>
        {messages.map((m, i) => (
          <li key={i}><code>{JSON.stringify(m.message)}</code></li>
        ))}
      </ul>
    </div>
  )
}

function CommentsPanel({ args, instanceId }: { args: MountArgs; instanceId: string }) {
  const [comments, setComments] = useState<Comment[]>([])
  const [draft, setDraft] = useState('')

  async function refresh() {
    const editor = getEditor(instanceId)
    if (!editor) return
    const { comments: list } = await editor.command('listComments')
    setComments(list)
  }

  useEffect(() => {
    const editor = getEditor(instanceId)
    if (!editor) return
    editor.on('commentAdded', (e) => {
      setComments((p) => [...p, e.comment])
    })
    editor.on('commentResolved', (e) => {
      setComments((p) => p.map((c) => (c.id === e.comment.id ? e.comment : c)))
    })
    void refresh()
  }, [instanceId])

  async function add() {
    const editor = getEditor(instanceId)
    if (!editor || !draft) return
    await editor.command('addComment', {
      anchor: { range: { start: 0, end: 5 } },
      text: draft,
    })
    setDraft('')
  }

  async function toggle(id: string, resolved: boolean) {
    const editor = getEditor(instanceId)
    if (!editor) return
    await editor.command('resolveComment', { id, resolved })
  }

  return (
    <div className="panel">
      <h3>Comments ({comments.length})</h3>
      <div className="row">
        <input
          value={draft}
          onChange={(e) => setDraft(e.target.value)}
          placeholder="New comment…"
        />
        <button onClick={add} disabled={!draft}>Add</button>
      </div>
      <ul>
        {comments.map((c) => (
          <li key={c.id} className={c.resolved ? 'resolved' : ''}>
            <span>{c.text}</span>
            <button onClick={() => toggle(c.id, !c.resolved)}>
              {c.resolved ? 'Unresolve' : 'Resolve'}
            </button>
          </li>
        ))}
      </ul>
    </div>
  )
}

function TelemetryBadge({ args }: { args: MountArgs }) {
  const [usage, setUsage] = useState<UsageEvent | null>(null)
  const ref = useRef<HTMLDivElement>(null)
  const handleRef = useRef<EditorHandle | null>(null)

  useEffect(() => {
    if (!ref.current) return
    const handle = createEditor({
      host: args.host,
      documentId: args.documentId,
      app: 'docs',
      jwt: args.jwt,
      container: ref.current,
      telemetry: true,
    })
    handleRef.current = handle
    handle.on('usage', (e) => setUsage(e))
    return () => {
      handle.destroy()
      handleRef.current = null
    }
  }, [args.host, args.documentId, args.jwt])

  return (
    <div className="panel">
      <div className="frame small" ref={ref} />
      <p>
        Telemetry: opt-in via <code>telemetry: true</code>. Fires every
        30 s. <em>(Press button below to write content and bump the
        counter.)</em>
      </p>
      <button onClick={async () => {
        const h = handleRef.current
        if (!h) return
        await h.command('insertText', { text: 'telemetry probe ' })
      }}>insertText</button>
      {usage ? (
        <table>
          <tbody>
            <tr><td>instanceId</td><td><code>{usage.instanceId}</code></td></tr>
            <tr><td>docBytesWritten</td><td>{usage.docBytesWritten}</td></tr>
            <tr><td>aiCalls</td><td>{usage.aiCalls}</td></tr>
            <tr><td>aiTokensIn</td><td>{usage.aiTokensIn}</td></tr>
            <tr><td>sessionDurationMs</td><td>{usage.sessionDurationMs}</td></tr>
          </tbody>
        </table>
      ) : (
        <p><em>Waiting for first 30 s tick…</em></p>
      )}
    </div>
  )
}

function App() {
  const [jwt, setJwt] = useState('')
  const [docIdA, setDocIdA] = useState('doc_split_a')
  const [docIdB, setDocIdB] = useState('doc_split_b')
  const ready = !!jwt

  if (!ready) {
    return (
      <>
        <h1>Kestrel demo</h1>
        <p>Paste a JWT (mint via <code>POST /api/v1/auth/jwt</code>).</p>
        <input value={jwt} onChange={(e) => setJwt(e.target.value)} />
      </>
    )
  }

  const args: MountArgs = { host: window.location.origin, jwt, documentId: docIdA }

  return (
    <>
      <h1>SDK 2.0 Kestrel demo</h1>
      <p>Four surfaces in one page. Edit the JWT / doc IDs at the top.</p>
      <div className="row">
        <label>JWT</label>
        <input value={jwt} onChange={(e) => setJwt(e.target.value)} />
      </div>
      <div className="row">
        <label>doc A</label>
        <input value={docIdA} onChange={(e) => setDocIdA(e.target.value)} />
      </div>
      <div className="row">
        <label>doc B</label>
        <input value={docIdB} onChange={(e) => setDocIdB(e.target.value)} />
      </div>

      <h2>1. Multi-instance</h2>
      <div className="split">
        <GenOfficeEditor host={args.host} documentId={docIdA} jwt={jwt} instanceId="split-A" />
        <GenOfficeEditor host={args.host} documentId={docIdB} jwt={jwt} instanceId="split-B" />
      </div>

      <h2>2. Comments API</h2>
      <CommentsPanel args={args} instanceId="split-A" />

      <h2>3. Plugin Runtime</h2>
      <SidebarMountPanel args={args} />

      <h2>4. Telemetry</h2>
      <TelemetryBadge args={args} />
    </>
  )
}

function GenOfficeEditor(props: { host: string; documentId: string; jwt: string; instanceId: string }) {
  const ref = useRef<HTMLDivElement>(null)
  useEffect(() => {
    if (!ref.current) return
    const h = createEditor({
      host: props.host,
      documentId: props.documentId,
      app: 'docs',
      jwt: props.jwt,
      container: ref.current,
      instanceId: props.instanceId,
    })
    return () => h.destroy()
  }, [props.host, props.documentId, props.jwt, props.instanceId])
  return <div ref={ref} className="frame" />
}

createRoot(document.getElementById('root')!).render(<App />)

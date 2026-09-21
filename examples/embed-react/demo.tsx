import { useState } from 'react'
import { createRoot } from 'react-dom/client'
import { GenOfficeEditor } from './GenOfficeEditor'
import type { EditorApp, EditorTheme, EditorToolbar } from '@genoffice/web-sdk'

function App() {
  const [jwt, setJwt] = useState('')
  const [docId, setDocId] = useState('doc_demo')
  const [app, setApp] = useState<EditorApp>('docs')
  const [theme, setTheme] = useState<EditorTheme>('auto')
  const [toolbar, setToolbar] = useState<EditorToolbar>('full')
  const [logs, setLogs] = useState<string[]>([])
  const log = (s: string) => setLogs((p) => [`${new Date().toISOString().slice(11, 19)}  ${s}`, ...p].slice(0, 30))

  const mounted = jwt && docId

  return (
    <>
      <h1>GenOffice Embed — React demo</h1>
      <p>Paste a JWT from <code>POST /api/v1/auth/jwt</code>, then mount.</p>
      <div className="row"><label>JWT</label><input value={jwt} onChange={(e) => setJwt(e.target.value)} placeholder="eyJ…" /></div>
      <div className="row"><label>Document ID</label><input value={docId} onChange={(e) => setDocId(e.target.value)} /></div>
      <div className="row">
        <label>App</label>
        <select value={app} onChange={(e) => setApp(e.target.value as EditorApp)}>
          <option value="docs">docs</option><option value="sheets">sheets</option>
          <option value="slides">slides</option><option value="pdf">pdf</option>
          <option value="markdown">markdown</option><option value="html">html</option>
        </select>
      </div>
      <div className="row">
        <label>Theme</label>
        <select value={theme} onChange={(e) => setTheme(e.target.value as EditorTheme)}>
          <option value="auto">auto</option><option value="light">light</option><option value="dark">dark</option>
        </select>
      </div>
      <div className="row">
        <label>Toolbar</label>
        <select value={toolbar} onChange={(e) => setToolbar(e.target.value as EditorToolbar)}>
          <option value="full">full</option><option value="minimal">minimal</option><option value="none">none</option>
        </select>
      </div>
      {mounted && (
        <div className="frame-wrap">
          <GenOfficeEditor
            host={window.location.origin}
            documentId={docId}
            app={app}
            jwt={jwt}
            theme={theme}
            toolbar={toolbar}
            onReady={() => log(`✓ ready (${app})`)}
            onSaved={(e) => log(`✓ saved v${e.version}`)}
            onDirtyChanged={(e) => log(`· dirty=${e.dirty}`)}
            onError={(e) => log(`!! ${e.code}: ${e.message}`)}
            onClosed={() => log('· closed')}
          />
        </div>
      )}
      <div className="log">
        {logs.map((l, i) => <p key={i} style={{ margin: 0 }}>{l}</p>)}
      </div>
    </>
  )
}

createRoot(document.getElementById('root')!).render(<App />)

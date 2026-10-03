/**
 * Host-document routing in the guest integration: knowledge and drive both
 * download from and save back to the host, each on its own routes, and the
 * filename / MIME follow `documentType` instead of always claiming docx.
 */
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

type Handlers = { onCommand?: (command: unknown) => void }
let captured: Handlers = {}

vi.mock('../../src/dataflare/guest', () => ({
  getDataflareEmbedSessionId: () => 'sess-1',
  installDataflareEmbedBridge: (handlers: Handlers) => {
    captured = handlers
    return () => {}
  },
  isEmbeddedInHost: () => false,
  postToEmbedParent: vi.fn(),
  requestDataflareParent: vi.fn(),
  requestDataflareStreamParent: vi.fn(),
}))

const {
  createDataflareEmbedIntegration,
  isHostDocumentSource,
  resolveHostDocumentFile,
} = await import('../../src/dataflare/integration')

const fetchMock = vi.fn()

beforeEach(() => {
  captured = {}
  fetchMock.mockReset()
  // Standalone page: parent === self, served from the root.
  const win = { location: { pathname: '/pdf/' } } as unknown as Window & { parent: unknown }
  win.parent = win
  vi.stubGlobal('window', win)
  vi.stubGlobal('localStorage', { getItem: () => 'tok' })
  vi.stubGlobal('fetch', fetchMock)
})

afterEach(() => {
  vi.unstubAllGlobals()
})

function makeIntegration() {
  const openBytes = vi.fn(async (_bytes: ArrayBuffer, name: string) => `/tmp/${name}`)
  const saveLocal = vi.fn(async () => ({ ok: true }))
  const integration = createDataflareEmbedIntegration({
    app: 'pdf',
    transport: { invoke: vi.fn() },
    openBytes,
    saveLocal,
    shouldAutoOpen: () => false,
  })
  integration.install({})
  return { integration, openBytes, saveLocal }
}

function init(context: Record<string, unknown>): void {
  captured.onCommand?.({ type: 'init', sessionId: 'sess-1', context })
}

describe('host document helpers', () => {
  it('treats knowledge and drive as host documents, office as local', () => {
    expect(isHostDocumentSource('knowledge')).toBe(true)
    expect(isHostDocumentSource('drive')).toBe(true)
    expect(isHostDocumentSource('office')).toBe(false)
    expect(isHostDocumentSource(undefined)).toBe(false)
  })

  it('maps document types to extension + MIME, defaulting to docx', () => {
    expect(resolveHostDocumentFile('pdf')).toEqual({ extension: 'pdf', contentType: 'application/pdf' })
    expect(resolveHostDocumentFile(undefined).extension).toBe('docx')
  })
})

describe('drive documents', () => {
  it('downloads from the session content route and opens with the type extension', async () => {
    const { integration, openBytes } = makeIntegration()
    init({ documentId: 'abc', documentSource: 'drive', documentType: 'pdf' })
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1, 2]), { headers: { 'X-Office-Revision': '42' } }))

    await integration.openKnowledgeDocument()

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/crmapi/drive/office-sessions/abc/content')
    expect(openBytes).toHaveBeenCalledWith(expect.any(ArrayBuffer), 'dataflare-abc.pdf')
    expect(integration.getRevision()).toBe('42')
  })

  it('saves to the session save route with expectedRevision and a pdf part', async () => {
    const { integration, saveLocal } = makeIntegration()
    init({ documentId: 'abc', documentSource: 'drive', documentType: 'pdf' })
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { ETag: '"7"' } }))
    await integration.openKnowledgeDocument()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, data: { revision: '8' } }), { headers: { 'content-type': 'application/json' } }),
    )

    const result = await integration.saveDocument('/tmp/x.pdf', new ArrayBuffer(3), false)

    expect(result).toEqual({ ok: true, revision: '8' })
    expect(saveLocal).not.toHaveBeenCalled()
    const [url, init2] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe('/crmapi/drive/office-sessions/abc/save')
    const form = init2.body as FormData
    expect(form.get('expectedRevision')).toBe('7')
    const file = form.get('file') as File
    expect(file.type).toBe('application/pdf')
    expect(file.name).toBe('pdf-drive.pdf')
    expect(integration.getRevision()).toBe('8')
  })

  it('maps a business 409 to external-modified', async () => {
    const { integration } = makeIntegration()
    init({ documentId: 'abc', documentSource: 'drive', documentType: 'pdf' })
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 409, msg: 'conflict' }), { headers: { 'content-type': 'application/json' } }),
    )

    const result = await integration.saveDocument('/tmp/x.pdf', new ArrayBuffer(1), false)

    expect(result).toMatchObject({ ok: false, reason: 'external-modified', error: 'conflict' })
  })
})

describe('knowledge documents keep their routes', () => {
  it('downloads and saves on /crmapi/knowledge/office/{id}', async () => {
    const { integration } = makeIntegration()
    init({ documentId: '9', documentSource: 'knowledge', documentType: 'docx' })
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'X-Office-Revision': '3' } }))
    await integration.openKnowledgeDocument()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, data: { revision: '4' } }), { headers: { 'content-type': 'application/json' } }),
    )
    await integration.saveDocument('', new ArrayBuffer(1), false)

    expect(fetchMock.mock.calls[0]?.[0]).toBe('/crmapi/knowledge/office/9')
    expect(fetchMock.mock.calls[1]?.[0]).toBe('/crmapi/knowledge/office/9')
    expect(((fetchMock.mock.calls[1]?.[1] as RequestInit).body as FormData).get('file')).toMatchObject({
      name: 'pdf-knowledge.docx',
    })
  })

  it('office source still saves locally', async () => {
    const { integration, saveLocal } = makeIntegration()
    init({ documentId: '9', documentSource: 'office', documentType: 'docx' })
    await integration.saveDocument('/tmp/a.docx', new ArrayBuffer(1), true)
    expect(saveLocal).toHaveBeenCalledWith('/tmp/a.docx', expect.any(ArrayBuffer), true)
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('save as a new file (translation output)', () => {
  it('posts to /save-as with the file name and without an optimistic-lock base', async () => {
    const { integration } = makeIntegration()
    init({ documentId: 'abc', documentSource: 'drive', documentType: 'docx' })
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'X-Office-Revision': '7' } }))
    await integration.openKnowledgeDocument()
    fetchMock.mockResolvedValueOnce(
      new Response(JSON.stringify({ code: 0, data: { revision: '7', itemId: '55', versionId: '9' } }), {
        headers: { 'content-type': 'application/json' },
      }),
    )

    const result = await integration.saveDocument('', new ArrayBuffer(3), false, {
      saveAsFileName: '报价单.bilingual.docx',
    })

    const [url, init2] = fetchMock.mock.calls[1] as [string, RequestInit]
    expect(url).toBe(
      `/crmapi/drive/office-sessions/abc/save-as?fileName=${encodeURIComponent('报价单.bilingual.docx')}`,
    )
    // No expectedRevision: a sibling file has no lock base, and sending the open
    // document's revision would make the host think we are racing ourselves.
    expect((init2.body as FormData).get('expectedRevision')).toBeNull()
    expect(result).toMatchObject({ ok: true, savedAs: { fileName: '报价单.bilingual.docx', itemId: '55' } })
    // The open document did not move; claiming it did would make the next
    // Ctrl+S fail with a conflict that never happened.
    expect(integration.getRevision()).toBe('7')
  })

  it('refuses instead of overwriting the original when the document has no drive location', async () => {
    const { integration } = makeIntegration()
    init({ documentId: '9', documentSource: 'knowledge', documentType: 'docx' })

    const result = await integration.saveDocument('', new ArrayBuffer(1), false, {
      saveAsFileName: '译文.docx',
    })

    // Silently saving over the source is precisely what "save as" promises not to
    // do; the user would only learn it after losing the original.
    expect(result).toMatchObject({ ok: false, reason: 'save-failed' })
    expect(fetchMock).not.toHaveBeenCalled()
  })
})

describe('save-as content type override', () => {
  const DOCX_MIME = 'application/vnd.openxmlformats-officedocument.wordprocessingml.document'
  const ok = (data: Record<string, unknown>) =>
    new Response(JSON.stringify({ code: 0, data }), {
      headers: { 'content-type': 'application/json' },
    })

  it('files a save-as under the type the caller states, not the open document type', async () => {
    // The pdf app's PDF→DOCX fallback hands DOCX bytes to a session whose
    // documentType is `pdf`. Deriving the type from the context would file an
    // editable Word document as application/pdf, and the drive would then try
    // to render it as a PDF.
    const { integration } = makeIntegration()
    init({ documentId: 'abc', documentSource: 'drive', documentType: 'pdf' })
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'X-Office-Revision': '7' } }))
    await integration.openKnowledgeDocument()
    fetchMock.mockResolvedValueOnce(ok({ revision: '7', itemId: '77', versionId: '9' }))

    await integration.saveDocument('', new ArrayBuffer(8), false, {
      saveAsFileName: '手册.editable.docx',
      contentType: DOCX_MIME,
    })

    const body = (fetchMock.mock.calls[1]?.[1] as RequestInit).body as FormData
    expect((body.get('file') as Blob).type).toBe(DOCX_MIME)
  })

  it('ignores the override for a normal save — a new version is the same kind of document', async () => {
    const { integration } = makeIntegration()
    init({ documentId: 'abc', documentSource: 'drive', documentType: 'pdf' })
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'X-Office-Revision': '42' } }))
    await integration.openKnowledgeDocument()
    fetchMock.mockResolvedValueOnce(ok({ revision: '43' }))

    await integration.saveDocument('', new ArrayBuffer(8), false, { contentType: DOCX_MIME })

    const body = (fetchMock.mock.calls[1]?.[1] as RequestInit).body as FormData
    // The open document is still a PDF; a version bump must say so.
    expect((body.get('file') as Blob).type).toBe('application/pdf')
  })

  it('leaves a save-as without an override on the derived type', async () => {
    const { integration } = makeIntegration()
    init({ documentId: 'abc', documentSource: 'drive', documentType: 'pdf' })
    fetchMock.mockResolvedValueOnce(new Response(new Uint8Array([1]), { headers: { 'X-Office-Revision': '7' } }))
    await integration.openKnowledgeDocument()
    fetchMock.mockResolvedValueOnce(ok({ revision: '7', itemId: '55' }))

    await integration.saveDocument('', new ArrayBuffer(8), false, {
      saveAsFileName: '手册.pdf',
    })

    const body = (fetchMock.mock.calls[1]?.[1] as RequestInit).body as FormData
    expect((body.get('file') as Blob).type).toBe('application/pdf')
  })
})

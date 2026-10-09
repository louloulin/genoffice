import { afterEach, describe, expect, it } from 'vitest'
import { fileURLToPath } from 'node:url'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { startUiHost, type UiHostHandle } from '../src/ui/host'
import { STUBBED_SLIDES_CHANNELS } from '../src/ui/handlers/slides'

const SLIDES_RENDERER_DIR = fileURLToPath(new URL('../../../apps/slides/out/renderer', import.meta.url))
const FIXTURE_PPTX = fileURLToPath(
  new URL('../../pptx-engine/tests/fixtures/01_standard_business.pptx', import.meta.url),
)

/** The full render tree the edit channels answer with. */
interface RenderNode {
  id: string
  type: string
  sourceId: string
  text?: { lines: Array<{ runs: Array<{ text: string }> }> }
}
interface RenderSlide {
  widthPx: number
  heightPx: number
  nodes: RenderNode[]
}
/** The slide-strip projection `slides:get-render-slides` answers with. */
interface SlideStripItem {
  index: number
  hidden: boolean
  hasNotes: boolean
  name: string
}
interface OpenResult {
  path: string
  name: string
  slides: RenderSlide[]
  size: { cx: number; cy: number }
  defaultFont?: string
}

let host: UiHostHandle | null = null

async function bootHost(): Promise<UiHostHandle> {
  const { mkdtempSync, symlinkSync } = await import('node:fs')
  const { tmpdir } = await import('node:os')
  const root = mkdtempSync(join(tmpdir(), 'office-ai-slides-'))
  symlinkSync(SLIDES_RENDERER_DIR, join(root, 'slides'), 'dir')
  host = await startUiHost({ assetsDir: root, token: '' })
  return host
}

afterEach(async () => {
  if (host) {
    await host.close()
    host = null
  }
})

async function invoke(
  channel: string,
  args: unknown[] = [],
  session = 'slides-session',
): Promise<{ status: number; body: { result?: any; error?: { code: string; message: string } } }> {
  const response = await fetch(`${host!.url}/api/ipc/${encodeURIComponent(channel)}`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', 'x-ipc-session': session },
    body: JSON.stringify({ args }),
  })
  return { status: response.status, body: await response.json() }
}

/** Stage the fixture and register it as the session's current deck. */
async function openFixture(name = '01_standard_business.pptx'): Promise<{
  staged: { path: string }
  opened: OpenResult
}> {
  const staged = host!.open('slides', new Uint8Array(readFileSync(FIXTURE_PPTX)), { name })
  const opened = await invoke('slides:open-path', [staged.path])
  expect(opened.status).toBe(200)
  return { staged, opened: opened.body.result as OpenResult }
}

/** All text on a page, flattened. Runs are word-wrapped by the layout pass, so
 *  whitespace is collapsed — otherwise "OFFICE-AI-WAS-HERE" comes back split
 *  across four runs and a substring check on the raw runs is a false red. */
function pageText(slides: RenderSlide[], index: number): string {
  return (slides[index]?.nodes ?? [])
    .flatMap((n) => n.text?.lines ?? [])
    .flatMap((l) => l.runs.map((r) => r.text))
    .join(' ')
    .replace(/\s+/g, '')
}

/**
 * Collect `slides:history-changed` pushes on the renderer's SSE stream.
 * The renderer subscribes once at mount and never asks again, so this event is
 * the only thing that enables its Undo/Redo buttons.
 */
async function collectHistoryNotifications(
  run: () => Promise<void>,
): Promise<Array<{ canUndo: boolean; canRedo: boolean }>> {
  const seen: Array<{ canUndo: boolean; canRedo: boolean }> = []
  const controller = new AbortController()
  const response = await fetch(`${host!.url}/api/ipc/events?session=slides-session`, {
    headers: { Accept: 'text/event-stream' },
    signal: controller.signal,
  })
  const reader = response.body!.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  const pump = (async () => {
    try {
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        buffer += decoder.decode(value, { stream: true })
        for (const frame of buffer.split('\n\n')) {
          for (const line of frame.split('\n')) {
            if (!line.startsWith('data:')) continue
            const payload = JSON.parse(line.slice(5)) as { channel: string; args: unknown[] }
            if (payload.channel === 'slides:history-changed') {
              seen.push(payload.args[0] as { canUndo: boolean; canRedo: boolean })
            }
          }
        }
        buffer = ''
      }
    } catch {
      /* aborted */
    }
  })()
  await run()
  // The notification is deferred to the turn boundary; give it a turn to land.
  await new Promise((resolve) => setTimeout(resolve, 50))
  controller.abort()
  await pump
  return seen
}

describe('slides handlers (M3)', () => {
  it('opens a pptx and renders every slide plus the slide strip', async () => {
    await bootHost()
    const { opened } = await openFixture()
    expect(opened.slides.length).toBeGreaterThan(1)
    expect(opened.size.cx).toBeGreaterThan(0)
    expect(opened.name).toBe('01_standard_business.pptx')
    // A render page is sized in px and carries the element tree the edit
    // channels address by `sourceId`.
    expect(opened.slides[0].widthPx).toBeGreaterThan(0)
    expect(opened.slides[0].nodes.length).toBeGreaterThan(0)
    expect(opened.slides[0].nodes[0].sourceId).toBeTruthy()

    const strip = await invoke('slides:get-render-slides', [])
    const items = strip.body.result as SlideStripItem[]
    expect(items.length).toBe(opened.slides.length)
    expect(items[0].index).toBe(0)
    expect(items[0].name).toBe('Slide 1')
    expect(typeof items[0].hidden).toBe('boolean')
  })

  it('rejects a path outside the workspace', async () => {
    await bootHost()
    const outside = await invoke('slides:open-path', ['/etc/hosts'])
    expect(outside.status).toBe(400)
    expect(outside.body.error?.code).toBe('OFFICE_BAD_INPUT')
  })

  it('edits an element and saves a real pptx that re-opens with the edit intact', async () => {
    await bootHost()
    const { staged, opened } = await openFixture()
    const target = opened.slides[0].nodes.find((n) => n.type === 'text') ?? opened.slides[0].nodes[0]
    expect(target).toBeDefined()

    const edited = await invoke('slides:edit-text', [
      {
        slideIndex: 0,
        sourceId: target.sourceId,
        paragraphs: [{ runs: [{ text: 'OFFICE-AI-WAS-HERE' }] }],
      },
    ])
    expect(edited.status).toBe(200)
    expect(pageText([edited.body.result], 0)).toContain('OFFICE-AI-WAS-HERE')

    const dirty = await invoke('slides:is-dirty', [opened.path])
    expect(dirty.body.result).toBe(true)

    const saved = await invoke('slides:save', [staged.path])
    expect(saved.status).toBe(200)
    expect(saved.body.result.ok).toBe(true)

    // Reopen the saved bytes under a brand-new path: the edit must be in the
    // package on disk, not just in the in-memory model.
    const copy = host!.context.workspace.stageBytes('reopened.pptx', host!.readFile(staged.path))
    const reopened = await invoke('slides:open-path', [copy])
    expect(reopened.status).toBe(200)
    const after = reopened.body.result as OpenResult
    expect(after.path).toBe(copy)
    expect(pageText(after.slides, 0)).toContain('OFFICE-AI-WAS-HERE')
  })

  it('adds a text element and returns the id the op minted', async () => {
    await bootHost()
    await openFixture()
    const added = await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'text', text: 'added-by-office-ai', xPx: 40, yPx: 40, wPx: 240, hPx: 60 },
    ])
    expect(added.status).toBe(200)
    const result = added.body.result as { slide: RenderSlide; sourceId: string }
    expect(typeof result.sourceId).toBe('string')
    expect(result.sourceId.length).toBeGreaterThan(0)
    // The id the op minted must be the id the re-rendered page carries, or the
    // renderer would select an element that does not exist.
    expect(result.slide.nodes.map((n) => n.sourceId)).toContain(result.sourceId)
    expect(pageText([result.slide], 0)).toContain('added-by-office-ai')
  })

  it("refuses to reach another session's open deck through apply-txn or save", async () => {
    await bootHost()
    const { staged, opened } = await openFixture()
    const before = (await invoke('slides:get-render-slides', [])).body.result

    // A second client names the first client's deck. Its own session has no
    // open deck, so there is nothing to mutate — regardless of the path it
    // supplies.
    const hijackTxn = await invoke(
      'slides:apply-txn',
      [{ path: opened.path, ops: [{ op: 'setHidden', target: { slide: 0 }, hidden: true }] }],
      'intruder-session',
    )
    expect(hijackTxn.body.result.applied).toBe(false)
    expect(hijackTxn.body.result.failures[0].error).toContain('slides:open-path')

    // Same for the write path: the deck on disk must be untouched.
    const bytesBefore = readFileSync(staged.path)
    const hijackSave = await invoke('slides:save', [opened.path, null], 'intruder-session')
    expect(hijackSave.body.result.ok).toBe(false)
    expect(hijackSave.body.result.error).toContain('slides:open-path')
    expect(readFileSync(staged.path).equals(bytesBefore)).toBe(true)

    // And the owner still sees its deck unchanged, dirty flag intact.
    const after = (await invoke('slides:get-render-slides', [])).body.result
    expect(JSON.stringify(after)).toBe(JSON.stringify(before))
    expect((await invoke('slides:is-dirty', [])).body.result).toBe(false)
  })

  it('runs a transaction through slides:apply-txn and reports per-op failures', async () => {
    await bootHost()
    const { opened } = await openFixture()

    const ok = await invoke('slides:apply-txn', [
      { path: opened.path, isolation: 'atomic', ops: [{ op: 'setHidden', target: { slide: 0 }, hidden: true }] },
    ])
    expect(ok.body.result.applied).toBe(true)
    expect(ok.body.result.slides[0]).toMatchObject({ index: 0 })

    // The renderer's ApplyTxnOp carries no path, so the session is the only
    // authority — an echo of the session's own path stays accepted.
    const noPath = await invoke('slides:apply-txn', [
      { ops: [{ op: 'setHidden', target: { slide: 1 }, hidden: true }] },
    ])
    expect(noPath.body.result.applied).toBe(true)

    const otherPath = await invoke('slides:apply-txn', [
      { path: '/definitely/not/registered.pptx', ops: [{ op: 'setHidden', target: { slide: 0 } }] },
    ])
    expect(otherPath.body.result.applied).toBe(false)
    expect(otherPath.body.result.failures[0].error).toContain('does not match')

    const badOp = await invoke('slides:apply-txn', [
      { path: opened.path, ops: [{ op: 'deleteElement', target: { slide: 0, el: 'does-not-exist' } }] },
    ])
    expect(badOp.body.result.applied).toBe(false)
    expect(badOp.body.result.failures.length).toBeGreaterThan(0)

    const empty = await invoke('slides:apply-txn', [{ path: opened.path, ops: [] }])
    expect(empty.body.result.applied).toBe(true)
  })

  it('undoes an element edit back to the pre-edit render', async () => {
    await bootHost()
    const { opened } = await openFixture()
    const before = JSON.stringify(opened.slides)

    const added = await invoke('slides:add-element', [
      { slideIndex: 0, kind: 'text', text: 'temporary', xPx: 10, yPx: 10, wPx: 100, hPx: 30 },
    ])
    expect(JSON.stringify((added.body.result as { slide: RenderSlide }).slide)).not.toBe(before)

    const undone = await invoke('slides:undo', [])
    expect(undone.status).toBe(200)
    expect(JSON.stringify(undone.body.result)).toBe(before)

    const redone = await invoke('slides:redo', [])
    expect(JSON.stringify(redone.body.result)).not.toBe(before)
  })

  it('keeps the element clipboard in-host so copy → paste round-trips', async () => {
    await bootHost()
    const { opened } = await openFixture()
    const sourceId = opened.slides[0].nodes[0].sourceId

    const copied = await invoke('slides:copy-elements', [{ slideIndex: 0, sourceIds: [sourceId] }])
    expect(copied.body.result).toBe(1)

    const pasted = await invoke('slides:paste-elements', [{ slideIndex: 0, dxPx: 20, dyPx: 20 }])
    expect(pasted.status).toBe(200)
    const result = pasted.body.result as { slide: RenderSlide; sourceIds: string[] }
    expect(result.sourceIds.length).toBe(1)
    expect(result.slide.nodes.map((n) => n.sourceId)).toContain(result.sourceIds[0])
  })

  it('answers null (never a truthy error object) when no deck is open', async () => {
    await bootHost()
    for (const channel of ['slides:undo', 'slides:redo', 'slides:edit-text', 'slides:add-element']) {
      const res = await invoke(channel, [{ slideIndex: 0, sourceId: 'x', paragraphs: [] }])
      expect(res.status, channel).toBe(200)
      expect(res.body.result, channel).toBeNull()
    }
  })

  it('acknowledges every documented stub channel instead of 404-ing', async () => {
    await bootHost()
    for (const channel of Object.keys(STUBBED_SLIDES_CHANNELS)) {
      const res = await invoke(channel, [])
      expect(res.status, channel).toBe(200)
      expect(res.body.result, channel).toEqual({ ok: true, acknowledgedOnly: true })
    }
  })

  it('pushes slides:history-changed so the renderer can enable Undo/Redo', async () => {
    await bootHost()
    await openFixture()

    const notifications = await collectHistoryNotifications(async () => {
      await invoke('slides:add-element', [
        { slideIndex: 0, kind: 'text', text: 'undo-me', xPx: 10, yPx: 10, wPx: 100, hPx: 30 },
      ])
    })
    expect(notifications.at(-1)).toEqual({ canUndo: true, canRedo: false })

    const afterUndo = await collectHistoryNotifications(async () => {
      await invoke('slides:undo', [])
    })
    expect(afterUndo.at(-1)).toEqual({ canUndo: false, canRedo: true })

    // A failed op pushes then pops a snapshot; the settled state (still one
    // undo step, no redo) is what must reach the renderer, not the transient one.
    const afterFailure = await collectHistoryNotifications(async () => {
      await invoke('slides:delete-element', [
        { slideIndex: 0, sourceId: 'no-such-element' },
      ])
    })
    expect(afterFailure.at(-1)).toEqual({ canUndo: false, canRedo: true })
  })

  it('reads and confines slides:files-* paths to the workspace', async () => {
    await bootHost()
    const target = host!.context.workspace.stageBytes(
      'note.txt',
      new Uint8Array(Buffer.from('hello office-ai', 'utf8')),
    )
    const read = await invoke('slides:files-read', [target, 0, 100])
    expect(read.body.result.ok).toBe(true)
    expect(read.body.result.text).toBe('hello office-ai')
    expect(read.body.result.totalChars).toBe('hello office-ai'.length)

    const outside = await invoke('slides:files-read', ['/etc/hosts', 0, 10])
    expect(outside.body.result.ok).toBe(false)
  })

  it('registers every slides channel the plan requires', async () => {
    await bootHost()
    const body = (await (await fetch(`${host!.url}/api/channels`)).json()) as { channels: string[] }
    for (const channel of [
      'slides:new-blank',
      'slides:open',
      'slides:open-path',
      'slides:save',
      'slides:save-as',
      'slides:export-images',
      'slides:get-render-slides',
      'slides:apply-txn',
      'slides:undo',
      'slides:redo',
      'slides:master-enter',
      'slides:master-open',
      'slides:master-edit-transform',
      'slides:files-add',
    ]) {
      expect(body.channels, channel).toContain(channel)
    }
  })
})
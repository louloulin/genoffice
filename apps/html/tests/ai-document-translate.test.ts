/**
 * HTML whole-document / selection / bilingual translation (A51/A52).
 *
 * The adapter is two halves — extract translatable text nodes out of the parse
 * map, and write settled translations back through the same `HtmlOp` layer the
 * AI's `apply_ops` tool and the manual UI compile. These tests pin both halves
 * plus the wiring into `translateDocument`, because the failure mode they guard
 * against is silent: a write-back that addresses the wrong text node still
 * produces a *translated* document, just not the one the user asked for.
 */
import { describe, expect, it } from 'vitest'
import type { TranslateBatchFn, TranslatedUnit } from '@genoffice/translation-core/document'
import { buildParseMap } from '../src/renderer/document/parse-map'
import { compileOps, type HtmlOp, type OpError } from '../src/renderer/document/ops'
import { applyPatches } from '../src/renderer/document/patch'
import {
  applyHtmlTranslations,
  buildHtmlApplyOps,
  extractHtmlTextNodes,
  htmlTextNodesToUnits,
  parseHtmlUnitId,
  translateHtmlDocument,
} from '../src/renderer/ai/document-translate'

const DOC = `<!doctype html>
<html>
<head><title>T</title><style>.card { color: red; }</style></head>
<body>
  <section class="hero">
    <h1 id="title">Hello &amp; welcome</h1>
    <p class="lead">First paragraph.</p>
    <p>Inline <b>bold</b> tail</p>
  </section>
  <ul>
    <li>one</li>
    <li>two</li>
  </ul>
  <pre><code>const a = 1</code></pre>
  <script>var a = 1</script>
</body>
</html>
`

/** A minimal stand-in for the app: text lives here, ops go through the real compiler. */
function makeApp(html: string) {
  let text = html
  let version = 1
  const map = () => buildParseMap(text, version)
  const applyOps = (
    ops: HtmlOp[],
    _manual: boolean,
  ): { ok: true; ranges: Array<[number, number]> } | { ok: false; errors: OpError[] } => {
    const compiled = compileOps(text, map(), ops)
    if (compiled.errors.length) return { ok: false, errors: compiled.errors }
    text = applyPatches(text, compiled.patches)
    version++
    return { ok: true, ranges: [] }
  }
  return { getText: () => text, map, applyOps }
}

/** Translation that is trivially distinguishable from its source. */
function echoing(map?: Record<string, string>): TranslateBatchFn {
  return async (request, _signal, onUnit) => {
    const units = request.units.map((unit) => ({
      unitId: unit.unitId,
      sourceText: unit.sourceText,
      translatedText: map?.[unit.sourceText] ?? `[${unit.sourceText}]`,
      status: 'translated' as const,
    }))
    for (const unit of units) await onUnit?.(unit)
    return { ok: true, units }
  }
}

describe('extractHtmlTextNodes (A51)', () => {
  it('takes prose text nodes and skips script/style/pre/code/title', () => {
    const nodes = extractHtmlTextNodes(DOC, buildParseMap(DOC, 1))
    // Document order, not element order: `<p>Inline <b>bold</b> tail</p>` yields
    // the inline `<b>`'s node *between* the paragraph's own two — otherwise a
    // bilingual run would join the fragments as `[Inline] [tail] [bold]`.
    expect(nodes.map((n) => `${n.tag}:${n.text}`)).toEqual([
      'h1:Hello & welcome',
      'p:First paragraph.',
      'p:Inline',
      'b:bold',
      'p:tail',
      'li:one',
      'li:two',
    ])
    // A translated code block is a broken program; a translated page title is
    // not something a user asked for.
    expect(nodes.some((n) => n.text.includes('const a = 1'))).toBe(false)
    expect(nodes.some((n) => n.text.includes('var a = 1'))).toBe(false)
    expect(nodes.some((n) => n.tag === 'title')).toBe(false)
  })

  it('decodes entities and carries the separating whitespace through', () => {
    const html = '<p>Hello <b>world</b>!</p>'
    const nodes = extractHtmlTextNodes(html, buildParseMap(html, 1))
    const hello = nodes.find((n) => n.text === 'Hello')!
    const world = nodes.find((n) => n.text === 'world')!
    // `Hello ` and `!` — the trailing space is document content, not padding.
    expect(hello.lead).toBe('')
    expect(hello.trail).toBe(' ')
    // A bare `!` is not worth a provider call.
    expect(nodes.some((n) => n.text === '!')).toBe(false)
    expect(world.lead).toBe('')
    expect(world.trail).toBe('')
  })

  it('never treats a range that spans closing tags as a text node', () => {
    // parse5 hangs the after-`</body>` whitespace on body's last text node and
    // gives that node a location covering the end tags; translating it would
    // overwrite `</body></html>`.
    const html = '<body><p>Text.</p>\n</body>\n</html>\n'
    const nodes = extractHtmlTextNodes(html, buildParseMap(html, 1))
    expect(nodes.map((n) => `${n.tag}:${n.text}`)).toEqual(['p:Text.'])
  })

  it('anchors a bilingual insertion on the nearest block ancestor', () => {
    const html = '<p>Inline <b>bold</b> tail</p>'
    const map = buildParseMap(html, 1)
    const nodes = extractHtmlTextNodes(html, map)
    const p = map.elements.find((e) => e.tag === 'p')!
    // The inline `<b>` is not a block: its translation belongs after the `<p>`.
    for (const node of nodes) expect(node.blockSid).toBe(p.sid)
    expect(nodes.every((n) => n.blockTag === 'p')).toBe(true)
  })

  it('a window restricts extraction to one text node', () => {
    const html = '<p>Alpha.</p><p>Beta.</p>'
    const map = buildParseMap(html, 1)
    const all = extractHtmlTextNodes(html, map)
    const beta = all.find((n) => n.text === 'Beta.')!
    const only = extractHtmlTextNodes(html, map, { sid: beta.sid, index: beta.index })
    expect(only.map((n) => n.text)).toEqual(['Beta.'])
  })

  it('maps unit ids round-trippably', () => {
    const html = '<h2>Title</h2><ul><li>one</li></ul><table><tr><td>c</td></tr></table>'
    const nodes = extractHtmlTextNodes(html, buildParseMap(html, 1))
    const units = htmlTextNodesToUnits(nodes)
    expect(units.map((u) => u.kind)).toEqual(['heading', 'list-item', 'table-cell'])
    expect(units.map((u) => u.unitId)).toEqual(
      nodes.map((n) => `html:${n.sid}:${n.index}`),
    )
    expect(parseHtmlUnitId(units[0]!.unitId)).toEqual({
      sid: nodes[0]!.sid,
      index: nodes[0]!.index,
    })
    expect(parseHtmlUnitId('md:4:0')).toBeNull()
    expect(parseHtmlUnitId('html:x:0')).toBeNull()
    expect(parseHtmlUnitId('html:4')).toBeNull()
  })
})

describe('buildHtmlApplyOps (A51)', () => {
  const settledFrom = (html: string, translated: (source: string) => string): TranslatedUnit[] => {
    const nodes = extractHtmlTextNodes(html, buildParseMap(html, 1))
    return htmlTextNodesToUnits(nodes).map((unit) => ({
      ...unit,
      translatedText: translated(unit.sourceText),
      status: 'translated' as const,
    }))
  }

  it('replace rewrites each text node in place, restoring its separators', () => {
    const html = '<p>Hello <b>world</b></p>'
    const ops = buildHtmlApplyOps(settledFrom(html, (s) => s.toUpperCase()), 'replace')
    expect(ops).toEqual([
      { op: 'set_text_node', sid: expect.any(Number), index: 0, text: 'HELLO ' },
      { op: 'set_text_node', sid: expect.any(Number), index: 0, text: 'WORLD' },
    ])
    // The two ops address different nodes (`<p>`'s own, then `<b>`'s).
    expect((ops[0] as { sid: number }).sid).not.toBe((ops[1] as { sid: number }).sid)
  })

  it('bilingual inserts one translated block per source block, reusing its tag', () => {
    const html = '<ul><li>one</li><li>two</li></ul>'
    const map = buildParseMap(html, 1)
    const lis = map.elements.filter((e) => e.tag === 'li')
    const ops = buildHtmlApplyOps(settledFrom(html, (s) => `[${s}]`), 'bilingual')
    expect(ops).toEqual([
      { op: 'insert_html', sid: lis[0]!.sid, position: 'after', html: '<li>[one]</li>' },
      { op: 'insert_html', sid: lis[1]!.sid, position: 'after', html: '<li>[two]</li>' },
    ])
  })

  it('bilingual collapses a block whose text arrives as several units into one insertion', () => {
    const html = '<p>Inline <b>bold</b></p>'
    const map = buildParseMap(html, 1)
    const p = map.elements.find((e) => e.tag === 'p')!
    const ops = buildHtmlApplyOps(settledFrom(html, (s) => `[${s}]`), 'bilingual')
    expect(ops).toEqual([
      { op: 'insert_html', sid: p.sid, position: 'after', html: '<p>[Inline] [bold]</p>' },
    ])
  })

  it('bilingual keeps a trailing inline run in source order', () => {
    // The paragraph's own trailing text node is emitted after the inline `<b>`'s
    // in element order, which would assemble `[Inline] [tail] [bold]`.
    const html = '<p>Inline <b>bold</b> tail</p>'
    const map = buildParseMap(html, 1)
    const p = map.elements.find((e) => e.tag === 'p')!
    const ops = buildHtmlApplyOps(settledFrom(html, (s) => `[${s}]`), 'bilingual')
    expect(ops).toEqual([
      { op: 'insert_html', sid: p.sid, position: 'after', html: '<p>[Inline] [bold] [tail]</p>' },
    ])
  })

  it('bilingual falls back to <p> for a structural block that cannot hold prose', () => {
    const html = '<body>just text</body>'
    const map = buildParseMap(html, 1)
    const body = map.elements.find((e) => e.tag === 'body')!
    const ops = buildHtmlApplyOps(settledFrom(html, (s) => `[${s}]`), 'bilingual')
    expect(ops).toEqual([
      { op: 'insert_html', sid: body.sid, position: 'after', html: '<p>[just text]</p>' },
    ])
  })

  it('escapes markup in a translated string rather than injecting it', () => {
    const html = '<p>safe</p>'
    const ops = buildHtmlApplyOps(settledFrom(html, () => '<img src=x onerror=alert(1)>'), 'bilingual')
    expect((ops[0] as { html: string }).html).toBe('<p>&lt;img src=x onerror=alert(1)&gt;</p>')
  })
})

describe('translateHtmlDocument (A52)', () => {
  it('translates the whole document in place and keeps the markup', async () => {
    const app = makeApp('<section><h1>Title</h1><p>Hello world.</p></section>')
    const result = await translateHtmlDocument(
      { text: app.getText(), map: app.map(), translateBatch: echoing(), applyOps: app.applyOps },
      { targetLang: 'zh-CN', qualityCheck: false },
    )

    expect(result.status).toBe('completed')
    expect(result.applied).toBe(true)
    expect(result.mode).toBe('replace')
    expect(app.getText()).toBe('<section><h1>[Title]</h1><p>[Hello world.]</p></section>')
  })

  it('bilingual leaves the source untouched and appends the translation', async () => {
    const app = makeApp('<p>Hello world.</p>')
    const result = await translateHtmlDocument(
      { text: app.getText(), map: app.map(), translateBatch: echoing(), applyOps: app.applyOps },
      { targetLang: 'zh-CN', applyMode: 'bilingual', qualityCheck: false },
    )

    expect(result.mode).toBe('bilingual')
    expect(app.getText()).toBe('<p>Hello world.</p><p>[Hello world.]</p>')
  })

  it('a selection run only touches the node the window covers', async () => {
    const app = makeApp('<p>Alpha.</p><p>Beta.</p>')
    const beta = extractHtmlTextNodes(app.getText(), app.map()).find((n) => n.text === 'Beta.')!
    const result = await translateHtmlDocument(
      { text: app.getText(), map: app.map(), translateBatch: echoing(), applyOps: app.applyOps },
      {
        targetLang: 'zh-CN',
        scope: 'selection',
        selection: { sid: beta.sid, index: beta.index },
        qualityCheck: false,
      },
    )

    expect(result.status).toBe('completed')
    expect(app.getText()).toBe('<p>Alpha.</p><p>[Beta.]</p>')
  })

  it('refuses a selection run without a selected text node', async () => {
    const app = makeApp('<p>Alpha.</p>')
    await expect(
      translateHtmlDocument(
        { text: app.getText(), map: app.map(), translateBatch: echoing(), applyOps: app.applyOps },
        { targetLang: 'zh-CN', scope: 'selection', qualityCheck: false },
      ),
    ).rejects.toThrow(/选区翻译缺少选中的文本节点/)
  })

  it('reports failures instead of writing a failed unit as if it succeeded', async () => {
    const app = makeApp('<p>Good.</p><p>Bad.</p>')
    const batch: TranslateBatchFn = async (request) => ({
      ok: false,
      units: request.units.map((unit) =>
        unit.sourceText === 'Bad.'
          ? {
              unitId: unit.unitId,
              sourceText: unit.sourceText,
              status: 'failed' as const,
              errorMessage: 'credit balance is too low',
              errorCode: 'credits' as const,
            }
          : {
              unitId: unit.unitId,
              sourceText: unit.sourceText,
              translatedText: `[${unit.sourceText}]`,
              status: 'translated' as const,
            },
      ),
    })

    const result = await translateHtmlDocument(
      { text: app.getText(), map: app.map(), translateBatch: batch, applyOps: app.applyOps },
      { targetLang: 'zh-CN', qualityCheck: false },
    )

    expect(result.status).toBe('completed-with-failures')
    expect(result.failures.map((f) => f.errorCode)).toEqual(['credits'])
    // The successful node is written; the failed one keeps its source rather
    // than being blanked — a blank paragraph looks like a corrupt document.
    expect(app.getText()).toBe('<p>[Good.]</p><p>Bad.</p>')
  })

  it('forwards the checkpoint adapter so a resumed run does not re-bill', async () => {
    const app = makeApp('<p>One.</p><p>Two.</p>')
    const saved: string[] = []
    const result = await translateHtmlDocument(
      { text: app.getText(), map: app.map(), translateBatch: echoing(), applyOps: app.applyOps },
      {
        targetLang: 'zh-CN',
        qualityCheck: false,
        checkpoint: { load: () => null, save: (unitId) => void saved.push(unitId) },
      },
    )

    expect(result.status).toBe('completed')
    expect(saved).toHaveLength(2)
  })

  it('applyHtmlTranslations surfaces a compile error instead of a partial write', () => {
    const app = makeApp('<p>Hello.</p>')
    const nodes = extractHtmlTextNodes(app.getText(), app.map())
    const units = htmlTextNodesToUnits(nodes).map((u) => ({
      ...u,
      translatedText: '[Hello.]',
      status: 'translated' as const,
    }))
    // A unit whose target sid no longer exists in the live document.
    units[0] = { ...units[0]!, unitId: 'html:99999:0', metadata: { sid: 99999, index: 0 } }
    const result = applyHtmlTranslations({ applyOps: app.applyOps }, units, 'replace')
    expect(result.ok).toBe(false)
    expect(app.getText()).toBe('<p>Hello.</p>')
  })
})

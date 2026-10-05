#!/usr/bin/env node
/**
 * Web-served fonts must be woff2 (or woff); TTF is reserved for parser inputs.
 *
 * The embed path pays for every font byte the browser downloads, so a TTF that
 * reaches a renderer bundle is a transfer regression. Two families are exempt
 * because they are never web-served — the main process / worker reads them off
 * disk and parses outlines, and woff2 would break that:
 *
 *   - slides + shell out/main/chunks/*.ttf  → opentype.js metrics
 *     (apps/slides/src/main/fonts.ts imports Carlito via `?asset`; PPTX export
 *     line wrapping needs real glyf/cmap tables, not a compressed wrapper)
 *   - pdf out/renderer/pdfjs/standard_fonts/*.ttf → pdf.js FontLoader
 *     (pdfjs-dist 6.2.108 has no woff2 decoder; `standardFontDataUrl` feeds the
 *     bytes straight to its sfnt parser)
 *
 * Scope is the Liberation/Carlito/Caladea group the font-woff2 acceptance items
 * name. Other families are deliberately untouched here (markdown's KaTeX Math
 * set, CJK/Noto), so this gate does not become a repo-wide font audit.
 *
 * Two layers, because CI never builds the renderers:
 *   1. source — renderer CSS/TS must not reference a governed TTF/OTF. Runs
 *      everywhere, and is what actually stops a `.ttf` from creeping back into
 *      a stylesheet between releases.
 *   2. artifacts — built renderer output must contain no governed TTF. Skipped
 *      per-root when that root was never built, so a lint-only checkout still
 *      gets the source guarantee instead of a vacuous pass.
 *
 * Either layer fails the run. An exempt path that stops existing also fails, so
 * the exemption list cannot silently outlive its reason — but only once the app
 * it lives in has actually been built, since all three sit under gitignored
 * `out/`.
 */
import { existsSync, readFileSync, readdirSync, statSync } from 'node:fs'
import { join, relative, sep } from 'node:path'
import { fileURLToPath } from 'node:url'

const repoRoot = fileURLToPath(new URL('..', import.meta.url))

/** Directories whose build output is fetched by a browser. */
const RENDERER_ROOTS = [
  'apps/docs/out/renderer',
  'apps/sheets/out/renderer',
  'apps/slides/out/renderer',
  'apps/shell/out/renderer',
  'apps/pdf/out/renderer',
  'apps/markdown/out/renderer',
  'apps/html/out/renderer',
  'apps/sdk/dist',
]

/**
 * Parser-input TTFs that must keep existing, with the reason they cannot be
 * woff2. `requiredWhen` is the build output the exemption is asserted against:
 * all three live under gitignored `out/`, so on a checkout that never built the
 * app the file is legitimately absent. Asserting them unconditionally made this
 * gate exit 1 on every fresh CI run — a gate that is always red gets removed.
 */
const REQUIRED_EXEMPTIONS = [
  {
    path: 'apps/slides/out/main/chunks/Carlito-Regular-Cbe9FLjp.ttf',
    requiredWhen: 'apps/slides/out',
    why: 'opentype.js metrics',
  },
  {
    path: 'apps/shell/out/main/chunks/Carlito-Regular-Cbe9FLjp.ttf',
    requiredWhen: 'apps/shell/out',
    why: 'opentype.js metrics',
  },
  {
    path: 'apps/pdf/out/renderer/pdfjs/standard_fonts/LiberationSans-Regular.ttf',
    requiredWhen: 'apps/pdf/out',
    why: 'pdf.js FontLoader',
  },
]

/** Subpaths inside a renderer root that are parser assets, not web fonts. */
const RENDERER_EXEMPT_PREFIXES = ['apps/pdf/out/renderer/pdfjs/standard_fonts/']

/** The font group this change governs; other families are out of scope. */
const GOVERNED = /^(Liberation|Carlito|Caladea)[-.]/i

/** Source trees whose files the bundler turns into web-served assets. */
const SOURCE_ROOTS = ['apps', 'packages']

/** Renderer-facing source extensions worth scanning. */
const SOURCE_EXT = /\.(css|scss|ts|tsx)$/

/**
 * Source files allowed to name a governed TTF: main-process/worker/test code
 * that hands the bytes to a font parser rather than to the browser.
 */
const SOURCE_EXEMPT = new Map([
  ['apps/slides/src/main/fonts.ts', 'opentype.js metrics'],
  ['apps/slides/tests/embedded-fonts.test.ts', 'builds a raw sfnt fixture for opentype.js'],
])

/** `@font-face`/import references to a governed TTF, in url() or import form. */
const GOVERNED_REF = new RegExp(`fonts/(${GOVERNED.source.slice(1, -1)}[-\\w]*)\\.(ttf|otf)`, 'i')

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    if (entry === 'node_modules' || entry === 'out' || entry === 'dist') continue
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

function scanSource() {
  const hits = []
  for (const root of SOURCE_ROOTS) {
    const abs = join(repoRoot, root)
    if (!existsSync(abs)) continue
    for (const file of walk(abs)) {
      if (!SOURCE_EXT.test(file)) continue
      const rel = relative(repoRoot, file).split(sep).join('/')
      if (SOURCE_EXEMPT.has(rel)) continue
      readFileSync(file, 'utf8')
        .split('\n')
        .forEach((line, i) => {
          if (GOVERNED_REF.test(line)) hits.push(`${rel}:${i + 1}`)
        })
    }
  }
  return hits
}

const sourceHits = scanSource()
const offenders = []
const missingRoots = []
for (const root of RENDERER_ROOTS) {
  const abs = join(repoRoot, root)
  if (!existsSync(abs)) {
    missingRoots.push(root)
    continue
  }
  for (const file of walk(abs)) {
    if (!file.endsWith('.ttf') && !file.endsWith('.otf')) continue
    const name = file.slice(file.lastIndexOf(sep) + 1)
    if (!GOVERNED.test(name)) continue
    const rel = relative(repoRoot, file).split(sep).join('/')
    if (RENDERER_EXEMPT_PREFIXES.some((p) => rel.startsWith(p))) continue
    offenders.push(rel)
  }
}

const staleExemptions = [
  ...REQUIRED_EXEMPTIONS.filter(
    (e) => existsSync(join(repoRoot, e.requiredWhen)) && !existsSync(join(repoRoot, e.path)),
  ).map((e) => e.path),
  ...[...SOURCE_EXEMPT.keys()].filter((p) => !existsSync(join(repoRoot, p))),
]

if (sourceHits.length > 0 || offenders.length > 0 || staleExemptions.length > 0) {
  if (sourceHits.length > 0) {
    console.error('Renderer source references a Liberation/Carlito/Caladea TTF:')
    for (const h of sourceHits) console.error(`  ${h}`)
    console.error('\nPoint it at the woff2 twin, or move the reader into parser-input code.')
  }
  if (offenders.length > 0) {
    console.error('Web-served Liberation/Carlito/Caladea TTF found in renderer output:')
    for (const f of offenders) console.error(`  ${f}`)
    console.error('\nRebuild the affected app, or convert the source reference to a woff2 twin.')
  }
  if (staleExemptions.length > 0) {
    console.error('\nExempted parser-input paths are gone — drop the stale exemptions:')
    for (const f of staleExemptions) console.error(`  ${f}`)
  }
  process.exit(1)
}

if (missingRoots.length > 0) {
  console.warn(`Skipped ${missingRoots.length} unbuilt renderer root(s): ${missingRoots.join(', ')}`)
}
const assertedExemptions = REQUIRED_EXEMPTIONS.filter((e) => existsSync(join(repoRoot, e.requiredWhen)))
console.log(
  `Source: no governed TTF reference. Artifacts: none in ` +
    `${RENDERER_ROOTS.length - missingRoots.length} built renderer output(s). ` +
    `Parser-input exemptions: ${assertedExemptions.length}/${REQUIRED_EXEMPTIONS.length} asserted ` +
    `(${SOURCE_EXEMPT.size} source), the rest under unbuilt app output.`,
)

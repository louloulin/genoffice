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
 * Fails if a renderer output grows a TTF from that group, or if an exempt path
 * stops existing (so the exemption list cannot silently outlive its reason).
 */
import { existsSync, readdirSync, statSync } from 'node:fs'
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

/** Parser-input TTFs that must keep existing, with the reason they cannot be woff2. */
const REQUIRED_EXEMPTIONS = [
  { path: 'apps/slides/out/main/chunks/Carlito-Regular-Cbe9FLjp.ttf', why: 'opentype.js metrics' },
  { path: 'apps/shell/out/main/chunks/Carlito-Regular-Cbe9FLjp.ttf', why: 'opentype.js metrics' },
  { path: 'apps/pdf/out/renderer/pdfjs/standard_fonts/LiberationSans-Regular.ttf', why: 'pdf.js FontLoader' },
]

/** Subpaths inside a renderer root that are parser assets, not web fonts. */
const RENDERER_EXEMPT_PREFIXES = ['apps/pdf/out/renderer/pdfjs/standard_fonts/']

/** The font group this change governs; other families are out of scope. */
const GOVERNED = /^(Liberation|Carlito|Caladea)[-.]/i

function walk(dir, out = []) {
  for (const entry of readdirSync(dir)) {
    const full = join(dir, entry)
    if (statSync(full).isDirectory()) walk(full, out)
    else out.push(full)
  }
  return out
}

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

const staleExemptions = REQUIRED_EXEMPTIONS.filter((e) => !existsSync(join(repoRoot, e.path))).map((e) => e.path)

if (offenders.length > 0 || staleExemptions.length > 0) {
  if (offenders.length > 0) {
    console.error('Web-served Liberation/Carlito/Caladea TTF found in renderer output:')
    for (const f of offenders) console.error(`  ${f}`)
    console.error('\nConvert the source reference to a woff2 twin, or move the file to a parser-input path.')
  }
  if (staleExemptions.length > 0) {
    console.error('\nExempted parser-input fonts are gone — drop the stale exemptions:')
    for (const f of staleExemptions) console.error(`  ${f}`)
  }
  process.exit(1)
}

if (missingRoots.length > 0) {
  console.warn(`Skipped ${missingRoots.length} unbuilt renderer root(s): ${missingRoots.join(', ')}`)
}
console.log(
  `No web-served Liberation/Carlito/Caladea TTF in ${RENDERER_ROOTS.length - missingRoots.length} renderer output(s). ` +
    `Parser-input exemptions intact: ${REQUIRED_EXEMPTIONS.length}.`,
)

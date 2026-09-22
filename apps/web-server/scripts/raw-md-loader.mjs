/**
 * Node module loader for `?raw` markdown imports. The web-server
 * production bundle (apps/web-server/scripts/bundle.mjs) has its own
 * esbuild plugin and does NOT need this; this file is exclusively for
 * `npm run dev -w @genoffice/web-server` (tsx).
 *
 * Why we hook the load step instead of resolve:
 *   tsx 4.x ships its own ESM resolver and pre-rewrites `.md?raw`
 *   imports to its absolute URL BEFORE user loaders see them in
 *   resolve(). The specifier that reaches our load() is therefore
 *   already absolute (file:///…/text.md) and may keep the `?raw`
 *   suffix in the URL. We can read it there without depending on
 *   tsx's resolver chain.
 *
 * Behaviour:
 *   - load() recognises `?raw` in the incoming URL.
 *   - Strips the suffix, reads the file as UTF-8, emits a one-line
 *     module `export default <json-text>;`.
 *   - For non-raw URLs, delegates to nextLoad so we don't shadow
 *     anything else.
 */
import { readFileSync } from "node:fs"
import { fileURLToPath } from "node:url"

const RAW_QUERY = "?raw"

function urlLooksRaw(url) {
  return url.includes(RAW_QUERY)
}

export async function resolve(specifier, context, nextResolve) {
  return nextResolve(specifier, context)
}

export async function load(url, context, nextLoad) {
  if (!urlLooksRaw(url)) {
    return nextLoad(url, context)
  }
  const cleanedUrl = url.split(RAW_QUERY)[0]
  let path
  try {
    path = fileURLToPath(cleanedUrl)
  } catch {
    return nextLoad(url, context)
  }
  const text = readFileSync(path, "utf8")
  return {
    format: "module",
    shortCircuit: true,
    source: `export default ${JSON.stringify(text)};\n`,
  }
}

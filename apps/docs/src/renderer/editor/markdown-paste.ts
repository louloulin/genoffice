/**
 * Plain-text Markdown paste. Clipboards that carry only text/plain (fenced
 * code blocks, terminals, .md files in a text editor, LLM output) lose all
 * structure when pasted literally: "## Heading" keeps its hashes, "**bold**"
 * its asterisks. When such text looks like Markdown, it is converted to HTML
 * and inserted through the same pipeline as an HTML paste. Clipboards that
 * already carry text/html never reach this path.
 *
 * Detection errs toward literal paste: prose that merely mentions a "#" or a
 * lone "1." must not be reformatted, so conversion requires an unambiguous
 * Markdown construct (heading, fence, link, emphasis, table) or a repeated
 * one (several list/quote lines).
 */
import { marked } from 'marked'
import { looksLikeMarkdown } from './markdown-detect'

/**
 * HTML for a plain-text paste that looks like Markdown, or null to leave the
 * default literal paste in place. The output feeds the same DOM → ProseMirror
 * parse as a native HTML paste, so unknown elements degrade the same way.
 */
export function markdownPasteHtml(text: string): string | null {
  const normalized = text.replace(/\r\n?/g, '\n')
  if (!looksLikeMarkdown(normalized)) return null
  try {
    return marked.parse(normalized, { gfm: true, breaks: false, async: false })
  } catch {
    return null
  }
}

/// Markdown paste detection: constructs that essentially never appear in
/// prose accidentally. Regex-only — no parser dependency — so the paste
/// gate stays in the boot chunk while `marked` loads on first real paste.

/// Constructs that essentially never appear in prose accidentally.
const STRONG_SIGNALS: readonly RegExp[] = [
  /^#{1,6}\s+\S/m, // ATX heading
  /^\s{0,3}```/m, // fenced code block
  /\[[^\]\n]+\]\([^\s)]+\)/, // [text](url) link
  // **bold** only — the __bold__ form is indistinguishable from Python
  // dunder identifiers (__init__, __name__) and would convert pasted code.
  /(?:^|\W)\*\*[^*\n]+\*\*(?:\W|$)/,
  /^\s{0,3}\|.+\|\s*$\n^\s{0,3}\|[\s:|-]+\|\s*$/m, // table header + separator row
]

/// Constructs that appear in prose too; require several matching lines.
const LIST_LINE = /^\s{0,3}(?:[-*+]|\d{1,3}[.)])\s+\S/
const QUOTE_LINE = /^\s{0,3}>\s?\S/

export function looksLikeMarkdown(text: string): boolean {
  if (STRONG_SIGNALS.some((signal) => signal.test(text))) return true
  const lines = text.split('\n')
  const listLines = lines.filter((line) => LIST_LINE.test(line)).length
  const quoteLines = lines.filter((line) => QUOTE_LINE.test(line)).length
  return listLines >= 2 || quoteLines >= 2
}

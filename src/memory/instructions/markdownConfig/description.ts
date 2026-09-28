/**
 * A one-line description taken from a markdown body, for the files whose
 * frontmatter gives none. Callers pass the body: frontmatter is not skipped.
 */
const DEFAULT_DESCRIPTION = 'Custom item'
const MAX_DESCRIPTION_LENGTH = 100
const ELLIPSIS = '...'

/** Removed once, so `## # x` keeps `# x`; a lone `#` or a `#tag` stays. */
const HEADING_MARKER_RE = /^#+\s+/
const ENDS_IN_HIGH_SURROGATE_RE = /[\uD800-\uDBFF]$/

export function extractDescriptionFromMarkdown(
  content: string,
  defaultDescription: string = DEFAULT_DESCRIPTION,
): string {
  const firstLine = content.split('\n').find(line => line.trim() !== '')
  if (firstLine === undefined) return defaultDescription
  return shortened(firstLine.trim().replace(HEADING_MARKER_RE, ''))
}

function shortened(text: string): string {
  if (text.length <= MAX_DESCRIPTION_LENGTH) return text
  const cut = text.slice(0, MAX_DESCRIPTION_LENGTH - ELLIPSIS.length)
  // Lengths count UTF-16 units: an astral character across the cut goes
  // whole, rather than leaving half of it in front of the ellipsis.
  const whole = ENDS_IN_HIGH_SURROGATE_RE.test(cut) ? cut.slice(0, -1) : cut
  return `${whole}${ELLIPSIS}`
}

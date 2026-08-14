// Markdown scanner — ATX headings, fenced code blocks excluded.

import { MAX_SIGNATURE_CHARS } from 'src/tools/shared/codeOutline/internal.js'
import type { SymbolEntry } from 'src/tools/shared/codeOutline/types.js'


const RE_MD_HEADING = /^(#{1,6})\s+(.+?)\s*$/
const RE_MD_FENCE = /^ {0,3}(`{3,}|~{3,})/
const RE_MD_CLOSING_HASHES = /\s+#+$/

export function scanMarkdown(source: string): SymbolEntry[] {
  const lines = source.split('\n')
  // Phantom empty element from a trailing newline — mirror the caller's
  // cat -n line accounting so the last heading's endLine stays real.
  let lineCount = lines.length
  if (lineCount > 1 && lines[lineCount - 1] === '') lineCount--

  type Heading = { line: number; level: number; name: string }
  const headings: Heading[] = []
  // Marker that opened the current fence (null = not inside one). A fence
  // closes on a marker of the same char at least as long as the opener.
  let fence: string | null = null
  for (let L = 0; L < lineCount; L++) {
    const line = lines[L]!
    const fm = RE_MD_FENCE.exec(line)
    if (fm) {
      const marker = fm[1]!
      if (fence === null) fence = marker
      else if (marker[0] === fence[0] && marker.length >= fence.length) {
        fence = null
      }
      continue
    }
    if (fence !== null) continue
    const m = RE_MD_HEADING.exec(line)
    if (!m) continue
    const name = m[2]!.replace(RE_MD_CLOSING_HASHES, '').trim()
    if (!name) continue
    headings.push({ line: L, level: m[1]!.length, name })
  }

  // Depth is relative to the shallowest heading in the document, so an
  // h2-only doc renders flush instead of uniformly indented one level.
  const minLevel = headings.reduce((m, h) => Math.min(m, h.level), 6)

  return headings.map((h, idx) => {
    // The section runs until the next heading of the same or a higher level.
    let end = lineCount - 1
    for (let j = idx + 1; j < headings.length; j++) {
      if (headings[j]!.level <= h.level) {
        end = headings[j]!.line - 1
        break
      }
    }
    let signature = lines[h.line]!.trim()
    if (signature.length > MAX_SIGNATURE_CHARS) {
      signature = signature.slice(0, MAX_SIGNATURE_CHARS).trimEnd() + '…'
    }
    return {
      name: h.name,
      kind: 'heading' as const,
      signature,
      startLine: h.line + 1,
      endLine: end + 1,
      depth: h.level - minLevel,
    }
  })
}

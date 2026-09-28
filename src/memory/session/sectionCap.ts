/**
 * Caps every `# ` section of a markdown document at a number of characters,
 * so one runaway section cannot crowd the others out of a compaction summary.
 *
 * Only a line that starts with `# ` opens a section: `## ` sub-headers, `#tag`
 * lines and indented hashes belong to the body around them. Text before the
 * first header is never cut.
 */

export type SectionCapResult = { truncatedContent: string; wasTruncated: boolean }

/** Closes a section that was cut. Callers look for the word "truncated". */
export const SECTION_TRUNCATED_NOTE = '[section truncated to fit the compaction budget]'

const SECTION_HEADER_PREFIX = '# '

type Section = { readonly header: string; readonly body: string[] }

type Outline = { readonly preamble: string[]; readonly sections: Section[] }

function outlineOf(lines: readonly string[]): Outline {
  const preamble: string[] = []
  const sections: Section[] = []
  for (const line of lines) {
    if (line.startsWith(SECTION_HEADER_PREFIX)) sections.push({ header: line, body: [] })
    else (sections.at(-1)?.body ?? preamble).push(line)
  }
  return { preamble, sections }
}

/** The whole lines from the top whose text, each with its newline, fits in `maxChars`. */
function linesThatFit(body: readonly string[], maxChars: number): string[] {
  const kept: string[] = []
  let used = 0
  for (const line of body) {
    used += line.length + 1
    if (used > maxChars) break
    kept.push(line)
  }
  return kept
}

/**
 * A body is measured as its lines joined by newlines, blank lines included.
 * One within `maxChars` stays as it is; a longer one keeps the lines that
 * fit, then a blank line and the truncation note. Content that needs no cut
 * comes back as the same string.
 */
export function capSectionBodies(content: string, maxChars: number): SectionCapResult {
  const { preamble, sections } = outlineOf(content.split('\n'))
  const output = [...preamble]
  let wasTruncated = false
  for (const { header, body } of sections) {
    output.push(header)
    if (body.join('\n').length <= maxChars) {
      output.push(...body)
      continue
    }
    wasTruncated = true
    output.push(...linesThatFit(body, maxChars), '', SECTION_TRUNCATED_NOTE)
  }
  return wasTruncated
    ? { truncatedContent: output.join('\n'), wasTruncated }
    : { truncatedContent: content, wasTruncated }
}

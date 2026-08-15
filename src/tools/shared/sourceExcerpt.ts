import { readFileSync, statSync } from 'fs'
import { logError } from 'src/shared/log.js'

/**
 * A few source lines around a reported position, with a `>` gutter marking the
 * one that failed. This is the single-round-trip payoff shared by RunTests and
 * Typecheck: the model sees the code at the failing location without spending a
 * Read per failure.
 */

const CONTEXT_LINES = 3
const MAX_EXCERPT_FILE_BYTES = 2_000_000

export function readSourceExcerpt(
  absFile: string,
  line: number,
  contextLines = CONTEXT_LINES,
): string | undefined {
  try {
    if (statSync(absFile).size > MAX_EXCERPT_FILE_BYTES) return undefined
    const lines = readFileSync(absFile, 'utf8').split('\n')
    if (line < 1 || line > lines.length) return undefined
    const start = Math.max(0, line - 1 - contextLines)
    const end = Math.min(lines.length, line + contextLines)
    const width = String(end).length
    const out: string[] = []
    for (let i = start; i < end; i++) {
      const n = i + 1
      const marker = n === line ? '>' : ' '
      out.push(`${marker} ${String(n).padStart(width)} | ${lines[i]}`)
    }
    return out.join('\n')
  } catch (e) {
    logError(`Failed to read source excerpt from ${absFile} — ${String(e)}`)
    return undefined
  }
}

/**
 * A Read past the token cap that asked for the whole body (`view: 'full'`) or
 * a range answers with the first page of it instead of an error.
 *
 * "File content (N tokens) exceeds maximum allowed tokens" asked for offset
 * and limit and named no line to start from: 9 times in 2026-10..11, and one
 * sub-agent sent the same Read four times over. The page is the ranged read
 * the model could have asked for — the read gate records exactly its lines —
 * with a note that says where the rest starts.
 *
 * The page is sized from the count the cap check already made of the whole
 * (`MaxFileReadTokenExceededError.tokenCount`), scaled by characters, with a
 * margin: counting the page again would be one more API call per page.
 */
import { MaxFileReadTokenExceededError } from 'src/tools/FileReadTool/guards.js'

/** The share of the cap a page fills, since a line's tokens are only estimated from its length. */
const PAGE_FILL = 0.9

/** The characters of one over-long line a Bash fallback prints. */
const LONG_LINE_CHARS = 20_000

/** How many leading `lines` fit under `maxTokens`, given what all of them counted; 0 when the first does not. */
export function linesUnderCap(lines: readonly string[], tokenCount: number, maxTokens: number): number {
  const totalChars = lines.reduce((sum, line) => sum + line.length + 1, 0)
  const budget = (totalChars * maxTokens * PAGE_FILL) / tokenCount
  let used = 0
  let fit = 0
  for (const line of lines) {
    used += line.length + 1
    if (used > budget) break
    fit++
  }
  return fit
}

export type OverCapRead = {
  filePath: string
  startLine: number
  totalLines: number
  /** No offset and no limit were asked: the note says "the file". */
  wholeFile: boolean
}

export type Page = { content: string; numLines: number; note: string }

/**
 * The first page of `content` that fits under the cap `overCap` reports.
 * @throws MaxFileReadTokenExceededError naming a Bash cut when the first line alone is over it.
 */
export function pageOverCap(content: string, overCap: MaxFileReadTokenExceededError, read: OverCapRead): Page {
  const lines = content.split('\n')
  const numLines = linesUnderCap(lines, overCap.tokenCount, overCap.maxTokens)
  if (numLines === 0) {
    throw new MaxFileReadTokenExceededError(
      overCap.tokenCount,
      overCap.maxTokens,
      `Line ${read.startLine} alone is over the cap; read part of it with Bash: sed -n '${read.startLine}p' '${read.filePath}' | cut -c1-${LONG_LINE_CHARS}`,
    )
  }
  const last = read.startLine + numLines - 1
  const asked = read.wholeFile ? 'The file' : 'The range asked for'
  return {
    content: lines.slice(0, numLines).join('\n'),
    numLines,
    note: `Lines ${read.startLine}-${last} of ${read.totalLines} are shown. ${asked} is ~${overCap.tokenCount.toLocaleString('en-US')} tokens, over the ${overCap.maxTokens.toLocaleString('en-US')}-token cap. Read with offset=${last + 1} for the rest.`,
  }
}

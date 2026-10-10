import { formatFileSize } from 'src/shared/text/format.js'
import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'
import {
  ERROR_WINDOW_AFTER,
  ERROR_WINDOW_BEFORE,
  findErrorIndices,
} from 'src/tools/shared/outputFilter/Bash/cutShape.js'
import { collapseDigitTemplates, collapseIdenticalRuns } from 'src/tools/shared/outputFilter/Bash/collapse.js'

// ============================================================
// Strategy 1: Bash
// ============================================================

const BASH_HEAD_LINES = 40
const BASH_TAIL_LINES = 60
const MAX_LINE_WIDTH = 500

export function summarizeBashOutput(text: string): StrategyResult | null {
  // JSON passthrough — never mutate structured data.
  const trimmed = text.trimStart()
  if (trimmed.startsWith('{') || trimmed.startsWith('[')) {
    try {
      JSON.parse(trimmed)
      return null
    } catch {
      // fall through: not valid JSON, treat as text
    }
  }

  // CR-collapse each line: capture only the final segment after CR
  // (progress bars render N times per line via \r).
  const rawLines = text.split('\n')
  const crCollapsed = rawLines.map(line => {
    const parts = line.split('\r')
    return parts[parts.length - 1] ?? ''
  })

  // Collapse runs of identical lines.
  const runCollapsed = collapseIdenticalRuns(crCollapsed)

  // Collapse lines that differ only by digits → template with update count.
  const templateCollapsed = collapseDigitTemplates(runCollapsed)

  // Find error windows.
  const errorIdx = findErrorIndices(templateCollapsed)

  const total = templateCollapsed.length

  // Pick head/tail ranges and add error windows outside those ranges.
  const headEnd = Math.min(BASH_HEAD_LINES, total)
  const tailStart = Math.max(headEnd, total - BASH_TAIL_LINES)

  const keep = new Array<boolean>(total).fill(false)
  for (let i = 0; i < headEnd; i++) keep[i] = true
  for (let i = tailStart; i < total; i++) keep[i] = true

  let errorWindowPreserved = false
  for (const idx of errorIdx) {
    if (idx < headEnd || idx >= tailStart) {
      // Already inside head/tail.
      errorWindowPreserved = true
      continue
    }
    const from = Math.max(0, idx - ERROR_WINDOW_BEFORE)
    const to = Math.min(total, idx + ERROR_WINDOW_AFTER + 1)
    for (let i = from; i < to; i++) keep[i] = true
    errorWindowPreserved = true
  }

  // Assemble output, inserting omission markers for contiguous skipped runs.
  const parts: string[] = []
  let i = 0
  while (i < total) {
    if (keep[i]) {
      parts.push(truncateLine(templateCollapsed[i] ?? ''))
      i++
      continue
    }
    // Skip run — measure it.
    let j = i
    let skippedChars = 0
    while (j < total && !keep[j]) {
      skippedChars += (templateCollapsed[j] ?? '').length + 1 // +1 for the newline
      j++
    }
    const skippedLines = j - i
    parts.push(
      `<omitted lines="${skippedLines}" bytes="${formatFileSize(skippedChars)}"/>`,
    )
    i = j
  }

  return {
    body: parts.join('\n'),
    strategy: 'head-tail-errors',
    errorWindowPreserved: errorIdx.length > 0 ? errorWindowPreserved : false,
  }
}

export function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_WIDTH) return line
  return (
    line.slice(0, MAX_LINE_WIDTH) + `…[${line.length - MAX_LINE_WIDTH}b]`
  )
}

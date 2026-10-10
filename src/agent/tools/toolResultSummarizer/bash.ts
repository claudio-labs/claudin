import { formatFileSize } from 'src/shared/text/format.js'
import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'
import {
  ERROR_WINDOW_AFTER,
  ERROR_WINDOW_BEFORE,
  findErrorIndices,
} from 'src/tools/shared/outputFilter/Bash/cutShape.js'

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

export function collapseIdenticalRuns(lines: string[]): string[] {
  if (lines.length === 0) return lines
  const out: string[] = []
  let runLine = lines[0] ?? ''
  let runCount = 1
  // Annotate a collapsed run with ` (×N)` — EXCEPT a run of blank/whitespace-only
  // lines, which collapses to a single blank line with no marker. A ` (×N)` count
  // on a blank run is never useful and is actively harmful to downstream
  // line-oriented filters: the resulting ` (×N)` line is non-blank, so it both
  // survives a `/^\s*$/` strip rule and prevents `onEmpty` from firing (the Bash
  // output-filter pipeline runs collapseRuns before stripLinesMatching/onEmpty).
  const emit = (line: string, count: number) =>
    out.push(count > 1 && line.trim() !== '' ? `${line} (×${count})` : line)
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line === runLine) {
      runCount++
      continue
    }
    emit(runLine, runCount)
    runLine = line
    runCount = 1
  }
  emit(runLine, runCount)
  return out
}

// Collapse runs of lines that only differ by digits. Only collapses runs of
// DIGIT_TEMPLATE_MIN_RUN or more so legitimate line-numbered logs survive
// (e.g. consecutive `line 1`/`line 2` debug output); aggressive enough to
// catch progress bars / percentage dumps / tick counters.
const DIGIT_TEMPLATE_MIN_RUN = 5

export function collapseDigitTemplates(lines: string[]): string[] {
  if (lines.length === 0) return lines
  const out: string[] = []
  let template: string | null = null
  let runStart = 0
  let runCount = 0

  const emitRun = (endExclusive: number) => {
    if (runCount >= DIGIT_TEMPLATE_MIN_RUN) {
      // One sample line + count marker.
      out.push(`${lines[runStart] ?? ''} (${runCount} updates)`)
    } else {
      // Preserve each line as-is.
      for (let i = runStart; i < endExclusive; i++) {
        out.push(lines[i] ?? '')
      }
    }
  }

  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    const t = line.replace(/\d+/g, '#')
    if (template !== null && t === template) {
      runCount++
      continue
    }
    if (template !== null) emitRun(i)
    template = t
    runStart = i
    runCount = 1
  }
  if (template !== null) emitRun(lines.length)
  return out
}

export function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_WIDTH) return line
  return (
    line.slice(0, MAX_LINE_WIDTH) + `…[${line.length - MAX_LINE_WIDTH}b]`
  )
}

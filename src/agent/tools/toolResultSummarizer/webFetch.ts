import { formatFileSize } from 'src/shared/text/format.js'
import type { StrategyName, StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'
import { truncateLine } from 'src/agent/tools/toolResultSummarizer/bash.js'

// ============================================================
// Strategy 3: WebFetch
// ============================================================

const WEBFETCH_HEAD_LINES = 100
const WEBFETCH_TAIL_LINES = 40
const WEBFETCH_TITLE_LINES = 3

// `<\/script[^>]*>` (not `<\/script>`) so `</script >` and attribute-bearing
// end tags like `</script foo>` — which HTML parsers still treat as end tags —
// are matched too (CodeQL js/bad-tag-filter).
const WEBFETCH_SCRIPT_BLOCK_RE = /<script\b[^>]*>[\s\S]*?<\/script[^>]*>/gi
const WEBFETCH_STYLE_BLOCK_RE = /<style\b[^>]*>[\s\S]*?<\/style[^>]*>/gi
// Leftover unpaired tags — stripped after the paired blocks so a `<script`
// opener can't survive sanitization.
const WEBFETCH_SCRIPT_TAG_RE = /<\/?script\b[^>]*\/?>/gi
const WEBFETCH_STYLE_TAG_RE = /<\/?style\b[^>]*\/?>/gi

export function summarizeWebFetchOutput(text: string): StrategyResult {
  // Detect HTML residual density: > 1 HTML marker per 2KB.
  const htmlMarkers =
    (text.match(/<script[\s>]/gi)?.length ?? 0) +
    (text.match(/<style[\s>]/gi)?.length ?? 0) +
    (text.match(/<!DOCTYPE/gi)?.length ?? 0)
  const htmlDense = htmlMarkers > Math.max(1, Math.floor(text.length / 2048))

  let working = text
  let strategy: StrategyName = 'webfetch-head-tail'

  if (htmlDense) {
    // Strip script/style blocks, then any unpaired tags, looping to a
    // fixpoint: single-pass removal can regenerate a tag from the remainder
    // (`<<script>script>` → `<script>`), so iterate until stable.
    let prev: string
    do {
      prev = working
      working = working
        .replace(WEBFETCH_SCRIPT_BLOCK_RE, '')
        .replace(WEBFETCH_STYLE_BLOCK_RE, '')
        .replace(WEBFETCH_SCRIPT_TAG_RE, '')
        .replace(WEBFETCH_STYLE_TAG_RE, '')
    } while (working !== prev)
    strategy = 'webfetch-stripped'
  }

  const lines = working.split('\n')

  // Detect title in first few lines.
  let titleLine = -1
  const scanUpTo = Math.min(WEBFETCH_TITLE_LINES, lines.length)
  for (let i = 0; i < scanUpTo; i++) {
    const l = lines[i] ?? ''
    if (l.startsWith('# ') || /^Title:\s*/i.test(l)) {
      titleLine = i
      break
    }
  }

  const total = lines.length
  const keep = new Array<boolean>(total).fill(false)

  if (titleLine >= 0) keep[titleLine] = true

  const headEnd = Math.min(WEBFETCH_HEAD_LINES, total)
  const tailStart = Math.max(headEnd, total - WEBFETCH_TAIL_LINES)
  for (let i = 0; i < headEnd; i++) keep[i] = true
  for (let i = tailStart; i < total; i++) keep[i] = true

  const parts: string[] = []
  let i = 0
  while (i < total) {
    if (keep[i]) {
      parts.push(truncateLine(lines[i] ?? ''))
      i++
      continue
    }
    let j = i
    let skippedChars = 0
    while (j < total && !keep[j]) {
      skippedChars += (lines[j] ?? '').length + 1
      j++
    }
    parts.push(
      `<omitted lines="${j - i}" bytes="${formatFileSize(skippedChars)}"/>`,
    )
    i = j
  }

  return { body: parts.join('\n'), strategy }
}

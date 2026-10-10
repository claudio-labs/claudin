import { formatFileSize } from 'src/shared/text/format.js'
import type { StrategyName } from 'src/agent/tools/toolResultSummarizer/types.js'

// Opening tag is intentionally incomplete ("<tool-result-summary" without '>')
// so attribute-carrying markers still match `startsWith` checks verbatim.
export const TOOL_RESULT_SUMMARY_TAG = '<tool-result-summary'
export const TOOL_RESULT_SUMMARY_CLOSING_TAG = '</tool-result-summary>'
/**
 * The envelope of a result regrouped without losing a line (`compactGrepOutput`,
 * `compactGlobOutput`). It carries no `original`/`kept` sizes: nothing in it was
 * cut, and a pair of sizes reads as though something had been.
 */
const TOOL_RESULT_COMPACTED_TAG = '<tool-result-compacted'
const TOOL_RESULT_COMPACTED_CLOSING_TAG = '</tool-result-compacted>'

/**
 * True when this summarizer CUT the content (`<tool-result-summary>`); a
 * lossless `<tool-result-compacted>` is not. Cheap anchored check: the tag is
 * only emitted as the first byte of our marker, never mid-stream.
 */
export function isSummarizedContent(content: unknown): boolean {
  return (
    typeof content === 'string' && content.startsWith(TOOL_RESULT_SUMMARY_TAG)
  )
}

// ---------- marker ----------

export function wrapMarker(
  toolName: string,
  originalBytes: number,
  keptBytes: number,
  strategy: StrategyName,
  body: string,
  envelopeAttrs?: Record<string, string>,
): string {
  const original = formatFileSize(originalBytes)
  const kept = formatFileSize(keptBytes)
  // Append optional elision metadata as attributes on the envelope. Stable
  // insertion order: extras come after the always-present tool/original/
  // kept/strategy quad so log parsers keying off the leading attributes
  // still match. See StrategyResult.envelopeAttrs for the design rationale.
  return (
    `${TOOL_RESULT_SUMMARY_TAG} tool="${toolName}" original="${original}" kept="${kept}" strategy="${strategy}"${extrasOf(envelopeAttrs)}>\n` +
    body +
    `\n${TOOL_RESULT_SUMMARY_CLOSING_TAG}`
  )
}

export function wrapCompacted(
  toolName: string,
  strategy: StrategyName,
  body: string,
  envelopeAttrs?: Record<string, string>,
): string {
  return (
    `${TOOL_RESULT_COMPACTED_TAG} tool="${toolName}" strategy="${strategy}"${extrasOf(envelopeAttrs)}>\n` +
    body +
    `\n${TOOL_RESULT_COMPACTED_CLOSING_TAG}`
  )
}

function extrasOf(envelopeAttrs: Record<string, string> | undefined): string {
  let extras = ''
  if (envelopeAttrs) {
    for (const [k, v] of Object.entries(envelopeAttrs)) {
      extras += ` ${k}="${escapeAttr(v)}"`
    }
  }
  return extras
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function isAlreadyCompacted(text: string): boolean {
  // <persisted-output> or <tool-result-summary (either marker at start)
  // <bash-output-rewritten> or <bash-output-filtered> — markers from the
  // bash-output-filter pipeline (Phase 0+ of roadmap 6.1)
  // <bash-output-read> — a file read the filter left whole on purpose
  // (CLAUDIN_BASH_READ_LANE): cutting it would undo that
  // <tool-result-compacted — this summarizer's own lossless envelope
  return (
    text.startsWith('<persisted-output>') ||
    text.startsWith(TOOL_RESULT_SUMMARY_TAG) ||
    text.startsWith(TOOL_RESULT_COMPACTED_TAG) ||
    text.startsWith('<bash-output-rewritten') ||
    text.startsWith('<bash-output-filtered') ||
    text.startsWith('<bash-output-read>')
  )
}

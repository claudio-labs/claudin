import { formatFileSize } from 'src/shared/text/format.js'
import type { StrategyName } from 'src/agent/tools/toolResultSummarizer/types.js'

// Opening tag is intentionally incomplete ("<tool-result-summary" without '>')
// so attribute-carrying markers still match `startsWith` checks verbatim.
export const TOOL_RESULT_SUMMARY_TAG = '<tool-result-summary'
export const TOOL_RESULT_SUMMARY_CLOSING_TAG = '</tool-result-summary>'

/**
 * True when content was produced by this summarizer. Cheap anchored check:
 * the tag is only emitted as the first byte of our marker, never mid-stream.
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
  let extras = ''
  if (envelopeAttrs) {
    for (const [k, v] of Object.entries(envelopeAttrs)) {
      extras += ` ${k}="${escapeAttr(v)}"`
    }
  }
  return (
    `${TOOL_RESULT_SUMMARY_TAG} tool="${toolName}" original="${original}" kept="${kept}" strategy="${strategy}"${extras}>\n` +
    body +
    `\n${TOOL_RESULT_SUMMARY_CLOSING_TAG}`
  )
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

export function isAlreadyCompacted(text: string): boolean {
  // <persisted-output> or <tool-result-summary (either marker at start)
  // <bash-output-rewritten> or <bash-output-filtered> — markers from the
  // bash-output-filter pipeline (Phase 0+ of roadmap 6.1)
  // <bash-output-read> — a file read the filter left whole on purpose
  // (CLAUDIN_BASH_FILE_READ_PASSTHROUGH): cutting it would undo that
  return (
    text.startsWith('<persisted-output>') ||
    text.startsWith(TOOL_RESULT_SUMMARY_TAG) ||
    text.startsWith('<bash-output-rewritten') ||
    text.startsWith('<bash-output-filtered') ||
    text.startsWith('<bash-output-read>')
  )
}

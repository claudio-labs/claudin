import type { StrategyName } from 'src/agent/tools/toolResultSummarizer/types.js'

/**
 * The envelope of a result regrouped without losing a line (`compactGrepOutput`,
 * `compactGlobOutput`). It carries no sizes: nothing in it was cut, and a pair
 * of sizes reads as though something had been. The opening tag is left
 * incomplete so attribute-carrying envelopes still match a `startsWith` check.
 */
const TOOL_RESULT_COMPACTED_TAG = '<tool-result-compacted'
const TOOL_RESULT_COMPACTED_CLOSING_TAG = '</tool-result-compacted>'

export function wrapCompacted(
  toolName: string,
  strategy: StrategyName,
  body: string,
  envelopeAttrs?: Record<string, string>,
): string {
  let extras = ''
  for (const [k, v] of Object.entries(envelopeAttrs ?? {})) extras += ` ${k}="${escapeAttr(v)}"`
  return (
    `${TOOL_RESULT_COMPACTED_TAG} tool="${toolName}" strategy="${strategy}"${extras}>\n` +
    body +
    `\n${TOOL_RESULT_COMPACTED_CLOSING_TAG}`
  )
}

function escapeAttr(s: string): string {
  return s.replace(/&/g, '&amp;').replace(/"/g, '&quot;').replace(/</g, '&lt;')
}

/**
 * Text this module already compacted. Only Grep and Glob output is ever
 * compacted, fresh from the tool, so its own envelope is the one wrapper it
 * can meet.
 */
export function isAlreadyCompacted(text: string): boolean {
  return text.startsWith(TOOL_RESULT_COMPACTED_TAG)
}

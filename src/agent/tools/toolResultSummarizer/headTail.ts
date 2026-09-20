import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'
import { AGENT_SUMMARIZE_THRESHOLD, MCP_SUMMARIZE_THRESHOLD } from 'src/agent/tools/toolResultSummarizer/thresholds.js'

const AGENT_HEAD_LINES = 50
const AGENT_TAIL_LINES = 50

export const MCP_HEAD_LINES = 50
export const MCP_TAIL_LINES = 50

/** Joins only text blocks, ignoring images and unknown types. */
export function joinTextBlocks(blocks: Array<{ type: string; text?: string }>): string {
  return blocks
    .filter((b): b is { type: 'text'; text: string } =>
      b.type === 'text' && typeof b.text === 'string',
    )
    .map(b => b.text)
    .join('\n')
}

/**
 * Generic head + tail with a metadata-shaped omission marker.
 *
 * The marker is a self-closing XML-ish tag (`<omitted lines="N"/>`) rather
 * than inline prose ("[…N lines omitted…]"). See StrategyResult.envelopeAttrs
 * for the design rationale (avoid eliciting narration commentary on Opus 4.8).
 */
export function applyHeadTail(text: string, headLines: number, tailLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= headLines + tailLines) return text
  const omitted = lines.length - headLines - tailLines
  return [
    ...lines.slice(0, headLines),
    `<omitted lines="${omitted}"/>`,
    ...lines.slice(-tailLines),
  ].join('\n')
}

// AgentTool appends a trailer text block (`agentId: …` and/or `<usage>…`) after
// the agent's actual output. Every summarizer arm must preserve it verbatim, so
// split it off here and re-append it to whichever strategy's body wins.
function splitAgentTrailer(blocks: Array<{ type: string; text?: string }>): {
  mainBlocks: Array<{ type: string; text?: string }>
  trailerText: string
} {
  const lastBlock = blocks[blocks.length - 1]
  const isTrailerBlock =
    lastBlock?.type === 'text' &&
    typeof lastBlock.text === 'string' &&
    (lastBlock.text.includes('<usage>') || lastBlock.text.startsWith('agentId:'))
  return {
    mainBlocks: isTrailerBlock ? blocks.slice(0, -1) : blocks,
    trailerText: isTrailerBlock ? '\n' + lastBlock!.text! : '',
  }
}

export function summarizeAgentOutput(
  blocks: Array<{ type: string; text?: string }>,
): StrategyResult | null {
  const { mainBlocks, trailerText } = splitAgentTrailer(blocks)

  const joinedText = joinTextBlocks(mainBlocks)
  if (joinedText.length < AGENT_SUMMARIZE_THRESHOLD) return null

  const body = applyHeadTail(joinedText, AGENT_HEAD_LINES, AGENT_TAIL_LINES) + trailerText
  return { body, strategy: 'agent-head-tail' }
}

export function summarizeMcpOutput(
  blocks: Array<{ type: string; text?: string }>,
): StrategyResult | null {
  const joinedText = joinTextBlocks(blocks)
  if (joinedText.length < MCP_SUMMARIZE_THRESHOLD) return null

  return { body: applyHeadTail(joinedText, MCP_HEAD_LINES, MCP_TAIL_LINES), strategy: 'mcp-head-tail' }
}

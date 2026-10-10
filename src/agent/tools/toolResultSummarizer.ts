/**
 * Tool result summarizer — what becomes of an oversized tool result as it
 * enters conversation history. Two passes, both pure, deterministic and zero
 * I/O, which toolResultStorage.ts chains:
 *
 *  - `maybeCompactToolResult` regroups a Grep or Glob result without losing a
 *    line (`compactGrepOutput`, `compactGlobOutput`) into a
 *    `<tool-result-compacted>` envelope. Storage ships it, or the result as it
 *    came, whenever that fits under the tool's persistence line
 *    (`CLAUDIN_TOOL_RESULT_LOSSLESS`, on by default).
 *  - `maybeSummarizeToolResult` CUTS, into a `<tool-result-summary>`, keeping
 *    what the model needs to reason about the rest: error windows for Bash,
 *    match counts for Grep, head+tail for WebFetch. Storage calls it only past
 *    that line, where the other choice is a file on disk behind a 2 KB preview.
 *
 * On ANY unexpected error the original block is returned — this module must
 * never break a turn.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { BYTES_PER_TOKEN } from 'src/tools/constants/toolLimits.js'
import { compressJsonArray } from 'src/agent/tools/jsonArrayCompress.js'
import { recordBytesSaved } from 'src/agent/context/tokensSaved.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { isGrepBodiesResult } from 'src/tools/GrepTool/grepBodies.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import type { StrategyResult } from 'src/agent/tools/toolResultSummarizer/types.js'
import { AGENT_SUMMARIZE_THRESHOLD, BASH_SUMMARIZE_THRESHOLD, GLOB_SUMMARIZE_THRESHOLD, GREP_SUMMARIZE_FLOOR, GREP_SUMMARIZE_THRESHOLD, MCP_SUMMARIZE_THRESHOLD, WEBFETCH_SUMMARIZE_THRESHOLD, isToolResultJsonCompressionEnabled, jsonSavesEnough } from 'src/agent/tools/toolResultSummarizer/thresholds.js'
import { STRATEGY_ID, recordDecision } from 'src/agent/tools/toolResultSummarizer/decisionRecord.js'
import { isAlreadyCompacted, wrapCompacted, wrapMarker } from 'src/agent/tools/toolResultSummarizer/markers.js'
import { hasImageContentBlock, isToolResultContentEmpty } from 'src/agent/tools/toolResultSummarizer/contentShape.js'
import { maybeCodeOutline, maybeJsonStructural } from 'src/agent/tools/toolResultSummarizer/structural.js'
import { MCP_HEAD_LINES, MCP_TAIL_LINES, applyHeadTail, joinTextBlocks, summarizeAgentOutput, summarizeMcpOutput } from 'src/agent/tools/toolResultSummarizer/headTail.js'
import { summarizeBashOutput } from 'src/agent/tools/toolResultSummarizer/bash.js'
import { compactGrepOutput, summarizeGrepOutput } from 'src/agent/tools/toolResultSummarizer/grep.js'
import { summarizeWebFetchOutput } from 'src/agent/tools/toolResultSummarizer/webFetch.js'
import { compactGlobOutput, summarizeGlobOutput } from 'src/agent/tools/toolResultSummarizer/glob.js'

export { TOOL_RESULT_SUMMARY_TAG, TOOL_RESULT_SUMMARY_CLOSING_TAG, isSummarizedContent } from 'src/agent/tools/toolResultSummarizer/markers.js'
export { isLosslessSummarizerEnabled, isToolResultJsonCompressionEnabled, isToolResultCodeOutlineEnabled } from 'src/agent/tools/toolResultSummarizer/thresholds.js'
export { getLastSummaryDecision, resetLastSummaryDecision } from 'src/agent/tools/toolResultSummarizer/decisionRecord.js'
export { summarizeGrepOutput } from 'src/agent/tools/toolResultSummarizer/grep.js'
export type { SummaryDecision } from 'src/agent/tools/toolResultSummarizer/types.js'

/**
 * The cut. Storage calls it past the persistence line (`keepWholeUnderLine`),
 * or for every result under `CLAUDIN_TOOL_RESULT_LOSSLESS=0`. Returns the
 * input block unchanged for all passthrough cases (disabled, unknown tool,
 * below threshold, non-string, image, already summarized, etc.). On any
 * thrown error inside a strategy, logs and returns the original block —
 * never breaks a turn.
 */
export function maybeSummarizeToolResult(
  block: ToolResultBlockParam,
  toolName: string,
): ToolResultBlockParam {
  try {
    // Guard 1: env var kill switch (highest precedence).
    if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER)) {
      return block
    }

    // Guard 2: config toggle.
    if (!getGlobalConfig().toolResultSummarizerEnabled) {
      return block
    }

    const content = block.content

    // Guard 3: null/undefined.
    if (content == null) return block

    // Guard 4: empty — handled downstream by maybePersistLargeToolResult
    // with a marker injection; passthrough here.
    if (isToolResultContentEmpty(content)) return block

    // Guard 4.5: array-content path — AgentTool and MCPTool.
    if (Array.isArray(block.content)) {
      return maybeSummarizeArrayContent(block, toolName)
    }

    // Guard 5: not a string (array of content blocks). Summarizer phase 1
    // only handles plain text results.
    if (typeof content !== 'string') return block

    // Guard 6: image blocks — belt-and-suspenders; typeof check above
    // already excludes arrays, but keep the guard explicit in case
    // ToolResultBlockParam ever widens.
    if (hasImageContentBlock(content)) return block

    // Guard 7: already summarized or persisted — idempotency.
    if (isAlreadyCompacted(content)) return block

    // Guard 8 + 9: dispatch by tool name and per-tool threshold.
    const strategyResult = dispatch(toolName, content)
    if (strategyResult === null) return block
    return ship(block, toolName, content.length, strategyResult, 'summary') ?? block
  } catch (error) {
    logForDebugging(
      `maybeSummarizeToolResult: error for tool ${toolName}: ${(error as Error)?.message ?? String(error)}`,
      { level: 'warn' },
    )
    return block
  }
}

/**
 * The lossless pass: a Grep or Glob result past its threshold regrouped
 * without losing a line, or the block unchanged — for every other tool, and
 * whenever the regroup would save nothing. The cut's kill switches apply.
 */
export function maybeCompactToolResult(
  block: ToolResultBlockParam,
  toolName: string,
): ToolResultBlockParam {
  try {
    if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER)) return block
    if (!getGlobalConfig().toolResultSummarizerEnabled) return block
    const content = block.content
    if (typeof content !== 'string' || isAlreadyCompacted(content)) return block
    const compacted = dispatchCompact(toolName, content)
    if (compacted === null) return block
    return ship(block, toolName, content.length, compacted, 'compacted') ?? block
  } catch (error) {
    logForDebugging(
      `maybeCompactToolResult: error for tool ${toolName}: ${(error as Error)?.message ?? String(error)}`,
      { level: 'warn' },
    )
    return block
  }
}

/**
 * `block` carrying `result` in its envelope — a cut summary or a lossless
 * compaction — with the saving recorded. Null when the envelope would be no
 * smaller than what it replaces (tiny inputs, pathological cases): the
 * original ships rather than a marker that misleads the cache.
 */
function ship(
  block: ToolResultBlockParam,
  toolName: string,
  originalSizeBytes: number,
  result: StrategyResult,
  envelope: 'summary' | 'compacted',
): ToolResultBlockParam | null {
  const wrapped =
    envelope === 'summary'
      ? wrapMarker(toolName, originalSizeBytes, result.body.length, result.strategy, result.body, result.envelopeAttrs)
      : wrapCompacted(toolName, result.strategy, result.body, result.envelopeAttrs)
  if (wrapped.length >= originalSizeBytes) return null
  recordBytesSaved(originalSizeBytes, wrapped.length)
  recordDecision({
    toolName,
    originalSizeBytes,
    summarizedSizeBytes: wrapped.length,
    estimatedOriginalTokens: Math.ceil(originalSizeBytes / BYTES_PER_TOKEN),
    estimatedSummarizedTokens: Math.ceil(wrapped.length / BYTES_PER_TOKEN),
    strategyId: STRATEGY_ID[result.strategy],
    ...(result.errorWindowPreserved !== undefined && { errorWindowPreserved: result.errorWindowPreserved }),
    ...(result.salientPinned !== undefined && { salientPinned: result.salientPinned }),
    reductionPct: Math.floor(100 * (1 - wrapped.length / originalSizeBytes)),
  })
  return { ...block, content: wrapped }
}

// ---------- dispatch ----------

function dispatch(toolName: string, text: string): StrategyResult | null {
  switch (toolName) {
    case BASH_TOOL_NAME:
      if (text.length < BASH_SUMMARIZE_THRESHOLD) return null
      // Structural JSON compression runs before the line-based bash summarizer,
      // which deliberately passes JSON through untouched.
      if (isToolResultJsonCompressionEnabled()) {
        const jc = compressJsonArray(text)
        if (jc && jsonSavesEnough(jc.render, text)) {
          return {
            body: jc.render,
            strategy: 'json-structural',
            salientPinned: jc.salientPinned,
          }
        }
      }
      // Code-outline runs after JSON (JSON isn't code) and before the blind
      // head/tail, which thrashes on source files (see Read note below).
      return maybeCodeOutline(text, BASH_SUMMARIZE_THRESHOLD) ?? summarizeBashOutput(text)
    case GREP_TOOL_NAME: {
      if (text.length < GREP_SUMMARIZE_FLOOR) return null
      // CLAUDIN_GREP_BODIES: the bodies were registered as read, so the model
      // must see all of them (grepBodies.ts).
      if (isGrepBodiesResult(text)) return null
      const grep = summarizeGrepOutput(text)
      if (grep === null) return null
      // Under the full threshold, only a summary that keeps every match ships.
      if (
        text.length < GREP_SUMMARIZE_THRESHOLD &&
        (grep.matchesElided ?? 0) > 0
      ) {
        return null
      }
      return grep
    }
    case WEB_FETCH_TOOL_NAME:
      if (text.length < WEBFETCH_SUMMARIZE_THRESHOLD) return null
      // Catches raw-source fetches (e.g. raw.githubusercontent.com/.../foo.ts).
      return maybeCodeOutline(text, WEBFETCH_SUMMARIZE_THRESHOLD) ?? summarizeWebFetchOutput(text)
    // Read has no summarization arm: head/tail elision of large file reads
    // induced a thrashing loop on dense codebases (subagent re-Reads the same
    // file in 50-line slices following the elision hint). FileReadTool pivots
    // to a structural outline via AUTO_OUTLINE_ON_ELISION instead — falls
    // through to the default `null` here.
    case GLOB_TOOL_NAME:
      if (text.length < GLOB_SUMMARIZE_THRESHOLD) return null
      return summarizeGlobOutput(text)
    default:
      if (toolName.startsWith('mcp__')) {
        if (text.length < MCP_SUMMARIZE_THRESHOLD) return null
        return (
          maybeCodeOutline(text, MCP_SUMMARIZE_THRESHOLD) ?? {
            body: applyHeadTail(text, MCP_HEAD_LINES, MCP_TAIL_LINES),
            strategy: 'mcp-head-tail',
          }
        )
      }
      return null
  }
}

/**
 * The lossless pass's tools. Grep gates on its floor rather than its
 * threshold: what the regroup ships keeps every line, which is what the floor
 * already admitted. Every other tool has nothing to regroup and ships whole.
 */
function dispatchCompact(toolName: string, text: string): StrategyResult | null {
  switch (toolName) {
    case GREP_TOOL_NAME:
      if (text.length < GREP_SUMMARIZE_FLOOR || isGrepBodiesResult(text)) return null
      return compactGrepOutput(text)
    case GLOB_TOOL_NAME:
      return text.length < GLOB_SUMMARIZE_THRESHOLD ? null : compactGlobOutput(text)
    default:
      return null
  }
}

// ---------- array-content dispatch ----------

function maybeSummarizeArrayContent(
  block: ToolResultBlockParam,
  toolName: string,
): ToolResultBlockParam {
  const blocks = block.content as Array<{ type: string; text?: string }>

  const strategyResult = dispatchArray(toolName, blocks)
  if (strategyResult === null) return block
  return ship(block, toolName, joinTextBlocks(blocks).length, strategyResult, 'summary') ?? block
}

function dispatchArray(
  toolName: string,
  blocks: Array<{ type: string; text?: string }>,
): StrategyResult | null {
  if (toolName === AGENT_TOOL_NAME || toolName === LEGACY_AGENT_TOOL_NAME) {
    const jc = maybeJsonStructural(blocks, AGENT_SUMMARIZE_THRESHOLD)
    if (jc) return jc
    // No code-outline here, deliberately. An agent's result is a REPORT: the
    // prose is the finding and the code in it is quoted evidence. `detectCodeLang`
    // cannot tell that from a source file, so a report dense in excerpts was
    // being replaced by its symbol signatures — measured once at 26 KB → 683 B,
    // after which the parent Read the 28 KB spill file back and re-read 17 of the
    // 35 files the report already covered. Head/tail keeps the head of the report,
    // which is where a report puts its answer.
    return summarizeAgentOutput(blocks)
  }
  if (toolName.startsWith('mcp__')) {
    const hasNonTextBlocks = blocks.some(b => b.type !== 'text')
    if (hasNonTextBlocks) return null  // preserve images
    const jc = maybeJsonStructural(blocks, MCP_SUMMARIZE_THRESHOLD)
    if (jc) return jc
    const code = maybeCodeOutline(joinTextBlocks(blocks), MCP_SUMMARIZE_THRESHOLD)
    if (code) return code
    return summarizeMcpOutput(blocks)
  }
  return null
}

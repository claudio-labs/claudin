/**
 * Tool-result compaction — a Grep or Glob result regrouped without losing a
 * line (`compactGrepOutput`, `compactGlobOutput`) into a
 * `<tool-result-compacted>` envelope. Pure, deterministic, zero I/O. Nothing
 * here cuts: a result past its tool's persistence line is paged by storage
 * (toolResultStorage.ts), every line of it kept.
 *
 * Off under `CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER` or the
 * `toolResultSummarizerEnabled` config. On ANY unexpected error the original
 * block is returned — this module must never break a turn.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { recordBytesSaved } from 'src/agent/context/tokensSaved.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { isGrepBodiesResult } from 'src/tools/GrepTool/grepBodies.js'
import { getGlobalConfig } from 'src/platform/config/config.js'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import type { StrategyResult } from 'src/agent/tools/toolResultCompaction/types.js'
import { isAlreadyCompacted, wrapCompacted } from 'src/agent/tools/toolResultCompaction/markers.js'
import { compactGrepOutput } from 'src/agent/tools/toolResultCompaction/grep.js'
import { compactGlobOutput } from 'src/agent/tools/toolResultCompaction/glob.js'

/**
 * Below this a result ships as it came: a regroup pays only on output long
 * enough to repeat its paths, and a small result is cheap either way.
 */
const COMPACT_MIN_CHARS = 3_000

/**
 * A Grep or Glob result regrouped without losing a line, or the block
 * unchanged — for every other tool, and whenever the regroup would save
 * nothing.
 */
export function maybeCompactToolResult(
  block: ToolResultBlockParam,
  toolName: string,
): ToolResultBlockParam {
  try {
    if (isEnvTruthy(process.env.CLAUDIN_DISABLE_TOOL_RESULT_SUMMARIZER)) return block
    if (!getGlobalConfig().toolResultSummarizerEnabled) return block
    const content = block.content
    if (typeof content !== 'string' || content.length < COMPACT_MIN_CHARS || isAlreadyCompacted(content)) return block
    const result = compact(toolName, content)
    if (result === null) return block
    const wrapped = wrapCompacted(toolName, result.strategy, result.body, result.envelopeAttrs)
    if (wrapped.length >= content.length) return block
    recordBytesSaved(content.length, wrapped.length)
    return { ...block, content: wrapped }
  } catch (error) {
    logForDebugging(
      `maybeCompactToolResult: error for tool ${toolName}: ${(error as Error)?.message ?? String(error)}`,
      { level: 'warn' },
    )
    return block
  }
}

function compact(toolName: string, text: string): StrategyResult | null {
  switch (toolName) {
    case GREP_TOOL_NAME:
      // CLAUDIN_GREP_BODIES: a bodies result is a symbol map, not rg lines.
      return isGrepBodiesResult(text) ? null : compactGrepOutput(text)
    case GLOB_TOOL_NAME:
      return compactGlobOutput(text)
    default:
      return null
  }
}

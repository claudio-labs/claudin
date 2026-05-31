/**
 * Tool result summarizer — opportunistic per-tool compression of oversized
 * Bash/Grep/WebFetch outputs as they enter conversation history.
 *
 * Pure, deterministic, zero I/O. Runs once per tool_result, upstream of
 * persistence. All strategies preserve the exact totals the model would
 * need to reason about the raw output (error windows for Bash, match
 * counts for Grep, head+tail for WebFetch). On ANY unexpected error the
 * original block is returned — this module must never break a turn.
 */
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { BYTES_PER_TOKEN } from '../constants/toolLimits.js'
import { logEvent } from '../services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from '../services/analytics/metadata.js'
import { BASH_TOOL_NAME } from '../tools/BashTool/toolName.js'
import { FILE_READ_TOOL_NAME } from '../tools/FileReadTool/prompt.js'
import { GLOB_TOOL_NAME } from '../tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from '../tools/GrepTool/prompt.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from '../tools/AgentTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from '../tools/WebFetchTool/prompt.js'
import { getGlobalConfig } from './config.js'
import { logForDebugging } from './debug.js'
import { isEnvTruthy } from './envUtils.js'
import { formatFileSize } from './format.js'

// Opening tag is intentionally incomplete ("<tool-result-summary" without '>')
// so attribute-carrying markers still match `startsWith` checks verbatim.
export const TOOL_RESULT_SUMMARY_TAG = '<tool-result-summary'
export const TOOL_RESULT_SUMMARY_CLOSING_TAG = '</tool-result-summary>'

// Per-tool thresholds (chars). Kept local to avoid importing toolLimits cycles.
const BASH_SUMMARIZE_THRESHOLD = 8_000
const GREP_SUMMARIZE_THRESHOLD = 6_000
const WEBFETCH_SUMMARIZE_THRESHOLD = 12_000
const READ_SUMMARIZE_THRESHOLD = 10_000
const GLOB_SUMMARIZE_THRESHOLD = 3_000
const AGENT_SUMMARIZE_THRESHOLD = 8_000
const MCP_SUMMARIZE_THRESHOLD = 8_000

// Strategy enum numeric IDs (analytics payloads only accept boolean|number).
const STRATEGY_ID: Record<StrategyName, number> = {
  'head-tail-errors': 1,
  'grep-grouped': 2,
  'webfetch-stripped': 3,
  'webfetch-head-tail': 4,
  'read-head-tail': 5,
  'glob-top-n': 6,
  'agent-head-tail': 7,
  'mcp-head-tail': 8,
}

type StrategyName =
  | 'head-tail-errors'
  | 'grep-grouped'
  | 'webfetch-stripped'
  | 'webfetch-head-tail'
  | 'read-head-tail'
  | 'glob-top-n'
  | 'agent-head-tail'
  | 'mcp-head-tail'

type StrategyResult = {
  body: string
  strategy: StrategyName
  errorWindowPreserved?: boolean
  /**
   * Optional envelope-level metadata describing the elision. Placed as
   * attributes on the opening `<tool-result-summary>` tag so the model sees
   * structured key/value pairs rather than narratable prose.
   *
   * DESIGN: Elision is communicated via envelope attributes and self-closing
   * metadata tags (e.g. `<omitted lines="361"/>`) rather than inline prose
   * markers (e.g. "[…middle elided, lines 51-411 omitted…]"). Bench data on
   * Opus 4.8 (see scripts/bench/results/serial-read-nudge-ab-claude-opus-4-8-
   * 2026-05-30T16-53-58-546Z.md) showed ~80% of residual inter-tool-call
   * narration was elision-reaction commentary ("o miolo foi omitido, vou ler
   * em janelas menores", "the summarizer cut the two most important
   * sections"). Models commentate on prose; they rarely commentate on
   * attribute-style metadata. Same information, different shape.
   */
  envelopeAttrs?: Record<string, string>
}

/**
 * True when content was produced by this summarizer. Cheap anchored check:
 * the tag is only emitted as the first byte of our marker, never mid-stream.
 */
export function isSummarizedContent(content: unknown): boolean {
  return (
    typeof content === 'string' && content.startsWith(TOOL_RESULT_SUMMARY_TAG)
  )
}

/**
 * Entry point. Returns the input block unchanged for all passthrough cases
 * (disabled, unknown tool, below threshold, non-string, image, already
 * summarized, etc.). On any thrown error inside a strategy, logs and
 * returns the original block — never breaks a turn.
 */
export function maybeSummarizeToolResult(
  block: ToolResultBlockParam,
  toolName: string,
): ToolResultBlockParam {
  try {
    // Guard 1: env var kill switch (highest precedence).
    if (isEnvTruthy(process.env.CLAUDIO_DISABLE_TOOL_RESULT_SUMMARIZER)) {
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

    const originalSizeBytes = content.length
    const wrapped = wrapMarker(
      toolName,
      originalSizeBytes,
      strategyResult.body.length,
      strategyResult.strategy,
      strategyResult.body,
      strategyResult.envelopeAttrs,
    )

    // No-win guard: if wrapping didn't actually save bytes (tiny inputs,
    // pathological cases), bail rather than mislead the cache.
    if (wrapped.length >= originalSizeBytes) return block

    const summarizedSizeBytes = wrapped.length

    logEvent('claudio_tool_result_summarized', {
      toolName: sanitizeToolNameForAnalytics(toolName),
      originalSizeBytes,
      summarizedSizeBytes,
      estimatedOriginalTokens: Math.ceil(originalSizeBytes / BYTES_PER_TOKEN),
      estimatedSummarizedTokens: Math.ceil(
        summarizedSizeBytes / BYTES_PER_TOKEN,
      ),
      strategyId: STRATEGY_ID[strategyResult.strategy],
      errorWindowPreserved: strategyResult.errorWindowPreserved,
      reductionPct: Math.floor(
        100 * (1 - summarizedSizeBytes / originalSizeBytes),
      ),
    })

    return { ...block, content: wrapped }
  } catch (error) {
    logForDebugging(
      `maybeSummarizeToolResult: error for tool ${toolName}: ${(error as Error)?.message ?? String(error)}`,
      { level: 'warn' },
    )
    return block
  }
}

// ---------- dispatch ----------

function dispatch(toolName: string, text: string): StrategyResult | null {
  switch (toolName) {
    case BASH_TOOL_NAME:
      if (text.length < BASH_SUMMARIZE_THRESHOLD) return null
      return summarizeBashOutput(text)
    case GREP_TOOL_NAME:
      if (text.length < GREP_SUMMARIZE_THRESHOLD) return null
      return summarizeGrepOutput(text)
    case WEB_FETCH_TOOL_NAME:
      if (text.length < WEBFETCH_SUMMARIZE_THRESHOLD) return null
      return summarizeWebFetchOutput(text)
    case FILE_READ_TOOL_NAME:
      if (text.length < READ_SUMMARIZE_THRESHOLD) return null
      return summarizeReadOutput(text)
    case GLOB_TOOL_NAME:
      if (text.length < GLOB_SUMMARIZE_THRESHOLD) return null
      return summarizeGlobOutput(text)
    default:
      if (toolName.startsWith('mcp__')) {
        if (text.length < MCP_SUMMARIZE_THRESHOLD) return null
        return { body: applyHeadTail(text, MCP_HEAD_LINES, MCP_TAIL_LINES), strategy: 'mcp-head-tail' }
      }
      return null
  }
}

// ---------- marker ----------

function wrapMarker(
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

// ---------- shared guards (local to avoid import cycle into toolResultStorage) ----------

function isToolResultContentEmpty(
  content: ToolResultBlockParam['content'],
): boolean {
  if (!content) return true
  if (typeof content === 'string') return content.trim() === ''
  if (!Array.isArray(content)) return false
  if (content.length === 0) return true
  return content.every(
    block =>
      typeof block === 'object' &&
      'type' in block &&
      block.type === 'text' &&
      'text' in block &&
      (typeof block.text !== 'string' || block.text.trim() === ''),
  )
}

// String-only shim: the caller ensures content is a string, so the only
// "image" surface is a provider that pre-embedded a data URL in text —
// out of scope. Kept as an always-false stub so the guard site reads
// symmetrically with toolResultStorage.hasImageBlock on arrays.
function hasImageContentBlock(_text: string): boolean {
  return false
}

function isAlreadyCompacted(text: string): boolean {
  // <persisted-output> or <tool-result-summary (either marker at start)
  // <bash-output-rewritten> or <bash-output-filtered> — markers from the
  // bash-output-filter pipeline (Phase 0+ of roadmap 6.1)
  return (
    text.startsWith('<persisted-output>') ||
    text.startsWith(TOOL_RESULT_SUMMARY_TAG) ||
    text.startsWith('<bash-output-rewritten') ||
    text.startsWith('<bash-output-filtered')
  )
}

// ---------- array-content dispatch ----------

function maybeSummarizeArrayContent(
  block: ToolResultBlockParam,
  toolName: string,
): ToolResultBlockParam {
  const blocks = block.content as Array<{ type: string; text?: string }>

  const strategyResult = dispatchArray(toolName, blocks)
  if (strategyResult === null) return block

  const originalSizeBytes = joinTextBlocks(blocks).length
  const wrapped = wrapMarker(
    toolName,
    originalSizeBytes,
    strategyResult.body.length,
    strategyResult.strategy,
    strategyResult.body,
    strategyResult.envelopeAttrs,
  )

  if (wrapped.length >= originalSizeBytes) return block

  logEvent('claudio_tool_result_summarized', {
    toolName: sanitizeToolNameForAnalytics(toolName),
    originalSizeBytes,
    summarizedSizeBytes: wrapped.length,
    estimatedOriginalTokens: Math.ceil(originalSizeBytes / BYTES_PER_TOKEN),
    estimatedSummarizedTokens: Math.ceil(wrapped.length / BYTES_PER_TOKEN),
    strategyId: STRATEGY_ID[strategyResult.strategy],
    reductionPct: Math.floor(100 * (1 - wrapped.length / originalSizeBytes)),
  })

  return { ...block, content: wrapped }
}

function dispatchArray(
  toolName: string,
  blocks: Array<{ type: string; text?: string }>,
): StrategyResult | null {
  if (toolName === AGENT_TOOL_NAME || toolName === LEGACY_AGENT_TOOL_NAME) {
    return summarizeAgentOutput(blocks)
  }
  if (toolName.startsWith('mcp__')) {
    const hasNonTextBlocks = blocks.some(b => b.type !== 'text')
    if (hasNonTextBlocks) return null  // preserve images
    return summarizeMcpOutput(blocks)
  }
  return null
}

const AGENT_HEAD_LINES = 50
const AGENT_TAIL_LINES = 50

const MCP_HEAD_LINES = 50
const MCP_TAIL_LINES = 50

/** Joins only text blocks, ignoring images and unknown types. */
function joinTextBlocks(blocks: Array<{ type: string; text?: string }>): string {
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
function applyHeadTail(text: string, headLines: number, tailLines: number): string {
  const lines = text.split('\n')
  if (lines.length <= headLines + tailLines) return text
  const omitted = lines.length - headLines - tailLines
  return [
    ...lines.slice(0, headLines),
    `<omitted lines="${omitted}"/>`,
    ...lines.slice(-tailLines),
  ].join('\n')
}

function summarizeAgentOutput(
  blocks: Array<{ type: string; text?: string }>,
): StrategyResult | null {
  const lastBlock = blocks[blocks.length - 1]
  const isTrailerBlock =
    lastBlock?.type === 'text' &&
    typeof lastBlock.text === 'string' &&
    (lastBlock.text.includes('<usage>') || lastBlock.text.startsWith('agentId:'))

  const mainBlocks = isTrailerBlock ? blocks.slice(0, -1) : blocks
  const trailerText = isTrailerBlock ? '\n' + lastBlock.text! : ''

  const joinedText = joinTextBlocks(mainBlocks)
  if (joinedText.length < AGENT_SUMMARIZE_THRESHOLD) return null

  const body = applyHeadTail(joinedText, AGENT_HEAD_LINES, AGENT_TAIL_LINES) + trailerText
  return { body, strategy: 'agent-head-tail' }
}

function summarizeMcpOutput(
  blocks: Array<{ type: string; text?: string }>,
): StrategyResult | null {
  const joinedText = joinTextBlocks(blocks)
  if (joinedText.length < MCP_SUMMARIZE_THRESHOLD) return null

  return { body: applyHeadTail(joinedText, MCP_HEAD_LINES, MCP_TAIL_LINES), strategy: 'mcp-head-tail' }
}

// ============================================================
// Strategy 1: Bash
// ============================================================

const BASH_HEAD_LINES = 40
const BASH_TAIL_LINES = 60
const BASH_ERROR_BEFORE = 5
const BASH_ERROR_AFTER = 10
const MAX_LINE_WIDTH = 500

// Two-pass error detection. Split into two regexes so case-sensitive anchors
// (line-anchored `Exit code:`, all-caps `FAIL`/`FATAL` log markers that we
// don't want matching common words like "email"/"email failure") stay rigid
// while the primary error tokens are case-insensitive.
//
// Strict pass — case-sensitive, anchor-bearing:
// - `^Exit code: N$` requires the /m flag and a non-zero numeric code.
// - `\bFAIL(?:ED)?\b` stays uppercase-only to avoid matching "fail" inside
//   compound English (it's rare to see standalone "FAIL" outside CI logs).
// - `\bFATAL\b` (no colon) catches log4j-style level markers (`[FATAL]`,
//   `FATAL com.foo.Bar - oops`) which routinely appear without a colon.
const BASH_ERROR_REGEX_STRICT =
  /^Exit code: [1-9]\d*$|\bFAIL(?:ED)?\b|\bFATAL\b/m

// Loose pass — case-insensitive, with deliberate FP-reduction shape.
// - `\b(?:error|exception|fatal|panic)(?:\[[^\]]+\])?:` requires `:` directly
//   after the token (or after an optional `[CODE]` block, e.g. Rust's
//   `error[E0308]:`). This drops "Graceful Exception handler installed" and
//   "no errors found" while keeping `gcc error:`, `cargo build` errors, and
//   server `ERROR:` log lines.
// - `Traceback \(most recent call last\):` is the canonical Python prefix.
// - `panicked at` covers Rust runtime panics
//   (`thread 'main' panicked at 'msg'`).
// - `undefined reference to` covers linker errors.
const BASH_ERROR_REGEX_LOOSE =
  /\b(?:error|exception|fatal|panic)(?:\[[^\]]+\])?:|Traceback \(most recent call last\):|panicked at|undefined reference to/i

function summarizeBashOutput(text: string): StrategyResult | null {
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
    const from = Math.max(0, idx - BASH_ERROR_BEFORE)
    const to = Math.min(total, idx + BASH_ERROR_AFTER + 1)
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
  for (let i = 1; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (line === runLine) {
      runCount++
      continue
    }
    out.push(runCount > 1 ? `${runLine} (×${runCount})` : runLine)
    runLine = line
    runCount = 1
  }
  out.push(runCount > 1 ? `${runLine} (×${runCount})` : runLine)
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

function findErrorIndices(lines: string[]): number[] {
  const out: number[] = []
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i] ?? ''
    if (BASH_ERROR_REGEX_STRICT.test(line) || BASH_ERROR_REGEX_LOOSE.test(line)) {
      out.push(i)
    }
  }
  // Keep only first and last to bound error-window explosion.
  if (out.length <= 2) return out
  return [out[0]!, out[out.length - 1]!]
}

function truncateLine(line: string): string {
  if (line.length <= MAX_LINE_WIDTH) return line
  return (
    line.slice(0, MAX_LINE_WIDTH) + `…[${line.length - MAX_LINE_WIDTH}b]`
  )
}

// ============================================================
// Strategy 2: Grep
// ============================================================

const GREP_MAX_MATCHES_PER_FILE = 10
const GREP_MAX_FILES = 50

function summarizeGrepOutput(text: string): StrategyResult | null {
  const lines = text.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return null

  // Count-mode passthrough: if ≥80% of lines look like `path:count`,
  // the output is already small and structured.
  const countLineRegex = /^[^:]+:\d+$/
  const countLineMatches = lines.reduce(
    (n, l) => (countLineRegex.test(l) ? n + 1 : n),
    0,
  )
  if (countLineMatches / lines.length >= 0.8) return null

  // Parse lines into (file, lineNumber, text). Non-matching lines go to
  // "other" bucket preserved verbatim.
  const matchRegex = /^([^:]+):(\d+):(.*)$/
  // Plain object with explicit sorted iteration for determinism.
  const byFile: Record<string, Array<{ line: string; n: number }>> = {}
  const files: string[] = []
  const other: string[] = []
  let totalMatches = 0

  for (const line of lines) {
    const m = matchRegex.exec(line)
    if (!m) {
      other.push(line)
      continue
    }
    const file = m[1]!
    if (!(file in byFile)) {
      byFile[file] = []
      files.push(file)
    }
    byFile[file]!.push({ line, n: Number(m[2]) })
    totalMatches++
  }

  if (files.length === 0) return null

  // Sort files: primary by match count DESC, secondary by filename ASC
  // — pure deterministic ordering (no Map iteration, no Date).
  const sortedFiles = [...files].sort((a, b) => {
    const diff = (byFile[b]?.length ?? 0) - (byFile[a]?.length ?? 0)
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })

  const kept = sortedFiles.slice(0, GREP_MAX_FILES)
  const dropped = sortedFiles.slice(GREP_MAX_FILES)

  const body: string[] = []
  body.push(
    `Grep summary: files=${files.length}, matches=${totalMatches}` +
      (other.length > 0 ? `, other=${other.length}` : ''),
  )

  for (const file of kept) {
    const entries = byFile[file]!
    const shown = entries.slice(0, GREP_MAX_MATCHES_PER_FILE)
    body.push(`--- ${file} (${entries.length} match${entries.length === 1 ? '' : 'es'}) ---`)
    for (const entry of shown) {
      body.push(truncateLine(entry.line))
    }
    const extra = entries.length - shown.length
    if (extra > 0) {
      body.push(`${file}: +${extra} more match${extra === 1 ? '' : 'es'}`)
    }
  }

  if (dropped.length > 0) {
    const droppedMatches = dropped.reduce(
      (n, f) => n + (byFile[f]?.length ?? 0),
      0,
    )
    body.push(
      `<omitted>: ${dropped.length} file${dropped.length === 1 ? '' : 's'}, ${droppedMatches} match${droppedMatches === 1 ? '' : 'es'} not shown`,
    )
  }

  if (other.length > 0) {
    body.push('--- other (preserved literally) ---')
    for (const line of other) body.push(truncateLine(line))
  }

  return { body: body.join('\n'), strategy: 'grep-grouped' }
}

// ============================================================
// Strategy 3: WebFetch
// ============================================================

const WEBFETCH_HEAD_LINES = 100
const WEBFETCH_TAIL_LINES = 40
const WEBFETCH_TITLE_LINES = 3

function summarizeWebFetchOutput(text: string): StrategyResult {
  // Detect HTML residual density: > 1 HTML marker per 2KB.
  const htmlMarkers =
    (text.match(/<script[\s>]/gi)?.length ?? 0) +
    (text.match(/<style[\s>]/gi)?.length ?? 0) +
    (text.match(/<!DOCTYPE/gi)?.length ?? 0)
  const htmlDense = htmlMarkers > Math.max(1, Math.floor(text.length / 2048))

  let working = text
  let strategy: StrategyName = 'webfetch-head-tail'

  if (htmlDense) {
    // Strip script/style blocks (non-greedy, multiline).
    working = working
      .replace(/<script\b[^>]*>[\s\S]*?<\/script>/gi, '')
      .replace(/<style\b[^>]*>[\s\S]*?<\/style>/gi, '')
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

// ============================================================
// Strategy 4: Read
// ============================================================

const READ_HEAD_LINES = 50
const READ_TAIL_LINES = 50

function summarizeReadOutput(text: string): StrategyResult | null {
  const lines = text.split('\n')

  // Identify the range of numbered lines — the file content proper.
  // Lines outside that range are prefix/suffix metadata emitted by FileReadTool.
  const numberedLineRegex = /^\s*\d+→/
  let firstNumbered = -1
  let lastNumbered = -1
  for (let i = 0; i < lines.length; i++) {
    if (numberedLineRegex.test(lines[i] ?? '')) {
      if (firstNumbered === -1) firstNumbered = i
      lastNumbered = i
    }
  }

  // No numbered lines means Read returned an error or a non-file message — pass through unchanged.
  if (firstNumbered === -1) return null

  const prefixLines = lines.slice(0, firstNumbered)
  const contentLines = lines.slice(firstNumbered, lastNumbered + 1)
  const suffixLines = lines.slice(lastNumbered + 1)

  const numberedCount = contentLines.length
  const headEnd = Math.min(READ_HEAD_LINES, numberedCount)
  const tailStart = Math.max(headEnd, numberedCount - READ_TAIL_LINES)

  const parts: string[] = []

  for (const line of prefixLines) parts.push(line)

  for (let i = 0; i < headEnd; i++) {
    parts.push(truncateLine(contentLines[i] ?? ''))
  }

  // Capture elision metadata for both the inline `<elision/>` marker AND the
  // envelope attributes. Read is the dominant narration trigger on Opus 4.8;
  // shaping the marker as metadata (rather than prose like "[...lines X-Y
  // omitted...]") and lifting the same data into envelope attrs moves it out
  // of "prose the model reacts to". See StrategyResult.envelopeAttrs.
  let elidedRange: string | null = null
  if (tailStart > headEnd) {
    // Extract the actual source line numbers from the N→ prefixes for the marker.
    const firstOmittedMatch = /^\s*(\d+)→/.exec(contentLines[headEnd] ?? '')
    const lastOmittedMatch = /^\s*(\d+)→/.exec(contentLines[tailStart - 1] ?? '')
    const firstLine = firstOmittedMatch ? firstOmittedMatch[1] : String(headEnd + 1)
    const lastLine = lastOmittedMatch ? lastOmittedMatch[1] : String(tailStart)
    const omittedCount = tailStart - headEnd
    let omittedChars = 0
    for (let i = headEnd; i < tailStart; i++) {
      omittedChars += (contentLines[i] ?? '').length + 1
    }
    elidedRange = `${firstLine}-${lastLine}`
    parts.push(
      `<elision lines="${firstLine}-${lastLine}" count="${omittedCount}" bytes="${formatFileSize(omittedChars)}"/>`,
    )
  }

  for (let i = tailStart; i < numberedCount; i++) {
    parts.push(truncateLine(contentLines[i] ?? ''))
  }

  for (const line of suffixLines) parts.push(line)

  // Determine shown line range from numbered prefixes for the footer.
  const firstShownMatch = /^\s*(\d+)→/.exec(contentLines[0] ?? '')
  const lastHeadMatch = /^\s*(\d+)→/.exec(contentLines[headEnd - 1] ?? '')
  const lastShownMatch = /^\s*(\d+)→/.exec(contentLines[numberedCount - 1] ?? '')

  const firstLineNum = firstShownMatch ? firstShownMatch[1] : '1'
  const lastHeadNum = lastHeadMatch ? lastHeadMatch[1] : String(headEnd)
  const lastLineNum = lastShownMatch ? lastShownMatch[1] : String(numberedCount)

  // Footer reshaped as metadata: same totals/range data, attribute-style,
  // no prose for the model to commentate on.
  if (tailStart > headEnd) {
    const firstTailMatch = /^\s*(\d+)→/.exec(contentLines[tailStart] ?? '')
    const firstTailNum = firstTailMatch ? firstTailMatch[1] : String(tailStart + 1)
    parts.push(
      `<read-summary total="${numberedCount}" shown="${firstLineNum}-${lastHeadNum},${firstTailNum}-${lastLineNum}"/>`,
    )
  } else {
    parts.push(
      `<read-summary total="${numberedCount}" shown="${firstLineNum}-${lastLineNum}"/>`,
    )
  }

  const envelopeAttrs: Record<string, string> | undefined = elidedRange
    ? { elided: elidedRange, hint: 'use offset/limit to re-read omitted range' }
    : undefined

  return { body: parts.join('\n'), strategy: 'read-head-tail', envelopeAttrs }
}

// ============================================================
// Strategy 5: Glob
// ============================================================

const GLOB_MAX_PATHS = 50

function summarizeGlobOutput(text: string): StrategyResult | null {
  const allLines = text.split('\n').filter(l => l.length > 0)

  // Separate the truncation notice from actual paths — it's metadata, not a path.
  const TRUNC_RE = /^\(Results are truncated/i
  const truncationNotices = allLines.filter(l => TRUNC_RE.test(l))
  const pathLines = allLines.filter(l => !TRUNC_RE.test(l))

  // No paths means Glob returned nothing useful — pass through.
  if (pathLines.length === 0) return null

  const total = pathLines.length
  const kept = pathLines.slice(0, GLOB_MAX_PATHS)
  const omitted = total - kept.length

  const parts: string[] = []
  if (omitted > 0) {
    parts.push(`Glob summary: ${total} path${total === 1 ? '' : 's'} found, showing first ${kept.length}`)
  } else {
    parts.push(`Glob summary: ${total} path${total === 1 ? '' : 's'} found`)
  }

  for (const p of kept) parts.push(p)

  if (omitted > 0) {
    parts.push(`<omitted paths="${omitted}"/>`)
  }

  for (const notice of truncationNotices) parts.push(notice)

  return { body: parts.join('\n'), strategy: 'glob-top-n' }
}

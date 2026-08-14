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
import { feature } from 'bun:bundle'
import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { BYTES_PER_TOKEN } from 'src/constants/toolLimits.js'
import { compressJsonArray } from './jsonArrayCompress.js'
import { detectCodeLang, stripLineNumberPrefix } from 'src/utils/fs/detectCodeLang.js'
import { scanSymbols } from 'src/tools/shared/codeOutline/scanSymbols.js'
import { renderOutlineBody } from 'src/tools/shared/codeOutline/renderOutline.js'
import { recordBytesSaved } from 'src/services/context/tokensSaved.js'
import { logEvent } from 'src/services/analytics/index.js'
import { sanitizeToolNameForAnalytics } from 'src/services/analytics/metadata.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { GLOB_TOOL_NAME } from 'src/tools/GlobTool/prompt.js'
import { GREP_TOOL_NAME } from 'src/tools/GrepTool/prompt.js'
import { AGENT_TOOL_NAME, LEGACY_AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { WEB_FETCH_TOOL_NAME } from 'src/tools/WebFetchTool/prompt.js'
import { getGlobalConfig } from 'src/services/config/config.js'
import { logForDebugging } from 'src/utils/debug.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { formatFileSize } from 'src/utils/text/format.js'

// Opening tag is intentionally incomplete ("<tool-result-summary" without '>')
// so attribute-carrying markers still match `startsWith` checks verbatim.
export const TOOL_RESULT_SUMMARY_TAG = '<tool-result-summary'
export const TOOL_RESULT_SUMMARY_CLOSING_TAG = '</tool-result-summary>'

// json-structural only earns a strategy slot when it meaningfully shrinks the
// payload. Without this floor a wrapper-dominated object (a giant non-array
// field beside a small array) renders ~as large as the input and would ship as
// a near-zero "compression"; the original passes through instead.
const JSON_MIN_SAVINGS = 0.15
function jsonSavesEnough(render: string, original: string): boolean {
  return render.length <= original.length * (1 - JSON_MIN_SAVINGS)
}

// Same floor for the code-outline strategy: an outline that barely shrinks the
// source (a file of one-liners) ships as a near-zero "compression", so it falls
// through to head/tail instead.
const CODE_MIN_SAVINGS = 0.15
function codeSavesEnough(render: string, original: string): boolean {
  return render.length <= original.length * (1 - CODE_MIN_SAVINGS)
}

// A blob needs at least this many symbols to be worth outlining; below it the
// outline saves nothing and head/tail is just as good.
const CODE_OUTLINE_MIN_SYMBOLS = 3

// Per-tool thresholds (chars). Kept local to avoid importing toolLimits cycles.
const BASH_SUMMARIZE_THRESHOLD = 8_000
const GREP_SUMMARIZE_THRESHOLD = 6_000
/**
 * Grep has a second, lower gate. Between the floor and the threshold a summary
 * ships ONLY if it elides no match line — clamped context and collapsed
 * duplicates are fine, a `+N more matches` counter is not.
 *
 * Measured over the recorded transcripts before choosing this shape: dropping
 * the threshold to 3,000 outright would newly summarize 552 results and save
 * 908,145 chars, but HALF of them (275) would trade a match locator for a
 * counter, against a third in the band already summarized. Small results skew
 * match-dense — a body that clears 3,000 without context is a listing where
 * every line is a distinct hit — so the naive cut buys its extra bytes with
 * exactly the information a search is for. Restricted to the lossless ones it
 * is 404,528 chars over 277 results and nothing a match line said is lost.
 */
const GREP_SUMMARIZE_FLOOR = 3_000
const WEBFETCH_SUMMARIZE_THRESHOLD = 12_000
const GLOB_SUMMARIZE_THRESHOLD = 3_000
const AGENT_SUMMARIZE_THRESHOLD = 8_000
const MCP_SUMMARIZE_THRESHOLD = 8_000

/**
 * Gate for the JSON/array structural-compression strategy (roadmap #1/#2).
 * Mirrors `autoOutlineOnElisionEnabled` (FileReadTool.ts): the env override is
 * mandatory because the test-preload (src/stubs/test-preload.ts) stubs every
 * `feature()` call to false, so tests reach the ON path only via the env var.
 * Production folds `feature('TOOL_RESULT_JSON_COMPRESSION')` at build time.
 */
export function isToolResultJsonCompressionEnabled(): boolean {
  if (process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION === '1') return true
  if (process.env.CLAUDIN_TOOL_RESULT_JSON_COMPRESSION === '0') return false
  if (feature('TOOL_RESULT_JSON_COMPRESSION')) return true
  return false
}

/**
 * Gate for the code-outline strategy (roadmap side-bet). Same shape as the JSON
 * gate above: the env override is mandatory because the test-preload stubs every
 * `feature()` to false, so tests reach the ON path only via the env var.
 * Production folds `feature('TOOL_RESULT_CODE_OUTLINE')` at build time.
 */
export function isToolResultCodeOutlineEnabled(): boolean {
  if (process.env.CLAUDIN_CODE_OUTLINE === '1') return true
  if (process.env.CLAUDIN_CODE_OUTLINE === '0') return false
  if (feature('TOOL_RESULT_CODE_OUTLINE')) return true
  return false
}

// Strategy enum numeric IDs (analytics payloads only accept boolean|number).
// id 5 ('read-head-tail') was retired; do not reuse — analytics continuity.
const STRATEGY_ID: Record<StrategyName, number> = {
  'head-tail-errors': 1,
  'grep-grouped': 2,
  'webfetch-stripped': 3,
  'webfetch-head-tail': 4,
  'glob-top-n': 6,
  'agent-head-tail': 7,
  'mcp-head-tail': 8,
  'json-structural': 9,
  'code-outline': 10,
}

type StrategyName =
  | 'head-tail-errors'
  | 'grep-grouped'
  | 'webfetch-stripped'
  | 'webfetch-head-tail'
  | 'glob-top-n'
  | 'agent-head-tail'
  | 'mcp-head-tail'
  | 'json-structural'
  | 'code-outline'

type StrategyResult = {
  body: string
  strategy: StrategyName
  errorWindowPreserved?: boolean
  /**
   * grep-grouped only: how many match lines the body replaced with a counter
   * (`+N more matches`, `<omitted>`). Zero means every match rg reported is
   * still individually addressable in the summary. The dispatch gate reads it
   * rather than grepping the body, so a change to the counter wording cannot
   * silently turn a lossy summary into an eligible one.
   */
  matchesElided?: number
  /**
   * json-structural only: count of salient (error-keyword / rare-status) rows
   * pinned out of the dropped middle. Surfaced in analytics so the real-world
   * hit-rate of salient-row preservation can be measured (ROADMAP #6).
   */
  salientPinned?: number
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
    recordBytesSaved(originalSizeBytes, summarizedSizeBytes)

    logEvent('claudin_tool_result_summarized', {
      toolName: sanitizeToolNameForAnalytics(toolName),
      originalSizeBytes,
      summarizedSizeBytes,
      estimatedOriginalTokens: Math.ceil(originalSizeBytes / BYTES_PER_TOKEN),
      estimatedSummarizedTokens: Math.ceil(
        summarizedSizeBytes / BYTES_PER_TOKEN,
      ),
      strategyId: STRATEGY_ID[strategyResult.strategy],
      errorWindowPreserved: strategyResult.errorWindowPreserved,
      salientPinned: strategyResult.salientPinned,
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

  recordBytesSaved(originalSizeBytes, wrapped.length)

  logEvent('claudin_tool_result_summarized', {
    toolName: sanitizeToolNameForAnalytics(toolName),
    originalSizeBytes,
    summarizedSizeBytes: wrapped.length,
    estimatedOriginalTokens: Math.ceil(originalSizeBytes / BYTES_PER_TOKEN),
    estimatedSummarizedTokens: Math.ceil(wrapped.length / BYTES_PER_TOKEN),
    strategyId: STRATEGY_ID[strategyResult.strategy],
    salientPinned: strategyResult.salientPinned,
    reductionPct: Math.floor(100 * (1 - wrapped.length / originalSizeBytes)),
  })

  return { ...block, content: wrapped }
}

function dispatchArray(
  toolName: string,
  blocks: Array<{ type: string; text?: string }>,
): StrategyResult | null {
  if (toolName === AGENT_TOOL_NAME || toolName === LEGACY_AGENT_TOOL_NAME) {
    const { mainBlocks, trailerText } = splitAgentTrailer(blocks)
    const jc = maybeJsonStructural(blocks, AGENT_SUMMARIZE_THRESHOLD)
    if (jc) return jc
    // Code-outline scans the main blocks only; re-append the agent trailer
    // (agentId:/<usage>) so it survives, mirroring summarizeAgentOutput.
    const code = maybeCodeOutline(joinTextBlocks(mainBlocks), AGENT_SUMMARIZE_THRESHOLD)
    if (code) return { ...code, body: code.body + trailerText }
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

/**
 * Try structural JSON compression on the joined text blocks of an array-content
 * result (Agent/MCP). Gated + above-threshold + actually compressible, else null
 * so the caller falls through to its existing head/tail strategy.
 */
function maybeJsonStructural(
  blocks: Array<{ type: string; text?: string }>,
  threshold: number,
): StrategyResult | null {
  if (!isToolResultJsonCompressionEnabled()) return null
  const text = joinTextBlocks(blocks)
  if (text.length < threshold) return null
  const jc = compressJsonArray(text)
  if (!jc || !jsonSavesEnough(jc.render, text)) return null
  return {
    body: jc.render,
    strategy: 'json-structural',
    salientPinned: jc.salientPinned,
  }
}

/**
 * Code-outline strategy: when the whole result is recognizably one source file,
 * replace its body with the scanSymbols structural outline (signatures + line
 * ranges) instead of blind head/tail. The full source is persisted verbatim by
 * `makeReversibleIfElided`, so the dropped bodies stay retrievable via Read
 * offset/limit + Grep on the marker's `source=` path (outline ranges == raw
 * line numbers). Returns null on any miss so the caller falls through to its
 * existing head/tail strategy.
 */
function summarizeCodeOutline(text: string): StrategyResult | null {
  try {
    if (!isToolResultCodeOutlineEnabled()) return null
    const lines = text.split('\n')
    // Strip a uniform `cat -n`/`grep -n` numeric prefix for scanning only; this
    // never changes line count/positions, so ranges still match the raw source.
    const stripped = stripLineNumberPrefix(lines).join('\n')
    const lang = detectCodeLang(stripped)
    if (lang === null) return null
    const entries = scanSymbols(stripped, lang)
    if (entries.length < CODE_OUTLINE_MIN_SYMBOLS) return null
    const body = renderOutlineBody(entries)
    if (!codeSavesEnough(body, text)) return null
    return {
      body,
      strategy: 'code-outline',
      envelopeAttrs: {
        symbols: String(entries.length),
        lines: String(lines.length),
      },
    }
  } catch (error) {
    logForDebugging(
      `summarizeCodeOutline: ${(error as Error)?.message ?? String(error)}`,
      { level: 'warn' },
    )
    return null
  }
}

/**
 * Try code-outline on a text blob (string or joined array content). Gated +
 * above-threshold, else null so the caller falls through to head/tail.
 */
function maybeCodeOutline(text: string, threshold: number): StrategyResult | null {
  if (!isToolResultCodeOutlineEnabled()) return null
  if (text.length < threshold) return null
  return summarizeCodeOutline(text)
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

function summarizeAgentOutput(
  blocks: Array<{ type: string; text?: string }>,
): StrategyResult | null {
  const { mainBlocks, trailerText } = splitAgentTrailer(blocks)

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
//
// Regroups a content-mode ripgrep body by file: per-file header, up to
// GREP_MAX_MATCHES_PER_FILE matches with a `+N more` tail, up to GREP_MAX_FILES
// files with an `<omitted>` tail, context clamped to GREP_CONTEXT_RADIUS lines
// around each surviving match, and verbatim repeats collapsed to a
// back-reference. Anything that cannot be anchored to a match is preserved
// literally, so a malformed or mixed-format body degrades into a passthrough
// (via the caller's no-win guard) instead of losing lines.
//
// The header REPLACES the path on the lines it covers — they carry `NN:text`
// only. That is what makes a match-only body shrink at all: while the path was
// repeated under the header, the grouping cost more than it saved on every
// result rg didn't pad with context, and the no-win guard threw those summaries
// away. A header that would replace too few paths to cover its own cost is not
// emitted at all and the block stays inline, so the strategy no longer has a
// shape it reliably makes worse. A body rg emitted with no filename at all (a
// content search scoped to one file) groups headerless under GREP_NO_PATH.
//
// Measured over the recorded transcripts (scripts/profile/grep-summarizer-replay.ts,
// 5,095 real content-mode results): 15.5% of all Grep chars and 33.5% of the
// context-bearing ones, across 443 results. That is the two-tier gate above
// (GREP_SUMMARIZE_FLOOR): 166 results from the ≥6,000 band and 277 lossless
// ones between 3,000 and 6,000. The bench prints the three policies side by
// side — admitting everything over 3,000 would reach 22.5%, but the count of
// results that trade a match line for a counter goes from 56 to 331, which is
// the column that decided this.

const GREP_MAX_MATCHES_PER_FILE = 10
const GREP_MAX_FILES = 50

/**
 * How far a context line may sit from the nearest surviving match in its own
 * file before it is dropped. Ripgrep's `-A/-B/-C` lines are 91% of the body of
 * every context-bearing Grep result and 43.6% of all content-mode Grep chars
 * (measured over a week of transcripts), and callers routinely ask for `-C 12`
 * or more. ±3 keeps a readable window around each hit.
 */
const GREP_CONTEXT_RADIUS = 3

// Ripgrep marks a match line `path:NN:text` and a context line `path-NN-text`.
// Unanchored and global: the separator run occurs inside real paths as well as
// at the true boundary, so every candidate is enumerated and the whole result
// votes on which one is real (see chooseGrepSplits).
const GREP_PREFIX_RE = /([:-])(\d+)\1/g
// The same line with the filename omitted (`-H false`, i.e. a content search
// scoped to one file): a leading line number and ONE separator, not two.
const GREP_PATHLESS_RE = /^(\d+)([:-])/
const GREP_BLANK_RE = /^\s*$/
// rg prints this between non-contiguous context blocks; the per-file grouping
// below replaces what it conveyed.
const GREP_BLOCK_SEPARATOR = '--'
// `path:count` — the shape of `output_mode: "count"`, which is already small.
const GREP_COUNT_LINE_RE = /^[^:]+:\d+$/

type GrepEntry = {
  n: number
  /**
   * The line number exactly as rg wrote it. `n` is for arithmetic (sorting and
   * the context clamp); this is what gets printed, so a summary cannot hand
   * back a locator that differs by a character from the line it came from.
   */
  raw: string
  body: string
  isMatch: boolean
}

type GrepSplit = { file: string } & GrepEntry

/**
 * The file key for a body rg emitted without any path — a content search scoped
 * to a single file, where every line is `NN:text`. There is no path to group
 * under and none to strip, so the block prints headerless and the saving comes
 * from the context clamp alone.
 */
const GREP_NO_PATH = ''

/**
 * Every way one ripgrep line could be split into `path`, line number and text,
 * left to right. A line usually has more than one: the code text can contain
 * `:9:`, and the path itself can contain `-2026-`.
 *
 * `allowPathless` admits the `NN:text` form, whose "path" is the empty string.
 * It is off for the first pass because a normal result's literal bucket is full
 * of lines that would parse that way by accident.
 */
function grepLineSplits(line: string, allowPathless: boolean): GrepSplit[] {
  const out: GrepSplit[] = []
  if (allowPathless) {
    const m = GREP_PATHLESS_RE.exec(line)
    if (m) {
      out.push({
        file: GREP_NO_PATH,
        n: Number(m[1]),
        raw: m[1]!,
        body: line.slice(m[0].length),
        isMatch: m[2] === ':',
      })
    }
  }
  for (const m of line.matchAll(GREP_PREFIX_RE)) {
    const cut = m.index
    if (cut === 0) continue
    out.push({
      file: line.slice(0, cut),
      n: Number(m[2]),
      raw: m[2]!,
      body: line.slice(cut + m[0].length),
      isMatch: m[1] === ':',
    })
  }
  return out
}

/**
 * Picks one split per line, using the whole result as evidence.
 *
 * Taking the leftmost split — what this did before — mislabels every line of a
 * file whose own name carries a separator run: `notes-2026-07-25.md:12:text`
 * reads as file `notes`, line 2026, and the file then has context but no match,
 * so the strategy drops it into the literal bucket and summarizes nothing. The
 * three kinds of candidate are separable by how they behave ACROSS lines:
 *
 * - the real path recurs with a different line number on every line it appears;
 * - a split inside the path pins the same number every time (`notes` is always
 *   line 2026);
 * - a split inside the code text belongs to one line only.
 *
 * So rank by distinct line numbers, then by lines covered, and keep the
 * leftmost on a tie — which is what a single-line result gets, i.e. the old
 * behavior, and it degrades to the literal bucket rather than to a wrong path.
 *
 * A body where fewer than half the lines carry a path is retried as pathless —
 * a content search scoped to one file, where rg omits the filename entirely and
 * this used to parse nothing and ship in full. The retry is purely additive (a
 * line starting with a path has no pathless reading), and gating it on the
 * majority is what keeps a NORMAL result byte-identical: its literal bucket
 * routinely holds a stray `117:text` line that must stay preserved rather than
 * become a clampable entry.
 */
function chooseGrepSplits(lines: string[]): Array<GrepSplit | null> {
  const pathed = rankGrepSplits(lines.map(l => grepLineSplits(l, false)))
  const parsed = pathed.reduce((n, s) => (s === null ? n : n + 1), 0)
  if (parsed * 2 >= lines.length) return pathed
  const pathless = rankGrepSplits(lines.map(l => grepLineSplits(l, true)))
  const parsedPathless = pathless.reduce((n, s) => (s === null ? n : n + 1), 0)
  return parsedPathless > parsed ? pathless : pathed
}

function rankGrepSplits(perLine: GrepSplit[][]): Array<GrepSplit | null> {
  const numbers: Record<string, Set<number>> = Object.create(null)
  const covered: Record<string, number> = Object.create(null)
  for (const splits of perLine) {
    for (const s of splits) {
      numbers[s.file] ??= new Set()
      numbers[s.file]!.add(s.n)
      covered[s.file] = (covered[s.file] ?? 0) + 1
    }
  }
  return perLine.map(splits => {
    let best: GrepSplit | null = null
    let bestDistinct = -1
    let bestCovered = -1
    for (const s of splits) {
      const distinct = numbers[s.file]!.size
      const cover = covered[s.file]!
      if (
        distinct > bestDistinct ||
        (distinct === bestDistinct && cover > bestCovered)
      ) {
        best = s
        bestDistinct = distinct
        bestCovered = cover
      }
    }
    return best
  })
}

/** Full `path:NN:text` — for lines emitted OUTSIDE a per-file header. */
function renderGrepLine(file: string, entry: GrepEntry, body: string): string {
  const sep = entry.isMatch ? ':' : '-'
  return `${file}${sep}${entry.raw}${sep}${body}`
}

/**
 * `NN:text` — for lines under a `--- file (N matches) ---` header, where the
 * path is dead weight. Repeating it is what made the summary of a match-only
 * body LARGER than the input: the path is the longest term on most lines, so
 * the grouping paid for a header AND kept everything the header replaced. The
 * `file:line` reference the model needs is still reconstructable from the two.
 */
function renderGrepBlockLine(entry: GrepEntry, body: string): string {
  const sep = entry.isMatch ? ':' : '-'
  return `${entry.raw}${sep}${body}`
}

/** Whichever of the two forms reproduces the line rg actually emitted. */
function renderGrepSourceLine(
  file: string,
  entry: GrepEntry,
  body: string,
): string {
  return file === GREP_NO_PATH
    ? renderGrepBlockLine(entry, body)
    : renderGrepLine(file, entry, body)
}

/**
 * Exported for the replay bench (scripts/profile/grep-summarizer-replay.ts) and
 * the regression tests, which need the raw strategy body without the envelope
 * and without the dispatch threshold.
 */
export function summarizeGrepOutput(text: string): StrategyResult | null {
  const lines = text.split('\n').filter(l => l.length > 0)
  if (lines.length === 0) return null

  // Count-mode passthrough: if ≥80% of lines look like `path:count`,
  // the output is already small and structured.
  const countLineMatches = lines.reduce(
    (n, l) => (GREP_COUNT_LINE_RE.test(l) ? n + 1 : n),
    0,
  )
  if (countLineMatches / lines.length >= 0.8) return null

  // Parse lines into (file, lineNumber, text, isMatch). Unparseable lines go to
  // the "other" bucket, preserved verbatim.
  // Null-prototype objects with explicit sorted iteration: determinism, and a
  // file (or a line body) literally named `__proto__` must not reach through to
  // Object.prototype — assigning it on a plain object leaves `byFile[file]`
  // without a `push`, which threw where the whole path is supposed to fail open.
  const byFile: Record<string, GrepEntry[]> = Object.create(null)
  const files: string[] = []
  const other: string[] = []
  let totalMatches = 0
  let totalContext = 0

  const splits = chooseGrepSplits(lines)
  for (let i = 0; i < lines.length; i++) {
    const line = lines[i]!
    if (line === GREP_BLOCK_SEPARATOR) continue
    const parsed = splits[i]
    if (!parsed) {
      other.push(line)
      continue
    }
    // A blank context line carries nothing the surrounding lines don't.
    if (!parsed.isMatch && GREP_BLANK_RE.test(parsed.body)) continue
    const { file, ...entry } = parsed
    if (!(file in byFile)) {
      byFile[file] = []
      files.push(file)
    }
    byFile[file]!.push(entry)
    if (entry.isMatch) totalMatches++
    else totalContext++
  }

  if (files.length === 0) return null

  const matchCount = (file: string): number =>
    byFile[file]?.reduce((n, e) => n + (e.isMatch ? 1 : 0), 0) ?? 0

  // A file with context but no match cannot happen in well-formed rg output —
  // context only exists around a match in the same file. It DOES happen when a
  // result mixes path forms (transcripts recorded before context lines were
  // relativized have absolute-path context and relative-path matches). Those
  // lines have no anchor, so clamping them would be guesswork: preserve them
  // literally instead of silently dropping them, and let the no-win guard
  // decide whether the summary is still worth shipping.
  const matchedFiles = files.filter(f => matchCount(f) > 0)
  if (matchedFiles.length === 0) return null
  for (const file of files) {
    if (matchCount(file) > 0) continue
    for (const entry of byFile[file]!) {
      other.push(renderGrepSourceLine(file, entry, entry.body))
      totalContext--
    }
  }

  // Sort files: primary by match count DESC, secondary by filename ASC
  // — pure deterministic ordering (no Map iteration, no Date).
  const sortedFiles = [...matchedFiles].sort((a, b) => {
    const diff = matchCount(b) - matchCount(a)
    if (diff !== 0) return diff
    return a < b ? -1 : a > b ? 1 : 0
  })

  const kept = sortedFiles.slice(0, GREP_MAX_FILES)
  const dropped = sortedFiles.slice(GREP_MAX_FILES)

  // Dedupe runs last, over surviving lines only: a back-reference to a line
  // that the clamp or the per-file cap removed would point at nothing.
  const firstSeen: Record<string, string> = Object.create(null)
  /** The body to print for one entry: its own, or a reference to an earlier one. */
  const dedupeBody = (file: string, entry: GrepEntry): string => {
    // The locator stays fully qualified: a back-reference routinely points at a
    // line under a DIFFERENT file's header.
    const locator =
      file === GREP_NO_PATH ? `line ${entry.raw}` : `${file}:${entry.raw}`
    const seen = firstSeen[entry.body]
    if (seen === undefined) {
      firstSeen[entry.body] = locator
      return entry.body
    }
    const marker = `… same as ${seen}`
    // Only a win when the repeated body is longer than the reference to it.
    return marker.length < entry.body.length ? marker : entry.body
  }

  const fileBlocks: string[] = []
  let contextKept = 0
  // Match lines this body replaces with a counter rather than printing. The
  // dispatch gate turns on it, so it counts BOTH elision paths.
  let matchesElided = 0

  for (const file of kept) {
    const entries = [...byFile[file]!].sort((a, b) => a.n - b.n)
    const matches = entries.filter(e => e.isMatch)
    const shownMatches = matches.slice(0, GREP_MAX_MATCHES_PER_FILE)
    const anchors = shownMatches.map(e => e.n)
    const shown = entries.filter(entry => {
      if (entry.isMatch) return shownMatches.includes(entry)
      // Context survives only next to a match that is itself still shown.
      return anchors.some(a => Math.abs(a - entry.n) <= GREP_CONTEXT_RADIUS)
    })

    const rendered = shown.map(entry => ({
      entry,
      body: dedupeBody(file, entry),
    }))
    for (const entry of shown) {
      if (!entry.isMatch) contextKept++
    }
    const extra = matches.length - shownMatches.length
    matchesElided += extra
    const more =
      extra > 0 ? `+${extra} more match${extra === 1 ? '' : 'es'}` : null

    // A pathless body has no path to hoist, so there is nothing to head.
    if (file === GREP_NO_PATH) {
      for (const r of rendered) {
        fileBlocks.push(truncateLine(renderGrepBlockLine(r.entry, r.body)))
      }
      if (more !== null) fileBlocks.push(more)
      continue
    }

    // The header only pays when it replaces the path on enough lines to cover
    // its own cost — with one match and no context it does not, and the summary
    // grew where it was emitted anyway. Rather than guess a line count, build
    // both forms and keep the shorter: the crossover moves with the length of
    // the path, which is the whole term being traded.
    const grouped = [
      `--- ${file} (${matches.length} match${matches.length === 1 ? '' : 'es'}) ---`,
      ...rendered.map(r => truncateLine(renderGrepBlockLine(r.entry, r.body))),
      ...(more === null ? [] : [more]),
    ]
    const inline = [
      ...rendered.map(r => truncateLine(renderGrepLine(file, r.entry, r.body))),
      ...(more === null ? [] : [`${file}: ${more}`]),
    ]
    fileBlocks.push(
      ...(grouped.join('\n').length <= inline.join('\n').length
        ? grouped
        : inline),
    )
  }

  const body: string[] = []
  body.push(
    `Grep summary: files=${matchedFiles.length}, matches=${totalMatches}` +
      (totalContext > 0 ? `, context=${contextKept}/${totalContext}` : '') +
      (other.length > 0 ? `, other=${other.length}` : ''),
  )
  body.push(...fileBlocks)

  if (dropped.length > 0) {
    const droppedMatches = dropped.reduce((n, f) => n + matchCount(f), 0)
    matchesElided += droppedMatches
    body.push(
      `<omitted>: ${dropped.length} file${dropped.length === 1 ? '' : 's'}, ${droppedMatches} match${droppedMatches === 1 ? '' : 'es'} not shown`,
    )
  }

  if (other.length > 0) {
    body.push('--- other (preserved literally) ---')
    for (const line of other) body.push(truncateLine(line))
  }

  return { body: body.join('\n'), strategy: 'grep-grouped', matchesElided }
}

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

// ============================================================
// Strategy 5: Glob
// ============================================================

const GLOB_MAX_PATHS = 50

function summarizeGlobOutput(text: string): StrategyResult | null {
  const allLines = text.split('\n').filter(l => l.length > 0)

  // Separate Glob's own notices from actual paths — they are metadata. Both
  // have to be here: counting a notice as a path inflates the total, and the
  // 50-path cap can then drop the INCOMPLETE line, which is the one saying the
  // listing is a prefix rather than the whole answer.
  const NOTICE_RE = /^\((?:Results are truncated|INCOMPLETE:)/i
  const notices = allLines.filter(l => NOTICE_RE.test(l))
  const pathLines = allLines.filter(l => !NOTICE_RE.test(l))

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

  for (const notice of notices) parts.push(notice)

  return { body: parts.join('\n'), strategy: 'glob-top-n' }
}

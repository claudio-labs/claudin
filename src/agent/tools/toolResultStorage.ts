/**
 * Utility for persisting large tool results to disk instead of truncating them.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from 'src/platform/bootstrap/state.js'
import {
  BYTES_PER_TOKEN,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
  MAX_TOOL_RESULT_BYTES,
} from 'src/tools/constants/toolLimits.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getErrnoCode, toError } from 'src/shared/errors.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { logError } from 'src/shared/log.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import {
  isLosslessSummarizerEnabled,
  isSummarizedContent,
  isToolResultCodeOutlineEnabled,
  isToolResultJsonCompressionEnabled,
  maybeCompactToolResult,
  maybeSummarizeToolResult,
} from 'src/agent/tools/toolResultSummarizer.js'
import { compressJsonArray } from 'src/agent/tools/jsonArrayCompress.js'
import { recordBytesSaved } from 'src/agent/context/tokensSaved.js'

// Subdirectory name for tool results within a session
export const TOOL_RESULTS_SUBDIR = 'tool-results'

// XML tag used to wrap persisted output messages
export const PERSISTED_OUTPUT_TAG = '<persisted-output>'
export const PERSISTED_OUTPUT_CLOSING_TAG = '</persisted-output>'

// Message used when tool result content was cleared without persisting to file
export const TOOL_RESULT_CLEARED_MESSAGE = '[Old tool result content cleared]'

/**
 * Resolve the effective persistence threshold for a tool: the declared
 * per-tool cap clamped by the global default.
 */
export function getPersistenceThreshold(
  declaredMaxResultSizeChars: number,
): number {
  // Infinity = hard opt-out. Read self-bounds via maxTokens; persisting its
  // output to a file the model reads back with Read is circular.
  if (!Number.isFinite(declaredMaxResultSizeChars)) {
    return declaredMaxResultSizeChars
  }
  return Math.min(declaredMaxResultSizeChars, DEFAULT_MAX_RESULT_SIZE_CHARS)
}

// Result of persisting a tool result to disk
export type PersistedToolResult = {
  filepath: string
  originalSize: number
  /** What was saved, as text: a result's text blocks joined by newlines. */
  text: string
}

// Error result when persistence fails
export type PersistToolResultError = {
  error: string
}

/**
 * Get the session directory (projectDir/sessionId)
 */
function getSessionDir(): string {
  return join(getProjectDir(getOriginalCwd()), getSessionId())
}

/**
 * Get the tool results directory for this session (projectDir/sessionId/tool-results)
 */
export function getToolResultsDir(): string {
  return join(getSessionDir(), TOOL_RESULTS_SUBDIR)
}

/**
 * Get the filepath where a tool result would be persisted.
 */
export function getToolResultPath(id: string, isJson: boolean): string {
  const ext = isJson ? 'json' : 'txt'
  return join(getToolResultsDir(), `${id}.${ext}`)
}

/**
 * Ensure the session-specific tool results directory exists
 */
export async function ensureToolResultsDir(): Promise<void> {
  try {
    await mkdir(getToolResultsDir(), { recursive: true })
  } catch {
    // Directory may already exist
  }
}

/**
 * Delete the tool-results spill directory for a given (old) session.
 *
 * Called by `/clear` right after `regenerateSessionId` so the outgoing
 * session's on-disk tool_result files are unlinked instead of waiting for
 * the 30-day time-based cleanup in `src/platform/cleanup.ts`. The session ID
 * is captured by the caller before regeneration; by definition no live
 * code path can still reference these files (the session no longer exists).
 *
 * Best-effort: missing directory is not an error (ENOENT), any other
 * failure is logged but swallowed so `/clear` always completes.
 */
/**
 * Absolute path of the tool-results spill directory for a session. Exported so
 * callers (and tests) target the exact directory unlinkSessionSpillDir deletes
 * instead of re-deriving it — re-deriving is fragile under Bun test mocks,
 * where a leaked getProjectDir/getClaudinConfigHomeDir stub can make an
 * independent computation resolve to a different config root.
 */
export function getSessionSpillDir(sessionId: string): string {
  return join(getProjectDir(getOriginalCwd()), sessionId, TOOL_RESULTS_SUBDIR)
}

export async function unlinkSessionSpillDir(sessionId: string): Promise<void> {
  if (!sessionId) return
  const dir = getSessionSpillDir(sessionId)
  try {
    await rm(dir, { recursive: true, force: true })
    logForDebugging(`Unlinked tool-results spill dir for session ${sessionId}`)
  } catch (error) {
    // force: true already silences ENOENT; anything reaching here is
    // unexpected (EACCES, EBUSY on Windows). Log and move on — /clear
    // must not fail on cleanup noise.
    logError(toError(error))
  }
}

/**
 * Persist a tool result to disk and return information about the persisted file
 *
 * Saved as text, a result's text blocks joined by newlines, so `Read` offsets
 * address the lines the page names (`buildLargeToolResultMessage`).
 *
 * @param content - The tool result content to persist (string or array of content blocks)
 * @param toolUseId - The ID of the tool use that produced the result
 * @returns The saved file's path and size, and the text it holds
 */
export async function persistToolResult(
  content: NonNullable<ToolResultBlockParam['content']>,
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  // Check for non-text content - we can only persist text blocks
  if (Array.isArray(content) && content.some(block => block.type !== 'text')) {
    return {
      error: 'Cannot persist tool results containing non-text content',
    }
  }

  await ensureToolResultsDir()
  const filepath = getToolResultPath(toolUseId, false)
  const contentStr =
    typeof content === 'string'
      ? content
      : content.map(block => (block.type === 'text' ? block.text : '')).join('\n')

  // tool_use_id is unique per invocation and content is deterministic for a
  // given id, so skip if the file already exists. This prevents re-writing
  // the same content on every API turn when microcompact replays the
  // original messages. Use 'wx' instead of a stat-then-write race.
  try {
    await writeFile(filepath, contentStr, { encoding: 'utf-8', flag: 'wx' })
    logForDebugging(
      `Persisted tool result to ${filepath} (${formatFileSize(contentStr.length)})`,
    )
  } catch (error) {
    if (getErrnoCode(error) !== 'EEXIST') {
      logError(toError(error))
      return { error: getFileSystemErrorMessage(toError(error)) }
    }
    // EEXIST: already persisted on a prior turn; the page is built from it all the same
  }

  return { filepath, originalSize: contentStr.length, text: contentStr }
}

/**
 * A result too large for one tool_result: where it is saved, then its first
 * page — whole lines, as many as fit in `maxChars` with this message around
 * them — and the line to Read from for the rest. Nothing is summarized: the
 * page is the result's first lines exactly, and the file holds every line.
 *
 * `text` is what the page is cut from, and its line numbers must be the
 * file's: the whole saved text, or the start of it (a shell run keeps only its
 * first chars in stdout while the file holds all of them). The pointer comes
 * first, so a context-relief stub that keeps the head keeps it too.
 */
export function buildLargeToolResultMessage(
  saved: { filepath: string; originalSize: number },
  text: string,
  maxChars: number,
): string {
  const frame = (pointer: string, page: string) =>
    `${PERSISTED_OUTPUT_TAG}\nOutput too large (${formatFileSize(saved.originalSize)}). Full output saved to: ${saved.filepath}\n${pointer}\n\n${page}\n${PERSISTED_OUTPUT_CLOSING_TAG}`
  // The longest pointer, so the page budget holds whatever the count turns out to be.
  const budget = maxChars - frame(pointerFor(Number.MAX_SAFE_INTEGER, Number.MAX_SAFE_INTEGER), '').length
  const { page, shownLines } = pageForModel(text, Math.max(budget, 0))
  return frame(pointerFor(shownLines, page.length), page)
}

function pointerFor(shownLines: number, pageChars: number): string {
  return shownLines === 0
    ? `Line 1 alone is longer than this page: its first ${pageChars} chars are below; Read the file for the rest.`
    : `Lines 1-${shownLines} are below; Read the file from line ${shownLines + 1} for the rest.`
}

/**
 * The first lines of `text` that fit in `maxChars`, cut at a line boundary,
 * and how many they are. When the first line alone is longer, the page is its
 * head and `shownLines` is 0.
 */
export function pageForModel(text: string, maxChars: number): { page: string; shownLines: number } {
  const cut = text.length <= maxChars ? text.length : text.lastIndexOf('\n', maxChars)
  if (cut <= 0) return { page: text.slice(0, maxChars), shownLines: 0 }
  const page = text.slice(0, cut).replace(/\n$/, '')
  return { page, shownLines: page === '' ? 0 : page.split('\n').length }
}

/**
 * Process a tool result for inclusion in a message.
 * Maps the result to the API format and persists large results to disk.
 */
export async function processToolResultBlock<T>(
  tool: {
    name: string
    maxResultSizeChars: number
    mapToolResultToToolResultBlockParam: (
      result: T,
      toolUseID: string,
    ) => ToolResultBlockParam
    skipsResultSummarizer?: (result: T) => boolean
  },
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlockParam> {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(
    toolUseResult,
    toolUseID,
  )
  return processPreMappedToolResultBlock(toolResultBlock, tool, toolUseResult)
}

/**
 * Process a pre-mapped tool result block. Applies persistence for large results
 * without re-calling mapToolResultToToolResultBlockParam.
 * `toolUseResult` is the output the block was mapped from, for the tool's
 * skipsResultSummarizer.
 */
export async function processPreMappedToolResultBlock<T>(
  toolResultBlock: ToolResultBlockParam,
  tool: {
    name: string
    maxResultSizeChars: number
    skipsResultSummarizer?: (result: T) => boolean
  },
  toolUseResult: T,
): Promise<ToolResultBlockParam> {
  const { name: toolName, maxResultSizeChars } = tool
  const persistenceThreshold = getPersistenceThreshold(maxResultSizeChars)
  const whole = tool.skipsResultSummarizer?.(toolUseResult)
    ? toolResultBlock
    : keepWholeUnderLine(toolResultBlock, toolName, persistenceThreshold)
  if (whole !== null) {
    return maybePersistLargeToolResult(whole, toolName, persistenceThreshold)
  }
  const summarized = maybeSummarizeToolResult(toolResultBlock, toolName)
  const reversible = await makeReversibleIfElided(toolResultBlock, summarized)
  return maybePersistLargeToolResult(reversible, toolName, persistenceThreshold)
}

/**
 * CLAUDIN_TOOL_RESULT_LOSSLESS (on by default; `=0` brings the cuts back): the
 * result regrouped without losing a line, or as it came, when that fits under
 * the persistence line — measured the way persistence measures it. Null past
 * the line, where the summarizer cuts: a summary shows more than the 2 KB
 * preview persistence would leave, and with TOOL_RESULT_JSON_COMPRESSION on
 * (the build's default) its original is saved under `source=`. Exported for
 * the replay census (scripts/bench/tokens/summarizer-lossless-replay.ts).
 */
export function keepWholeUnderLine(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  persistenceThreshold: number,
): ToolResultBlockParam | null {
  if (!isLosslessSummarizerEnabled()) return null
  const compacted = maybeCompactToolResult(toolResultBlock, toolName)
  const content = compacted.content
  return content == null || contentSize(content) <= persistenceThreshold ? compacted : null
}

// --- Reversibility for summarizer elisions (TOOL_RESULT_JSON_COMPRESSION) ---
//
// When the summarizer drops bytes, persist the full original to disk and add a
// quiet `source="<path>"` attribute to the marker so the model can Read/Grep it
// for omitted data — reusing the same persistence mechanism as the >50KB path,
// no new tool. The attribute is deliberately NOT prose: prose elision
// affordances triggered a re-read thrashing loop (see toolResultSummarizer.ts
// design notes + AUTO_OUTLINE_ON_ELISION).

// "Something was dropped" signal. Every cut text strategy is lossy; the
// json-structural strategy is lossy only when it windowed rows or truncated a
// cell, so a fully-shown schema-factor (lossless) skips the disk write. A
// `<tool-result-compacted>` never reaches here: it is no summary.
const ELISION_DROP_RE = /<omitted|…\[\d+b\]/

async function makeReversibleIfElided(
  originalBlock: ToolResultBlockParam,
  summarized: ToolResultBlockParam,
): Promise<ToolResultBlockParam> {
  if (!isToolResultJsonCompressionEnabled() && !isToolResultCodeOutlineEnabled())
    return summarized
  if (summarized === originalBlock) return summarized // no elision happened
  const content = summarized.content
  if (typeof content !== 'string' || !isSummarizedContent(content)) {
    return summarized
  }
  if (!wasLossy(content)) return summarized

  const jsonEnabled = isToolResultJsonCompressionEnabled()
  const isCodeOutline = content.includes('strategy="code-outline"')
  // Scope guard. The JSON-compression flag is the master switch for summarizer
  // reversibility: when on, it backs every lossy strategy (incl. blind bash/
  // grep/glob/webfetch/agent/mcp head-tail). The code-outline flag, on its own,
  // must back ONLY the code-outline strategy — enabling it must not silently
  // start persisting raw backing for unrelated head/tail strategies that were
  // never reversible before.
  if (!jsonEnabled && !isCodeOutline) return summarized

  const originalStr = toOriginalString(originalBlock.content)
  if (originalStr === null) return summarized

  // Code-outline persists the raw source verbatim: the outline's line ranges
  // equal the original line numbers, so Read offset/limit + Grep on the source=
  // path recover any dropped body. For JSON, persist the JSON-lines canonical
  // form (one element per line, aligned to the marker's #N) so Read offset/limit
  // and Grep address elements. Any other lossy text strategy keeps the raw form.
  let body: string
  if (isCodeOutline) {
    body = originalStr
  } else {
    const jc = compressJsonArray(originalStr)
    body = jc ? jc.jsonl : originalStr
  }

  const result = await persistToolResult(body, summarized.tool_use_id)
  if (isPersistError(result)) return summarized

  return {
    ...summarized,
    content: injectEnvelopeAttr(content, 'source', result.filepath),
  }
}

function wasLossy(content: string): boolean {
  if (content.includes('strategy="json-structural"')) {
    return ELISION_DROP_RE.test(content)
  }
  return true
}

function toOriginalString(
  content: ToolResultBlockParam['content'],
): string | null {
  if (typeof content === 'string') return content
  if (!Array.isArray(content)) return null
  return content
    .filter(
      (b): b is { type: 'text'; text: string } =>
        typeof b === 'object' &&
        b !== null &&
        'type' in b &&
        b.type === 'text' &&
        'text' in b &&
        typeof (b as { text?: unknown }).text === 'string',
    )
    .map(b => b.text)
    .join('\n')
}

/** Splice ` key="value"` into the marker's opening tag, before the first `>`. */
export function injectEnvelopeAttr(
  marker: string,
  key: string,
  value: string,
): string {
  const gt = marker.indexOf('>')
  if (gt === -1) return marker
  const escaped = value
    .replace(/&/g, '&amp;')
    .replace(/"/g, '&quot;')
    .replace(/</g, '&lt;')
  return `${marker.slice(0, gt)} ${key}="${escaped}"${marker.slice(gt)}`
}

/**
 * True when a tool_result's content is empty or effectively empty. Covers:
 * undefined/null/'', whitespace-only strings, empty arrays, and arrays whose
 * only blocks are text blocks with empty/whitespace text. Non-text blocks
 * (images, tool_reference) are treated as non-empty.
 */
export function isToolResultContentEmpty(
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

/**
 * Handle large tool results by persisting to disk instead of truncating.
 * Returns the original block if no persistence needed, or a modified block
 * with the content replaced by a reference to the persisted file.
 */
async function maybePersistLargeToolResult(
  toolResultBlock: ToolResultBlockParam,
  toolName: string,
  persistenceThreshold?: number,
): Promise<ToolResultBlockParam> {
  // Check size first before doing any async work - most tool results are small
  const content = toolResultBlock.content

  // inc-4586: Empty tool_result content at the prompt tail causes some models
  // (notably capybara) to emit the \n\nHuman: stop sequence and end their turn
  // with zero output. The server renderer inserts no \n\nAssistant: marker after
  // tool results, so a bare </function_results>\n\n pattern-matches to a turn
  // boundary. Several tools can legitimately produce empty output (silent-success
  // shell commands, MCP servers returning content:[], REPL statements, etc.).
  // Inject a short marker so the model always has something to react to.
  if (isToolResultContentEmpty(content)) {
    return {
      ...toolResultBlock,
      content: `(${toolName} completed with no output)`,
    }
  }
  // Narrow after the emptiness guard — content is non-nullish past this point.
  if (!content) {
    return toolResultBlock
  }

  // Skip persistence for image content blocks - they need to be sent as-is to Claude
  if (hasImageBlock(content)) {
    return toolResultBlock
  }
  // Already a page with its pointer: a shell run saved its own output.
  if (typeof content === 'string' && content.startsWith(PERSISTED_OUTPUT_TAG)) {
    return toolResultBlock
  }

  const size = contentSize(content)

  // Use tool-specific threshold if provided, otherwise fall back to global limit
  const threshold = persistenceThreshold ?? MAX_TOOL_RESULT_BYTES
  if (size <= threshold) {
    return toolResultBlock
  }

  // Persist the entire content as a unit
  const result = await persistToolResult(content, toolResultBlock.tool_use_id)
  if (isPersistError(result)) {
    // If persistence failed, return the original block unchanged
    return toolResultBlock
  }

  const message = buildLargeToolResultMessage(result, result.text, threshold)

  recordBytesSaved(result.originalSize, message.length)


  return { ...toolResultBlock, content: message }
}

/**
 * Type guard to check if persist result is an error
 */
export function isPersistError(
  result: PersistedToolResult | PersistToolResultError,
): result is PersistToolResultError {
  return 'error' in result
}

function hasImageBlock(
  content: NonNullable<ToolResultBlockParam['content']>,
): boolean {
  return (
    Array.isArray(content) &&
    content.some(
      b => typeof b === 'object' && 'type' in b && b.type === 'image',
    )
  )
}

function contentSize(
  content: NonNullable<ToolResultBlockParam['content']>,
): number {
  if (typeof content === 'string') return content.length
  // Sum text-block lengths directly. Slightly under-counts vs serialized
  // (no JSON framing), which is close enough for a size threshold and
  // avoids allocating a content-sized string per result.
  return content.reduce(
    (sum, b) => sum + (b.type === 'text' ? b.text.length : 0),
    0,
  )
}

/**
 * Get a human-readable error message from a filesystem error
 */
function getFileSystemErrorMessage(error: Error): string {
  // Node.js filesystem errors have a 'code' property
  // eslint-disable-next-line no-restricted-syntax -- uses .path, not just .code
  const nodeError = error as NodeJS.ErrnoException
  if (nodeError.code) {
    switch (nodeError.code) {
      case 'ENOENT':
        return `Directory not found: ${nodeError.path ?? 'unknown path'}`
      case 'EACCES':
        return `Permission denied: ${nodeError.path ?? 'unknown path'}`
      case 'ENOSPC':
        return 'No space left on device'
      case 'EROFS':
        return 'Read-only file system'
      case 'EMFILE':
        return 'Too many open files'
      case 'EEXIST':
        return `File already exists: ${nodeError.path ?? 'unknown path'}`
      default:
        return `${nodeError.code}: ${nodeError.message}`
    }
  }
  return error.message
}

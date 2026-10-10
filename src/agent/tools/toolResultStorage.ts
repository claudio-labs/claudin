/**
 * Utility for persisting large tool results to disk instead of truncating them.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { createHash } from 'crypto'
import { closeSync, openSync, readSync } from 'fs'
import { mkdir, rm, writeFile } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd, getSessionId } from 'src/platform/bootstrap/state.js'
import {
  BYTES_PER_TOKEN,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
} from 'src/tools/constants/toolLimits.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getErrnoCode, toError } from 'src/shared/errors.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { logError } from 'src/shared/log.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { maybeCompactToolResult } from 'src/agent/tools/toolResultCompaction.js'
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
export function getToolResultPath(id: string): string {
  return join(getToolResultsDir(), `${id}.txt`)
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
  const contentStr =
    typeof content === 'string'
      ? content
      : content.map(block => (block.type === 'text' ? block.text : '')).join('\n')
  // The content's hash is in the name: a tool_use_id can repeat (a provider's
  // per-process `xml_tc_N` counter across a resume, an MCP timestamp id), and a
  // reused file would hold another result than the page cut from this one.
  const hash = createHash('sha256').update(contentStr).digest('hex').slice(0, 12)
  const filepath = getToolResultPath(`${toolUseId}-${hash}`)

  // The same id and bytes name the same file, so skip a file that exists: it
  // keeps a replay from rewriting it every turn. 'wx' rather than a
  // stat-then-write race.
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
    // EEXIST: these very bytes, saved on a prior turn.
  }

  return { filepath, originalSize: contentStr.length, text: contentStr }
}

/**
 * A result too large for one tool_result: where it is saved, then its first
 * page — whole lines, as many as fit in `maxChars` with this message around
 * them — and the line to Read from for the rest. Nothing is summarized: the
 * page is the result's first lines exactly, and the file holds every line.
 *
 * `text` is what the page is cut from, and its line numbers are the file's:
 * the whole saved text (`complete`), or the file's own head, whose last line
 * may be cut short and is then not shown. The pointer comes first, so a
 * context-relief stub that keeps the head keeps it too.
 */
export function buildLargeToolResultMessage(
  saved: { filepath: string; originalSize: number },
  text: string,
  maxChars: number,
  complete = true,
): string {
  const frame = (pointer: string, page: string) =>
    `${PERSISTED_OUTPUT_TAG}\nOutput too large (${formatFileSize(saved.originalSize)}). Full output saved to: ${saved.filepath}\n${pointer}\n\n${page}\n${PERSISTED_OUTPUT_CLOSING_TAG}`
  // The longest pointer of either form, so the page budget holds whatever the count turns out to be.
  const longest = Math.max(pointerFor(Number.MAX_SAFE_INTEGER, 0).length, pointerFor(0, Number.MAX_SAFE_INTEGER).length)
  const budget = maxChars - frame('', '').length - longest
  const { page, shownLines } = pageForModel(text, Math.max(budget, 0), complete)
  return frame(pointerFor(shownLines, page.length), page)
}

function pointerFor(shownLines: number, pageChars: number): string {
  return shownLines === 0
    ? `Line 1 alone is longer than this page: its first ${pageChars} chars are below. Read cannot split a line; fetch the rest with Bash, from character ${pageChars + 1}.`
    : `Lines 1-${shownLines} are below; Read the file with offset=${shownLines + 1} and limit=${shownLines} for the next page.`
}

/**
 * The first whole lines of `text` that fit in `maxChars`, and how many they
 * are. Unless `complete`, `text` is the head of something longer, so its last
 * line may be cut short and is never shown. When the first line alone is
 * longer than `maxChars`, the page is its head and `shownLines` is 0.
 */
export function pageForModel(
  text: string,
  maxChars: number,
  complete = true,
): { page: string; shownLines: number } {
  if (complete && text.length <= maxChars) {
    const page = text.replace(/\n$/, '')
    return { page, shownLines: page.split('\n').length }
  }
  // The newline that ends the last whole line within the budget.
  const cut = text.lastIndexOf('\n', Math.min(maxChars, text.length))
  if (cut < 0) {
    // Never end on half of a surrogate pair, nor on a byte decoded short.
    let end = Math.min(maxChars, text.length)
    if (end > 0 && /[\uD800-\uDBFF]/.test(text[end - 1]!)) end--
    return { page: text.slice(0, end).replace(/\uFFFD+$/, ''), shownLines: 0 }
  }
  const page = text.slice(0, cut)
  return { page, shownLines: page.split('\n').length }
}

/**
 * The first `maxBytes` of a saved file as text: what a shell run that spilled
 * pages from, so its line numbers are the file's whatever its stdout went
 * through. Null when the file cannot be read.
 */
export function readSavedHead(filepath: string, maxBytes: number): string | null {
  let fd: number | undefined
  try {
    fd = openSync(filepath, 'r')
    const buffer = Buffer.alloc(maxBytes)
    const read = readSync(fd, buffer, 0, maxBytes, 0)
    return new TextDecoder().decode(buffer.subarray(0, read))
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * Process a tool result for inclusion in a message.
 * Maps the result to the API format, compacts it, and pages it past the line.
 */
export async function processToolResultBlock<T>(
  tool: {
    name: string
    maxResultSizeChars: number
    mapToolResultToToolResultBlockParam: (
      result: T,
      toolUseID: string,
    ) => ToolResultBlockParam
  },
  toolUseResult: T,
  toolUseID: string,
): Promise<ToolResultBlockParam> {
  const toolResultBlock = tool.mapToolResultToToolResultBlockParam(
    toolUseResult,
    toolUseID,
  )
  return processPreMappedToolResultBlock(toolResultBlock, tool)
}

/**
 * Process a pre-mapped tool result block. Nothing is cut: a Grep or Glob
 * result is regrouped without losing a line, and a result still past its
 * tool's persistence line is saved whole and paged — its first lines and the
 * line to Read from for the rest (`buildLargeToolResultMessage`).
 */
export async function processPreMappedToolResultBlock(
  toolResultBlock: ToolResultBlockParam,
  tool: { name: string; maxResultSizeChars: number },
): Promise<ToolResultBlockParam> {
  const { name: toolName, maxResultSizeChars } = tool
  const compacted = maybeCompactToolResult(toolResultBlock, toolName)
  return maybePersistLargeToolResult(compacted, toolName, getPersistenceThreshold(maxResultSizeChars))
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
  threshold: number,
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

  const size = contentSize(content)
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

/**
 * Utility for persisting large tool results to disk instead of truncating them.
 */

import type { ToolResultBlockParam } from '@anthropic-ai/sdk/resources/index.mjs'
import { closeSync, createReadStream, fstatSync, openSync, readSync } from 'fs'
import { copyFile, link, mkdir, rm, stat, truncate } from 'fs/promises'
import { join } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import {
  BYTES_PER_TOKEN,
  DEFAULT_MAX_RESULT_SIZE_CHARS,
} from 'src/tools/constants/toolLimits.js'
import { logForDebugging } from 'src/shared/debug.js'
import { toError } from 'src/shared/errors.js'
import { formatFileSize } from 'src/shared/text/format.js'
import { logError } from 'src/shared/log.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { maybeCompactToolResult } from 'src/agent/tools/toolResultCompaction.js'
import { recordBytesSaved } from 'src/agent/context/tokensSaved.js'
import {
  getToolResultsDir,
  PERSISTED_OUTPUT_CLOSING_TAG,
  PERSISTED_OUTPUT_TAG,
  resultDirs,
  resultFileName,
  resultText,
  SAVE_WHOLE_FROM_CHARS,
  TOOL_RESULTS_SUBDIR,
  writeResultFile,
} from 'src/agent/tools/toolResultFiles.js'

export {
  getToolResultPath,
  getToolResultsDir,
  PERSISTED_OUTPUT_CLOSING_TAG,
  PERSISTED_OUTPUT_TAG,
  TOOL_RESULTS_SUBDIR,
} from 'src/agent/tools/toolResultFiles.js'

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

/** A saved result, as its page describes it. */
export type SavedOutput = {
  filepath: string
  /** The result's size; fewer bytes may have been kept (`savedBytes`). */
  originalSize: number
  /** Set when only part of it could be kept: a shell run past MAX_SAVED_OUTPUT_BYTES. */
  savedBytes?: number
  /** The saved file's line count, for the pointer. Unknown on an old transcript. */
  lines?: number
}

// Error result when persistence fails
export type PersistToolResultError = {
  error: string
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
 * address the lines the page names (`buildLargeToolResultMessage`), in the
 * session's results directory or, when that cannot be written, a fallback
 * under the OS temp dir (`writeResultFile`).
 *
 * @param content - The tool result content to persist (string or array of content blocks)
 * @param toolUseId - The ID of the tool use that produced the result
 * @returns The saved file's path and size, and the text it holds
 */
export async function persistToolResult(
  content: NonNullable<ToolResultBlockParam['content']>,
  toolUseId: string,
): Promise<PersistedToolResult | PersistToolResultError> {
  // Only text can be saved and paged.
  const text = resultText(content)
  if (text === undefined) {
    return {
      error: 'Cannot persist tool results containing non-text content',
    }
  }
  const written = await writeResultFile(resultFileName(toolUseId, text), text)
  if ('error' in written) {
    const error = toError(written.error)
    logError(error)
    return { error: getFileSystemErrorMessage(error) }
  }
  logForDebugging(`Persisted tool result to ${written.path} (${formatFileSize(text.length)})`)
  return { filepath: written.path, originalSize: text.length, text }
}

/**
 * A result too large for one tool_result: where it is saved, then its first
 * page — whole lines, as many as fit in `maxChars` with this message around
 * them — and the Read call for the next page, with the file's line count so
 * the model can go straight to its end, where a failing run says what failed.
 * Nothing is summarized: the page is the result's first lines exactly, and the
 * file holds every line (or, past MAX_SAVED_OUTPUT_BYTES, says how much).
 *
 * `text` is what the page is cut from, and its line numbers are the file's:
 * the whole saved text (`complete`), or the file's own head, whose last line
 * may be cut short and is then not shown. The pointer comes first, so a
 * context-relief stub that keeps the head keeps it too.
 */
export function buildLargeToolResultMessage(
  saved: SavedOutput,
  text: string,
  maxChars: number,
  { complete = true }: { complete?: boolean } = {},
): string {
  const size = formatFileSize(saved.originalSize)
  const where =
    saved.savedBytes !== undefined && saved.savedBytes < saved.originalSize
      ? `Output too large (${size}); only its first ${formatFileSize(saved.savedBytes)} is saved, to: ${saved.filepath}`
      : `Output too large (${size}). Full output saved to: ${saved.filepath}`
  const frame = (pointer: string, page: string) =>
    `${PERSISTED_OUTPUT_TAG}\n${where}\n${pointer}\n\n${page}\n${PERSISTED_OUTPUT_CLOSING_TAG}`
  const total = complete ? lineCount(text) : saved.lines
  // The longest pointer of either form, so the page budget holds whatever the count turns out to be.
  const most = Number.MAX_SAFE_INTEGER
  const longest = Math.max(
    pointerFor(most, most, 0, 0, saved.filepath).length,
    pointerFor(0, most, most, most, saved.filepath).length,
  )
  const budget = maxChars - frame('', '').length - longest
  const { page, shownLines } = pageForModel(text, Math.max(budget, 0), complete)
  return frame(pointerFor(shownLines, total, page.length, Buffer.byteLength(page), saved.filepath), page)
}

/**
 * What the page says about the rest. A line longer than the page is fetched
 * by byte offset, the unit `tail -c` counts in.
 */
function pointerFor(
  shownLines: number,
  totalLines: number | undefined,
  pageChars: number,
  pageBytes: number,
  filepath: string,
): string {
  if (shownLines === 0) {
    return `Line 1 alone is longer than this page: its first ${pageChars} chars (${pageBytes} bytes) are below. Read cannot split a line; fetch the rest with Bash: tail -c +${pageBytes + 1} '${filepath.replaceAll("'", `'\\''`)}' | head -c 100000`
  }
  if (totalLines !== undefined && shownLines >= totalLines) return `All ${totalLines} lines are below.`
  const of = totalLines === undefined ? '' : ` of ${totalLines}`
  return `Lines 1-${shownLines}${of} are below; Read the file with offset=${shownLines + 1} and limit=${shownLines} for the next page.`
}

/** The number of lines in `text` as Read numbers them: a final newline opens no line. */
export function lineCount(text: string): number {
  return text === '' ? 0 : text.replace(/\n$/, '').split('\n').length
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
 * The first `maxBytes` of a saved file as text, whether that was all of it,
 * and the file's size. Null when the file cannot be read.
 */
function readSavedHead(
  filepath: string,
  maxBytes: number,
): { text: string; whole: boolean; fileBytes: number } | null {
  let fd: number | undefined
  try {
    fd = openSync(filepath, 'r')
    const fileBytes = fstatSync(fd).size
    const buffer = Buffer.alloc(Math.min(maxBytes, fileBytes))
    const read = readSync(fd, buffer, 0, buffer.length, 0)
    return { text: new TextDecoder().decode(buffer.subarray(0, read)), whole: read >= fileBytes, fileBytes }
  } catch {
    return null
  } finally {
    if (fd !== undefined) closeSync(fd)
  }
}

/**
 * The smallest page a saved file is given. When what goes around it leaves
 * less room, the whole result passes its line and is paged in turn by storage
 * — nothing is cut, where a page of 0 chars would name a line it never shows.
 */
export const MIN_PAGE_CHARS = 4_000

/**
 * The page of a file already saved — a shell run's spilled output — cut from
 * the file's own head, so its line numbers are the file's whatever the
 * in-memory text went through (the output filter, a blank-line strip, a byte
 * cap ending mid-line). `fallback` stands in when the file cannot be read.
 */
export function pageSavedFile(
  saved: Omit<SavedOutput, 'originalSize'> & { originalSize?: number },
  maxChars: number,
  fallback: string,
): string {
  const budget = Math.max(maxChars, MIN_PAGE_CHARS)
  const head = readSavedHead(saved.filepath, budget)
  const originalSize = saved.originalSize ?? head?.fileBytes ?? fallback.length
  return buildLargeToolResultMessage({ ...saved, originalSize }, head?.text ?? fallback, budget, {
    complete: head?.whole ?? false,
  })
}

/** The most of an output file kept for the model to page through. */
export const MAX_SAVED_OUTPUT_BYTES = 64 * 1024 * 1024

/**
 * Save an output file its producer already wrote — a shell run past what it
 * keeps in memory — where its page will point: linked into the results
 * directory, copied when a link cannot be made, and left where it is when
 * neither can, since it is on disk all the same. Past `maxBytes` it is
 * truncated first, and `savedBytes` lets the page say so. Undefined when the
 * file is gone.
 */
export async function adoptOutputFile(
  sourcePath: string,
  id: string,
  maxBytes = MAX_SAVED_OUTPUT_BYTES,
): Promise<SavedOutput | undefined> {
  let originalSize: number
  try {
    originalSize = (await stat(sourcePath)).size
  } catch {
    return undefined
  }
  if (originalSize > maxBytes) {
    try {
      await truncate(sourcePath, maxBytes)
    } catch {
      // Kept whole, then; the size read below says so.
    }
  }
  const filepath = (await linkIntoResults(sourcePath, `${id}.txt`)) ?? sourcePath
  let savedBytes = originalSize
  try {
    savedBytes = (await stat(filepath)).size
  } catch {
    // The file was there a moment ago; its size stays the one read first.
  }
  return { filepath, originalSize, savedBytes, lines: await countLines(filepath) }
}

async function linkIntoResults(sourcePath: string, name: string): Promise<string | undefined> {
  for (const dir of resultDirs()) {
    const dest = join(dir, name)
    try {
      await mkdir(dir, { recursive: true })
      try {
        await link(sourcePath, dest)
      } catch {
        await copyFile(sourcePath, dest)
      }
      return dest
    } catch {
      // The next directory, then.
    }
  }
  return undefined
}

/** The lines in a file, as `lineCount` numbers them. Undefined when it cannot be read. */
async function countLines(filepath: string): Promise<number | undefined> {
  try {
    let newlines = 0
    let last: number | undefined
    for await (const chunk of createReadStream(filepath)) {
      const buf = chunk as Buffer
      for (let i = buf.indexOf(0x0a); i !== -1; i = buf.indexOf(0x0a, i + 1)) newlines++
      if (buf.length > 0) last = buf[buf.length - 1]
    }
    return last === undefined || last === 0x0a ? newlines : newlines + 1
  } catch {
    return undefined
  }
}

/**
 * A result past its line that could be saved nowhere: its first page, and
 * how to see the rest. The one place something is left out, and it says so —
 * the whole result could fill the context window.
 */
export function pageUnsaved(text: string, maxChars: number, reason: string): string {
  const total = lineCount(text)
  const pointer = (shown: number) =>
    shown === 0
      ? 'Line 1 alone is longer than this page; only its head is below.'
      : `Lines 1-${shown} of ${total} are below.`
  const frame = (p: string, page: string) =>
    `${PERSISTED_OUTPUT_TAG}\nOutput too large (${formatFileSize(text.length)}), and it could not be saved (${reason}).\n${p} The rest could not be kept: narrow the call (a range, a filter, a smaller limit) to see it.\n\n${page}\n${PERSISTED_OUTPUT_CLOSING_TAG}`
  const longest = Math.max(pointer(0).length, pointer(Number.MAX_SAFE_INTEGER).length)
  const budget = maxChars - frame('', '').length - longest
  const { page, shownLines } = pageForModel(text, Math.max(budget, 0))
  return frame(pointer(shownLines), page)
}

/**
 * A tool's error text: whole while it fits under the tool's line, and paged
 * past it like any result — nothing in it is cut. Saved by its content alone,
 * so a failure repeated word for word names the same file and reads the same.
 */
export async function pageErrorText(text: string, threshold: number): Promise<string> {
  if (text.length <= threshold) return text
  const saved = await persistToolResult(text, 'error')
  if (isPersistError(saved)) return pageUnsaved(text, threshold, saved.error)
  return buildLargeToolResultMessage(saved, saved.text, threshold)
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
    // Saved all the same from SAVE_WHOLE_FROM_CHARS, so a context-relief clip
    // of it can name the copy (`savedCopyOf`) instead of the model running
    // the call again. Read is never saved: it bounds itself (Infinity), and
    // its file is right where it read it.
    if (size >= SAVE_WHOLE_FROM_CHARS && Number.isFinite(threshold)) {
      await persistToolResult(content, toolResultBlock.tool_use_id)
    }
    return toolResultBlock
  }

  // Persist the entire content as a unit
  const result = await persistToolResult(content, toolResultBlock.tool_use_id)
  if (isPersistError(result)) {
    // Saved nowhere. Text is paged all the same, without its file; blocks
    // that are not text cannot be paged and ship as they came.
    const text = resultText(content)
    return text === undefined
      ? toolResultBlock
      : { ...toolResultBlock, content: pageUnsaved(text, threshold, result.error) }
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

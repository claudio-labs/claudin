/**
 * The batch Read (CLAUDIN_READ_MULTI, readMulti.ts): several files — or
 * several symbols of one — answered in one tool_result.
 *
 * It is a loop over the single-file Read, never a second implementation of
 * it. Each file and symbol goes through FileReadTool's own call() exactly as a
 * Read of it would — dedup stub, clip-pin stand-down, auto-pivot, outline,
 * symbol — so readFileState, the nested_memory triggers and the
 * read-before-edit gate see one ordinary Read per file. What the batch adds
 * sits around that call:
 *
 * - One budget for the whole result: the tokens one Read may return
 *   (limits.ts, 25k). A file that does not fit is named at the end and its
 *   read rolled back, because a file the model was not shown must not count
 *   as read.
 * - One header per file, then the text a Read of that file returns, rendered
 *   by the same mapper (resultContent.ts) — the budget is measured on those
 *   bytes.
 * - Missing symbols on one line. Images, PDFs and notebooks, whose results are
 *   blocks rather than text, are sent back to a Read of their own.
 * - No result cache and no clip pin: cache freshness and the pin both key on
 *   the tool_use id, which every file of a batch shares (toolResultCache.ts
 *   checks one path; a pin shields the whole block).
 */
import * as path from 'path'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import type { HookEvent } from 'src/platform/entrypoints/agentSdkTypes.js'
import { hasHookForTool } from 'src/platform/lifecycleHooks/matching.js'
import { isAbortError } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import type { FileState } from 'src/shared/fs/fileStateCache.js'
import { expandPath } from 'src/shared/fs/path.js'
import { isPDFExtension } from 'src/shared/fs/pdfUtils.js'
import { logError } from 'src/shared/log.js'
import { roughTokenCountEstimationForFileType } from 'src/shared/tokenEstimation.js'
import type { ToolResult, ToolUseContext, ValidationResult } from 'src/tools/Tool.js'
import { IMAGE_EXTENSIONS } from 'src/tools/FileReadTool/guards.js'
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js'
import { FILE_READ_TOOL_NAME } from 'src/tools/FileReadTool/prompt.js'
import { SymbolNotFoundError } from 'src/tools/FileReadTool/readDispatch.js'
import { readPathsOf, symbolsOf } from 'src/tools/FileReadTool/readMulti.js'
import {
  mapReadResultToToolResultBlock,
  releaseReadReminder,
} from 'src/tools/FileReadTool/resultContent.js'
import type {
  BatchOutput,
  Input,
  Output,
  SingleInput,
} from 'src/tools/FileReadTool/schemas.js'

/** One Read of one file and at most one symbol: FileReadTool's own call(). */
type ReadOneFile = (
  input: SingleInput,
  fileContext: ToolUseContext,
) => Promise<ToolResult<Output>>

type NewMessages = NonNullable<ToolResult<Output>['newMessages']>

/**
 * The contexts the files of a batch are read under — a copy of the call's,
 * so the single-file path can tell a batch file from a Read of its own: it
 * skips the result cache and never pins (FileReadTool.ts). A copy rather than
 * the call's context itself, which a concurrent single Read may share.
 */
const batchFileContexts = new WeakSet<ToolUseContext>()

export function isBatchFileContext(context: ToolUseContext): boolean {
  return batchFileContexts.has(context)
}

const READ_HOOK_EVENTS: readonly HookEvent[] = ['PreToolUse', 'PostToolUse']

export const READ_HOOK_REFUSAL =
  'Batch Read is off while a Read hook is configured — read one file per call.'

/**
 * Hooks match a Read on `tool_input.file_path` (the tool's
 * preparePermissionMatcher), and a batch carries `file_paths` instead, so a
 * hook that allows or blocks by path would silently miss every file in it.
 * Until hooks are evaluated per file, a configured PreToolUse/PostToolUse
 * hook for Read turns the batch off. Fails closed: when the question cannot
 * be answered, one file per call is what every hook can see.
 */
export function readHookWouldMissBatch(context: ToolUseContext): boolean {
  try {
    return hasHookForTool(
      FILE_READ_TOOL_NAME,
      READ_HOOK_EVENTS,
      context.getAppState(),
      context.agentId ?? getSessionId(),
    )
  } catch (e) {
    logError(e)
    return true
  }
}

/**
 * validateInput for a `file_paths` Read: each path gets exactly the checks a
 * Read of it would (`validateOne` is the tool's own validateInput), and any
 * failure refuses the call, naming the path.
 */
export async function validateBatchPaths(
  paths: readonly string[],
  validateOne: (filePath: string) => Promise<ValidationResult>,
): Promise<ValidationResult> {
  const cwd = getCwd()
  const failures: { message: string; errorCode: number }[] = []
  for (const filePath of paths) {
    const result = await validateOne(filePath)
    if (result.result === false) {
      failures.push({
        message: `${displayPath(expandPath(filePath), cwd)}: ${result.message}`,
        errorCode: result.errorCode,
      })
    }
  }
  const [first] = failures
  if (!first) return { result: true }
  return {
    result: false,
    message: failures.map(f => f.message).join('\n'),
    errorCode: first.errorCode,
  }
}

type Section = { text: string; data?: Output }

type ReadStateSnapshot = {
  entry: FileState | undefined
  triggered: boolean
}

export async function readBatch(
  input: Input,
  context: ToolUseContext,
  readOne: ReadOneFile,
): Promise<ToolResult<Output>> {
  const maxTokens =
    context.fileReadingLimits?.maxTokens ??
    getDefaultFileReadingLimits().maxTokens
  const fileContext: ToolUseContext = { ...context }
  batchFileContexts.add(fileContext)
  const symbols = symbolsOf(input)
  const cwd = getCwd()

  const blocks: string[] = []
  const files: BatchOutput['files'] = []
  const missing: string[] = []
  const ownRead: string[] = []
  const notShown: string[] = []
  const newMessages: NewMessages = []
  let spent = 0

  for (const filePath of distinctPaths(readPathsOf(input))) {
    const fullFilePath = expandPath(filePath)
    const label = displayPath(fullFilePath, cwd)
    const ext = path.extname(fullFilePath).toLowerCase().slice(1)
    if (readsAsBlocks(ext)) {
      ownRead.push(label)
      continue
    }
    const before = snapshotReadState(context, fullFilePath)
    const read = await readSections(
      { ...input, file_path: filePath },
      fullFilePath,
      symbols,
      fileContext,
      readOne,
      before.entry,
    )
    for (const symbol of read.missing) missing.push(`${symbol} in ${label}`)
    if (read.sections.length === 0) continue

    const block = `==> ${label} <==\n${read.sections.map(s => s.text).join('\n\n')}`
    const tokens = roughTokenCountEstimationForFileType(block, ext)
    if (spent + tokens > maxTokens) {
      rollBack(context, fullFilePath, before, read.sections)
      notShown.push(label)
      continue
    }
    spent += tokens
    blocks.push(block)
    files.push({ filePath: fullFilePath, lines: shownLines(read.sections) })
    newMessages.push(...read.newMessages)
  }

  const notes = [
    missing.length > 0 ? `Symbol not found: ${missing.join(', ')}.` : '',
    ownRead.length > 0
      ? `Not read — images, PDFs and notebooks need a Read of their own: ${ownRead.join(', ')}.`
      : '',
    notShown.length > 0
      ? `Not shown — over the ${Math.round(maxTokens / 1000)}k tokens one Read returns: ${notShown.join(', ')}. Read them in another call.`
      : '',
  ].filter(note => note !== '')
  const content = [...blocks, ...(notes.length > 0 ? [notes.join('\n')] : [])].join(
    '\n\n',
  )
  return {
    data: { type: 'batch', files, notShown, content },
    ...(newMessages.length > 0 && { newMessages }),
    noResultCache: true,
  }
}

/**
 * One file's sections: its whole-file Read, or one per symbol. A symbol read
 * that finds nothing to expand falls back to the whole body (a file with no
 * outline language, or no symbols), and the same body is not repeated.
 */
async function readSections(
  input: Input & { file_path: string },
  fullFilePath: string,
  symbols: readonly string[],
  fileContext: ToolUseContext,
  readOne: ReadOneFile,
  before: FileState | undefined,
): Promise<{ sections: Section[]; missing: string[]; newMessages: NewMessages }> {
  const { readFileState } = fileContext
  const sections: Section[] = []
  const missing: string[] = []
  const newMessages: NewMessages = []
  const shownBodies: FileState[] = []
  let leftPartialView = false

  for (const symbol of symbols.length > 0 ? symbols : [undefined]) {
    const one: SingleInput = {
      file_path: input.file_path,
      ...(input.view !== undefined && { view: input.view }),
      ...(symbol !== undefined && { symbol }),
      ...(input.encoding !== undefined && { encoding: input.encoding }),
    }
    let result: ToolResult<Output>
    try {
      result = await readOne(one, fileContext)
    } catch (e) {
      if (isAbortError(e)) throw e
      if (e instanceof SymbolNotFoundError) {
        missing.push(e.symbol)
        continue
      }
      sections.push({ text: e instanceof Error ? e.message : String(e) })
      continue
    }
    const entry = readFileState.get(fullFilePath)
    if (entry?.isPartialView) {
      leftPartialView = true
    } else if (symbol !== undefined && result.data.type === 'text' && entry) {
      shownBodies.push(entry)
    }
    const text = sectionText(result.data)
    if (sections.some(section => section.text === text)) continue
    sections.push({ text, data: result.data })
    newMessages.push(...(result.newMessages ?? []))
  }

  if (leftPartialView && shownBodies.length > 0) {
    keepEveryShownBody(fileContext, fullFilePath, before, shownBodies)
  }
  return { sections, missing, newMessages }
}

/**
 * A symbol too large to send whole comes back as its own outline, and that
 * writes a partial-view entry (outlineView.ts, makeSymbolOutlineData). For a
 * one-symbol Read that is right. Inside a symbol list it would erase the
 * bodies the list's other symbols registered — set() carries nothing across a
 * partial view (fileStateCache.ts, carrySeenRanges) — and an Edit inside a
 * body the model was shown in this very result would be refused. So rebuild
 * the entry from what the file had before this call plus every body the list
 * showed, in order: each set() carries the one before it into seenRanges.
 */
function keepEveryShownBody(
  context: ToolUseContext,
  fullFilePath: string,
  before: FileState | undefined,
  bodies: readonly FileState[],
): void {
  const { readFileState } = context
  readFileState.delete(fullFilePath)
  if (before) readFileState.set(fullFilePath, before)
  for (const body of bodies) {
    readFileState.set(fullFilePath, { ...body, seenRanges: undefined })
  }
}

function snapshotReadState(
  context: ToolUseContext,
  fullFilePath: string,
): ReadStateSnapshot {
  return {
    entry: context.readFileState.get(fullFilePath),
    triggered: context.nestedMemoryAttachmentTriggers?.has(fullFilePath) ?? false,
  }
}

/**
 * A file read but left out for the budget was never shown, so nothing may
 * vouch that it was: the entry its read replaced goes back, the nested_memory
 * trigger it added comes out, and the mitigation reminder it may have taken
 * is handed back for the next file.
 */
function rollBack(
  context: ToolUseContext,
  fullFilePath: string,
  before: ReadStateSnapshot,
  sections: readonly Section[],
): void {
  const { readFileState } = context
  readFileState.delete(fullFilePath)
  if (before.entry) readFileState.set(fullFilePath, before.entry)
  if (!before.triggered) {
    context.nestedMemoryAttachmentTriggers?.delete(fullFilePath)
  }
  for (const section of sections) releaseReadReminder(section.data, context)
}

const NOT_TEXT_NOTE = 'This file did not come back as text — Read it on its own.'

/** The text a Read of this one file puts in its tool_result. */
function sectionText(data: Output): string {
  const { content } = mapReadResultToToolResultBlock(data, '')
  if (typeof content === 'string') return content
  // Only images, PDFs and notebooks come back as blocks, and readsAsBlocks
  // sends those to their own Read before they get here.
  logError(new Error(`batch Read: a ${data.type} result is not text`))
  return NOT_TEXT_NOTE
}

/** Kinds whose Read result is blocks, not text: they cannot sit under a header. */
function readsAsBlocks(ext: string): boolean {
  return ext === 'ipynb' || IMAGE_EXTENSIONS.has(ext) || isPDFExtension(ext)
}

function shownLines(sections: readonly Section[]): number {
  let lines = 0
  for (const { data } of sections) {
    if (data?.type === 'text') lines += data.file.numLines
  }
  return lines
}

/** A path named twice is read once — the second Read would dedup against the first. */
function distinctPaths(paths: readonly string[]): string[] {
  const seen = new Set<string>()
  return paths.filter(p => {
    const key = expandPath(p)
    if (seen.has(key)) return false
    seen.add(key)
    return true
  })
}

/**
 * How a header and the notes name a file: relative inside the working
 * directory, absolute outside it — never a `../` chain.
 */
function displayPath(fullFilePath: string, cwd: string): string {
  const relative = path.relative(cwd, fullFilePath)
  const outside =
    relative === '' ||
    relative === '..' ||
    relative.startsWith(`..${path.sep}`) ||
    path.isAbsolute(relative)
  return outside ? fullFilePath : relative
}

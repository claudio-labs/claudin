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
 * - To hooks, the batch is those single Reads (batchHookUnits, Tool.hookUnits):
 *   each file and symbol gets the PreToolUse, PermissionRequest, PostToolUse
 *   and PostToolUseFailure runs a Read of it would, and no hook ever sees
 *   `file_paths`. The per-Read results PostToolUse needs ride back on the
 *   ToolResult (`unitResults`).
 */
import * as path from 'path'
import { isAbortError } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import type { FileState } from 'src/shared/fs/fileStateCache.js'
import { expandPath } from 'src/shared/fs/path.js'
import { isPDFExtension } from 'src/shared/fs/pdfUtils.js'
import { logError } from 'src/shared/log.js'
import { roughTokenCountEstimationForFileType } from 'src/shared/tokenEstimation.js'
import type {
  HookUnitResult,
  HookUnits,
  ToolResult,
  ToolUseContext,
  ValidationResult,
} from 'src/tools/Tool.js'
import { IMAGE_EXTENSIONS } from 'src/tools/FileReadTool/guards.js'
import { getDefaultFileReadingLimits } from 'src/tools/FileReadTool/limits.js'
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

/**
 * The single Reads a batch input stands for, in the order the batch makes
 * them: each distinct file it reads as text, once per symbol — once when it
 * names none. Images, PDFs and notebooks are not among them; the batch sends
 * those to a Read of their own.
 */
function batchReadUnits(input: Input): SingleInput[] {
  const symbols = symbolsOf(input)
  const units: SingleInput[] = []
  for (const filePath of distinctPaths(readPathsOf(input))) {
    if (readsAsBlocks(extensionOf(expandPath(filePath)))) continue
    for (const symbol of symbols.length > 0 ? symbols : [undefined]) {
      units.push(unitInput(input, filePath, symbol))
    }
  }
  return units
}

/** The one Read of one file, and at most one symbol, that a batch makes. */
function unitInput(input: Input, filePath: string, symbol: string | undefined): SingleInput {
  return {
    file_path: filePath,
    ...(input.view !== undefined && { view: input.view }),
    ...(symbol !== undefined && { symbol }),
    ...(input.encoding !== undefined && { encoding: input.encoding }),
  }
}

/**
 * The batch as hooks see it (Tool.hookUnits): one unit per single Read it
 * makes, each backfilled the way that Read's own input would be.
 *
 * `merge` folds the hooks' updatedInput back into a batch input. A unit's
 * file may be rewritten, and every unit may change alike; what a batch cannot
 * carry is a change for one unit alone — its own view, a symbol of its own, a
 * range — so that is refused, naming the file, which a Read of its own then
 * reads with the hook's change as always. Whatever the fold proposes is
 * checked by running it back through batchReadUnits: the merge stands only
 * if the batch it makes would read exactly the units the hooks asked for.
 */
export function batchHookUnits(
  input: Input,
  backfill: (unit: Record<string, unknown>) => void,
  cwd: string = getCwd(),
): HookUnits {
  const units = batchReadUnits(input)
  const inputs = units.map(unit => {
    const observed: Record<string, unknown> = { ...unit }
    backfill(observed)
    return observed
  })
  const label = (index: number): string => {
    const unit = units[index]
    if (!unit) return ''
    const where = displayPath(expandPath(unit.file_path), cwd)
    return unit.symbol === undefined ? where : `${where} (symbol ${unit.symbol})`
  }
  return {
    inputs,
    label,
    merge: updated => mergeUnitUpdates(input, units, inputs, updated, label),
  }
}

function mergeUnitUpdates(
  input: Input,
  units: readonly SingleInput[],
  observed: readonly Record<string, unknown>[],
  updated: readonly (Record<string, unknown> | undefined)[],
  label: (index: number) => string,
): { input: Record<string, unknown> } | { refusal: string } {
  // Each unit as the hooks want it read. A path a hook handed back unchanged
  // goes back the way the call named it, as a single Read's does
  // (toolExecution.ts), rather than in its expanded form.
  const wanted: Record<string, unknown>[] = units.map((unit, i) => {
    const replacement = updated[i]
    if (replacement === undefined) return unit
    return replacement.file_path === observed[i]?.file_path
      ? { ...replacement, file_path: unit.file_path }
      : replacement
  })
  const [head] = wanted
  if (!head) return { input }

  const perFile = Math.max(1, symbolsOf(input).length)
  const paths: unknown[] = []
  for (let i = 0; i < wanted.length; i += perFile) paths.push(wanted[i]!.file_path)
  const symbols = wanted.slice(0, perFile).map(unit => unit.symbol)

  const { file_path: _path, file_paths: _paths, view: _view, symbol: _symbol, encoding: _encoding, ...rest } =
    input
  const merged: Record<string, unknown> = {
    ...rest,
    ...(input.file_paths !== undefined ? { file_paths: paths } : { file_path: paths[0] }),
    ...(head.view !== undefined && { view: head.view }),
    ...(symbols.some(symbol => symbol !== undefined) && {
      symbol: sameList(symbols, symbolsOf(input)) ? input.symbol : symbols,
    }),
    ...(head.encoding !== undefined && { encoding: head.encoding }),
  }

  if (!paths.every(p => typeof p === 'string' && p !== '')) {
    return refusedFor(units, wanted, label)
  }
  let derived: SingleInput[]
  try {
    derived = batchReadUnits(merged as Input)
  } catch (e) {
    // expandPath refuses a path with a null byte in it.
    logError(e)
    return refusedFor(units, wanted, label)
  }
  for (let i = 0; i < Math.max(derived.length, wanted.length); i++) {
    if (!sameUnit(derived[i], wanted[i])) return refusedFor(units, wanted, label)
  }
  return { input: merged }
}

/** The refusal names the Reads the hooks changed — the ones a batch cannot take. */
function refusedFor(
  units: readonly SingleInput[],
  wanted: readonly Record<string, unknown>[],
  label: (index: number) => string,
): { refusal: string } {
  const changed = units.flatMap((unit, i) => (sameUnit(unit, wanted[i]) ? [] : [label(i)]))
  const [one, ...more] = changed.length > 0 ? changed : units.map((_, i) => label(i))
  return {
    refusal:
      more.length === 0
        ? `A hook changed the Read of ${one} in a way a batch cannot carry for one file — Read that file in a call of its own.`
        : `A hook changed the Reads of ${[one, ...more].join(', ')} in a way a batch cannot carry file by file — Read those files in calls of their own.`,
  }
}

/** Two single-Read inputs that read the same thing: the same file, the same options. */
function sameUnit(
  a: Record<string, unknown> | undefined,
  b: Record<string, unknown> | undefined,
): boolean {
  if (!a || !b) return false
  for (const key of new Set([...Object.keys(a), ...Object.keys(b)])) {
    const x = a[key]
    const y = b[key]
    if (key === 'file_path') {
      if (typeof x !== 'string' || typeof y !== 'string' || !samePath(x, y)) return false
    } else if (x !== y) {
      return false
    }
  }
  return true
}

function samePath(a: string, b: string): boolean {
  try {
    return expandPath(a) === expandPath(b)
  } catch (e) {
    // expandPath refuses a path with a null byte in it: no file to be the same.
    logError(e)
    return false
  }
}

function sameList(a: readonly unknown[], b: readonly unknown[]): boolean {
  return a.length === b.length && a.every((value, i) => value === b[i])
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
  const unitResults: HookUnitResult[] = []
  let spent = 0

  for (const filePath of distinctPaths(readPathsOf(input))) {
    const fullFilePath = expandPath(filePath)
    const label = displayPath(fullFilePath, cwd)
    const ext = extensionOf(fullFilePath)
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
    // The missing symbols are named in the notes whatever becomes of the file.
    unitResults.push(...read.missingUnits)
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
    unitResults.push(...read.shownUnits)
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
    unitResults,
  }
}

type FileRead = {
  sections: Section[]
  missing: string[]
  newMessages: NewMessages
  /** The file's single Reads as PostToolUse sees them, when its block is shown. */
  shownUnits: HookUnitResult[]
  /** Its symbol Reads that found nothing — named in the notes either way. */
  missingUnits: HookUnitResult[]
}

/**
 * One file's sections: its whole-file Read, or one per symbol. A symbol read
 * that finds nothing to expand falls back to the whole body (a file with no
 * outline language, or no symbols), and the same body is not repeated.
 *
 * Each single Read is also kept as its hooks see it: what it returned, or
 * the error it failed with. A dedup stub is left out — nothing was read or
 * shown for it.
 */
async function readSections(
  input: Input & { file_path: string },
  fullFilePath: string,
  symbols: readonly string[],
  fileContext: ToolUseContext,
  readOne: ReadOneFile,
  before: FileState | undefined,
): Promise<FileRead> {
  const { readFileState } = fileContext
  const sections: Section[] = []
  const missing: string[] = []
  const newMessages: NewMessages = []
  const shownUnits: HookUnitResult[] = []
  const missingUnits: HookUnitResult[] = []
  const shownBodies: FileState[] = []
  let leftPartialView = false

  for (const symbol of symbols.length > 0 ? symbols : [undefined]) {
    const one = unitInput(input, input.file_path, symbol)
    let result: ToolResult<Output>
    try {
      result = await readOne(one, fileContext)
    } catch (e) {
      if (isAbortError(e)) throw e
      if (e instanceof SymbolNotFoundError) {
        missing.push(e.symbol)
        missingUnits.push({ input: one, error: e })
        continue
      }
      sections.push({ text: e instanceof Error ? e.message : String(e) })
      shownUnits.push({ input: one, error: e })
      continue
    }
    if (result.data.type !== 'file_unchanged') {
      shownUnits.push({ input: one, output: result.data })
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
  return { sections, missing, newMessages, shownUnits, missingUnits }
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

function extensionOf(fullFilePath: string): string {
  return path.extname(fullFilePath).toLowerCase().slice(1)
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

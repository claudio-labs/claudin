// Orchestration for the Patch tool: validation, permission resolution,
// staging, commit with best-effort rollback, and post-write wiring
// (read-state, LSP, file history, IDE notify, diagnostics). Deliberately free
// of any `ink`/UI import so it stays a pure module that unit-tests cheaply
// (.claudin/rules/testing.md, "Ink/React components load under `bun test`").
// The thin Tool definition + UI live in ApplyPatchTool.ts / UI.tsx.
//
// Apply what matches (2026-09-29). Every change — an Update hunk, an Add, a
// Delete, a Move — is decided on its own: applied; already applied, when its
// result is on disk already (a patch sent twice); or NOT applied, with the
// reason. Every file with an applied change is written and the result lists
// the rest, so the model sends a patch with only those. Until then one failing
// hunk, one unread file or one duplicate section refused the whole patch and
// the model re-sent all of it: over 115 real retries, 603k chars, ~62% of them
// hunks that would have applied (team memory apply-patch-failure-taxonomy). A
// call that writes nothing and fails something is still an error, and
// validation refuses only a patch in which nothing could apply. Killswitch:
// CLAUDIN_PATCH_ALL_OR_NOTHING=1 — any change not applied fails the call with
// nothing written, and validation refuses every file-level problem up front,
// the never-read gate included (with its lines served).
//
// Read gate. Any read counts: the whole file, an outline, a symbol, a range,
// an injected CLAUDE.md, a Read since clipped out of the transcript, a file
// changed on disk after it was read — whether a hunk applies is decided where
// it is applied, against the file as it is then. A file never read at all is
// applied only when every hunk's old side sits in it exactly and in one place:
// the model wrote those lines, so it saw them — through Bash for 82% of the 229
// never-read refusals since 2026-09-24, most of the rest through a Grep — and
// 88% of the refusals that served the lines came back as the identical patch.
// Otherwise it is NOT applied, with "Read it first"; so is a Delete of a file
// never read. Edit, Write and NotebookEdit keep the full gate
// (.claudin/rules/cache.md).

import type { UUID } from 'crypto'
import { basename, extname, relative } from 'path'
import type { StructuredPatchHunk } from 'diff'
import type { ToolAdvice, ToolUseContext, ValidationResult } from 'src/tools/Tool.js'
import {
  checkMemoryFileFormat,
  indexTextFromResponse,
  memoryIndexAdvice,
} from 'src/memory/memdir/memoryFormatGuard.js'
import { checkTeamMemSecrets } from 'src/memory/memdir/teamMemSecretGuard.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { getPatchFromContents } from 'src/vcs/git/diff.js'
import { getFileModificationTime } from 'src/shared/fs/file.js'
import type { FileStateCache } from 'src/shared/fs/fileStateCache.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { expandPath } from 'src/shared/fs/path.js'
import { checkBatchWritePermission } from 'src/permissions/filePermissions.js'
import type { PermissionDecision } from 'src/permissions/PermissionResult.js'
import { readGateMessage } from 'src/tools/shared/readBeforeEditMessages.js'
import {
  fileLinesOf,
  type LineRegion,
  locateExactLines,
  mergeServedRegions,
  serveRegions,
} from 'src/tools/shared/servedRegion.js'
import {
  BATCH_CONFIRM_THRESHOLD,
  commitStagedChanges,
  countAddDel,
  type DiagnosticAttachment,
  readFileForStaging,
  type StagedChange,
  type StagedChangeType,
} from 'src/tools/shared/stagedWrite/stagedWrite.js'
import {
  applySections,
  type Hunk,
  parsePatch,
} from 'src/tools/ApplyPatchTool/patchFormat.js'
import { APPLY_PATCH_TOOL_NAME } from 'src/tools/ApplyPatchTool/prompt.js'
import type { ThenRun } from 'src/tools/shared/editThen/editThenShape.js'

export type ApplyPatchInput = { patchText: string }

export type ApplyPatchChangeType = StagedChangeType

export type ApplyPatchFileResult = {
  absPath: string
  type: ApplyPatchChangeType
  movePath?: string
  additions: number
  deletions: number
  structuredPatch: StructuredPatchHunk[]
}

/** `then` and `thenNote` only under CLAUDIN_EDIT_THEN (editThenShape.ts). */
export type ApplyPatchOutput = {
  files: ApplyPatchFileResult[]
  /** Changes left out, each with its reason: the model sends a patch with only these. */
  notApplied?: string[]
  /** Changes whose result was on disk already. */
  alreadyApplied?: string[]
  /** Files written although never read, because every hunk matched them exactly. */
  appliedUnread?: string[]
  then?: ThenRun[]
  thenNote?: string
}

function resolveHunkPath(hunkPath: string): string {
  // expandPath handles `~`, absolute paths, and resolves relative paths
  // against the working directory (the form Codex models emit natively).
  return expandPath(hunkPath)
}

function displayPath(absPath: string): string {
  const rel = relative(getCwd(), absPath)
  return rel && !rel.startsWith('..') ? rel : absPath
}

/** Resolved write targets for a hunk (source path plus the move destination). */
function hunkTargets(hunk: Hunk): { absPath: string; movePath?: string } {
  const absPath = resolveHunkPath(hunk.path)
  if (hunk.type === 'update' && hunk.movePath) {
    const movePath = resolveHunkPath(hunk.movePath)
    return movePath === absPath ? { absPath } : { absPath, movePath }
  }
  return { absPath }
}

function fail(message: string, errorCode = 1): ValidationResult {
  return { result: false, message, errorCode }
}

/**
 * The refusal's second half, when the hunk can be served (servedRegion.ts):
 * every chunk's old side sits in the current file exactly and uniquely, and
 * the regions fit the cap. Registers the slices and returns the numbered
 * text; `null` means the plain refusal stands.
 */
function serveUpdateHunk(
  hunk: Extract<Hunk, { type: 'update' }>,
  absPath: string,
  context: ToolUseContext,
): string | null {
  const current = readFileForStaging(absPath)
  if (!current.fileExists) return null
  const fileLines = fileLinesOf(current.content)
  const regions: LineRegion[] = []
  for (const chunk of hunk.chunks) {
    // A pure insertion with no context localizes nothing and is not what the
    // gate refused; the chunks that carry an old side must each match.
    if (chunk.oldLines.every(line => line.trim() === '')) continue
    const region = locateExactLines(fileLines, chunk.oldLines)
    if (!region) return null
    regions.push(region)
  }
  if (regions.length === 0) return null
  const merged = mergeServedRegions(regions, fileLines.length)
  if (!merged) return null
  return serveRegions(
    context.readFileState,
    absPath,
    fileLines,
    getFileModificationTime(absPath),
    merged,
  )
}

/** The served refusal's own instruction (CLAUDIN_PATCH_ALL_OR_NOTHING only). */
const SERVED_RESEND = ' — resubmit the same patch:'

function servedSuffix(served: string): string {
  return ` The lines it needs are shown below and now count as read${SERVED_RESEND}\n${served}`
}

/** The tool-name prefix each single-problem message carries, dropped when several are listed. */
const MESSAGE_PREFIX_RE = new RegExp(`^${APPLY_PATCH_TOOL_NAME}:?\\s*`)

function isAllOrNothing(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_PATCH_ALL_OR_NOTHING)
}

const bullets = (messages: string[]): string =>
  messages.map(m => `  • ${m.replace(MESSAGE_PREFIX_RE, '')}`).join('\n')

// ---------------------------------------------------------------------------
// Planning — what each file of the patch can have done to it
// ---------------------------------------------------------------------------

/** The sections that write one file, in patch order. */
type FileGroup = { absPath: string; rel: string; hunks: Hunk[] }

type Plan =
  | { kind: 'stage'; group: FileGroup; unread: boolean }
  | { kind: 'already'; group: FileGroup; note: string }
  | { kind: 'problem'; message: string; changes: number; readRemedy: boolean }

/** How many reportable changes a section holds: its hunks, or the one Add/Delete. */
const changesIn = (hunk: Hunk): number => (hunk.type === 'update' ? Math.max(1, hunk.chunks.length) : 1)

/** The Add's file content, as it would be written. */
function addContent(hunk: Extract<Hunk, { type: 'add' }>): string {
  return hunk.contents.length === 0 || hunk.contents.endsWith('\n') ? hunk.contents : `${hunk.contents}\n`
}

/**
 * Every hunk's old side sits in the file exactly and in one place — enough to
 * apply to a file never read: the model wrote those lines, so it has seen them.
 * A pure insertion localizes nothing and rides along; one hunk must localize.
 */
function matchesExactly(hunks: Hunk[], absPath: string): boolean {
  const current = readFileForStaging(absPath)
  if (!current.fileExists) return false
  const fileLines = fileLinesOf(current.content)
  let located = 0
  for (const hunk of hunks) {
    if (hunk.type !== 'update') return false
    for (const chunk of hunk.chunks) {
      if (chunk.oldLines.every(line => line.trim() === '')) continue
      if (!locateExactLines(fileLines, chunk.oldLines)) return false
      located++
    }
  }
  return located > 0
}

/**
 * The patch's sections grouped by the file they write. `strict` is
 * CLAUDIN_PATCH_ALL_OR_NOTHING: every file-level problem is one, a second
 * section for a file included, and a never-read file is refused with its lines
 * served. Otherwise several Update sections of one file are one group (each is
 * matched against the file as it was), and a never-read file whose hunks all
 * match it exactly is staged.
 */
function planPatch(hunks: Hunk[], context: ToolUseContext, strict: boolean): Plan[] {
  const plans: Plan[] = []
  const groups = new Map<string, FileGroup>()
  for (const hunk of hunks) {
    let absPath: string
    try {
      absPath = resolveHunkPath(hunk.path)
    } catch (e) {
      plans.push({
        kind: 'problem',
        message: `${APPLY_PATCH_TOOL_NAME}: invalid path ${JSON.stringify(hunk.path)}: ${e instanceof Error ? e.message : String(e)}`,
        changes: changesIn(hunk),
        readRemedy: false,
      })
      continue
    }
    const group = groups.get(absPath)
    if (group) group.hunks.push(hunk)
    else groups.set(absPath, { absPath, rel: displayPath(absPath), hunks: [hunk] })
  }
  for (const group of groups.values()) plans.push(planFile(group, context, strict))
  return plans
}

function planFile(group: FileGroup, context: ToolUseContext, strict: boolean): Plan {
  const { absPath, rel, hunks } = group
  const fs = getFsImplementation()
  const changes = hunks.reduce((n, h) => n + changesIn(h), 0)
  const problem = (message: string, readRemedy = false): Plan => ({ kind: 'problem', message, changes, readRemedy })
  const first = hunks[0]!

  if (hunks.length > 1 && (strict || hunks.some(h => h.type !== 'update' || h.movePath))) {
    return problem(`${APPLY_PATCH_TOOL_NAME}: ${rel} appears in more than one section. Combine the changes into a single section.`)
  }
  if (extname(absPath) === '.ipynb') {
    return problem(`${APPLY_PATCH_TOOL_NAME} cannot edit Jupyter notebooks. Use the NotebookEdit tool for ${rel}.`)
  }
  if (first.type === 'add') {
    if (!fs.existsSync(absPath)) return { kind: 'stage', group, unread: false }
    if (!strict && readFileForStaging(absPath).content === addContent(first)) {
      return { kind: 'already', group, note: `${rel}: the file already has that content` }
    }
    return problem(`${APPLY_PATCH_TOOL_NAME}: cannot Add File ${rel} — it already exists. Use "*** Update File:" to modify it.`)
  }
  if (!fs.existsSync(absPath)) {
    if (first.type === 'delete' && !strict) return { kind: 'already', group, note: `${rel}: the file is already gone` }
    return problem(
      `${APPLY_PATCH_TOOL_NAME}: cannot ${first.type === 'delete' ? 'Delete' : 'Update'} ${rel} — the file does not exist.`,
    )
  }
  let unread = false
  if (context.readFileState.get(absPath) === undefined) {
    const message = `${APPLY_PATCH_TOOL_NAME}: ${readGateMessage('never-read', rel, 'patching it')}`
    if (strict) {
      const served = first.type === 'update' ? serveUpdateHunk(first, absPath, context) : null
      return served ? problem(message + servedSuffix(served)) : problem(message, true)
    }
    if (first.type === 'delete') return problem(message, true)
    if (!matchesExactly(hunks, absPath)) {
      return problem(`${message} Its hunks do not match it exactly, so it was not patched unread.`, true)
    }
    unread = true
  }
  if (first.type === 'update' && first.movePath) {
    const { movePath } = hunkTargets(first)
    if (movePath && fs.existsSync(movePath)) {
      return problem(
        `${APPLY_PATCH_TOOL_NAME}: cannot move ${rel} to ${displayPath(movePath)} — the destination already exists.`,
      )
    }
  }
  return { kind: 'stage', group, unread }
}

/**
 * Validates the patch before any permission prompt or write: it must parse and
 * hold file operations, and something in it must be able to apply — the
 * problems of a patch where nothing can are all listed at once. Per-file
 * problems in a patch with anything applicable are reported by the call,
 * beside what it wrote. Under CLAUDIN_PATCH_ALL_OR_NOTHING any problem refuses.
 */
export function validateApplyPatchInput(
  input: ApplyPatchInput,
  context: ToolUseContext,
): ValidationResult {
  let hunks: Hunk[]
  try {
    hunks = parsePatch(input.patchText).hunks
  } catch (e) {
    return fail(
      `${APPLY_PATCH_TOOL_NAME} failed to parse the patch: ${e instanceof Error ? e.message : String(e)}`,
    )
  }

  if (hunks.length === 0) {
    return fail(`${APPLY_PATCH_TOOL_NAME}: the patch contains no file operations.`)
  }

  const strict = isAllOrNothing()
  const plans = planPatch(hunks, context, strict)
  const problems = plans.flatMap(p => (p.kind === 'problem' ? [p] : []))
  if (problems.length === 0 || (!strict && problems.length < plans.length)) return { result: true }

  // Failures whose fix is reading the file: an N-file patch is told to batch
  // those reads into ONE message — otherwise the cheapest path the model can
  // see is read-one/patch-one, the round-trip waste this tool exists to avoid.
  const readHint =
    problems.filter(p => p.readRemedy).length >= 2
      ? '\nAny file above that needs a read: do them all in ONE message (parallel Read calls), then send the patch again.'
      : ''
  const errorCode = problems.some(p => p.readRemedy || p.message.includes('has not been read')) ? 2 : 1
  if (problems.length === 1) return fail(problems[0]!.message + readHint, errorCode)
  return fail(
    `${APPLY_PATCH_TOOL_NAME} found ${problems.length} problems — ${strict ? 'fix all of them, then resubmit the whole patch' : 'nothing in the patch can apply'}:\n` +
      bullets(problems.map(p => p.message)) +
      readHint,
    errorCode,
  )
}

/** Every absolute path the patch would write to or remove (for permissioning). */
export function resolveApplyPatchPaths(input: ApplyPatchInput): string[] {
  const hunks = parsePatch(input.patchText).hunks
  const paths = new Set<string>()
  for (const hunk of hunks) {
    const { absPath, movePath } = hunkTargets(hunk)
    paths.add(absPath)
    if (movePath) paths.add(movePath)
  }
  return [...paths]
}

/**
 * Paths to drop from the read-only tool-result cache after a patch lands.
 * Emits both the raw envelope path strings — to match a Read cached under the
 * same model-written string, the way FileEdit invalidates `callInput.file_path`
 * — and their resolved absolute forms, to match a Grep/Glob cached on an
 * absolute directory. Best-effort: a patch that no longer parses yields nothing
 * (the tool will already have errored before any write).
 */
export function applyPatchCacheInvalidationPaths(
  input: ApplyPatchInput,
): string[] {
  let hunks: Hunk[]
  try {
    hunks = parsePatch(input.patchText).hunks
  } catch {
    return []
  }
  const paths = new Set<string>()
  for (const hunk of hunks) {
    paths.add(hunk.path)
    if (hunk.type === 'update' && hunk.movePath) paths.add(hunk.movePath)
    try {
      const { absPath, movePath } = hunkTargets(hunk)
      paths.add(absPath)
      if (movePath) paths.add(movePath)
    } catch {
      // Resolution can throw on a malformed path; the raw form still helps.
    }
  }
  return [...paths]
}

export function checkApplyPatchPermissions(
  input: ApplyPatchInput,
  context: ToolUseContext,
): PermissionDecision {
  let paths: string[]
  try {
    paths = resolveApplyPatchPaths(input)
  } catch (e) {
    return {
      behavior: 'deny',
      message: `${APPLY_PATCH_TOOL_NAME} could not parse the patch: ${e instanceof Error ? e.message : String(e)}`,
      decisionReason: { type: 'other', reason: `${APPLY_PATCH_TOOL_NAME} parse error` },
    }
  }
  const decision = checkBatchWritePermission(
    APPLY_PATCH_TOOL_NAME,
    paths,
    context.getAppState().toolPermissionContext,
    { confirmThreshold: BATCH_CONFIRM_THRESHOLD },
  )
  // checkBatchWritePermission validates a synthetic per-path input, so its
  // `allow` carries `updatedInput: {}` (a batch placeholder). Tool execution
  // applies `permissionDecision.updatedInput` verbatim, so that empty object
  // would overwrite the real { patchText } before call() — leaving runApplyPatch
  // to parse `undefined`. Echo the real input back so the harness keeps it.
  if (decision.behavior === 'allow') {
    return { ...decision, updatedInput: input }
  }
  return decision
}

/**
 * The index-line note (memoryFormatGuard.ts) for the first memory file this
 * patch adds, updates or moves in that its directory's `MEMORY.md` does not
 * list — a line this patch, or another call of the same response
 * (`responseToolUses`), adds to that index counts. One note per call is
 * enough. An Add the format guard will refuse gets none: its refusal carries
 * the rules.
 */
export function applyPatchMemoryIndexAdvice(
  input: ApplyPatchInput,
  responseToolUses?: ToolUseContext['responseToolUses'],
): ToolAdvice | null {
  let hunks: Hunk[]
  try {
    hunks = parsePatch(input.patchText).hunks
  } catch {
    return null // validateInput has refused it already
  }
  const targets: Array<{ hunk: Hunk; path: string }> = []
  const pending = indexTextFromResponse(responseToolUses, getCwd())
  for (const hunk of hunks) {
    if (hunk.type === 'delete') continue
    let path: string
    try {
      const { absPath, movePath } = hunkTargets(hunk)
      path = movePath ?? absPath
    } catch {
      continue // a malformed path is reported by the call
    }
    if (basename(path) !== 'MEMORY.md') {
      targets.push({ hunk, path })
      continue
    }
    const added = hunk.type === 'add' ? hunk.contents : hunk.chunks.map(c => c.newLines.join('\n')).join('\n')
    pending.set(path, `${pending.get(path) ?? ''}\n${added}`)
  }
  for (const { hunk, path } of targets) {
    if (hunk.type === 'add' && checkMemoryFileFormat(path, addContent(hunk))) continue
    const advice = memoryIndexAdvice(path, pending)
    if (advice) return advice
  }
  return null
}

/** What staging one file produced: its change, if any, and the reports of its hunks. */
type StagedFile = { change: StagedChange | null; failed: string[]; already: string[] }

/** Reads the file's current content and computes what the plan's sections make of it. */
function stageFile(group: FileGroup): StagedFile {
  const first = group.hunks[0]!
  const { absPath, movePath } = hunkTargets(first)

  if (first.type === 'add') {
    const newContent = addContent(first)
    const secretError = checkTeamMemSecrets(absPath, newContent)
    if (secretError) throw new Error(secretError)
    // A memory file missing what its place requires (memoryFormatGuard.ts)
    const formatError = checkMemoryFileFormat(absPath, newContent)
    if (formatError) throw new Error(formatError)
    const structuredPatch = getPatchFromContents({
      filePath: absPath,
      oldContent: '',
      newContent,
    })
    return {
      change: {
        type: 'add',
        absPath,
        oldContent: null,
        newContent,
        encoding: 'utf8',
        endings: 'LF',
        ...countAddDel(structuredPatch),
        structuredPatch,
      },
      failed: [],
      already: [],
    }
  }

  const current = readFileForStaging(absPath)

  if (first.type === 'delete') {
    const structuredPatch = getPatchFromContents({
      filePath: absPath,
      oldContent: current.content,
      newContent: '',
    })
    return {
      change: {
        type: 'delete',
        absPath,
        oldContent: current.content,
        newContent: '',
        encoding: current.encoding,
        endings: current.endings,
        ...countAddDel(structuredPatch),
        structuredPatch,
      },
      failed: [],
      already: [],
    }
  }

  // update (optionally a move): every section matched against the file as it is
  const { text, outcomes } = applySections(
    absPath,
    group.hunks.map(h => (h.type === 'update' ? h.chunks : [])),
    current.content,
  )
  const flat = outcomes.flat()
  const failed = flat.flatMap(o => (o.kind === 'failed' ? [o.message] : []))
  const already = flat.flatMap(o => (o.kind === 'already' ? [`${group.rel}: a hunk is already applied at line ${o.line}`] : []))
  const applied = flat.filter(o => o.kind === 'applied').length
  // A move is one change with its hunks: it happens whole or not at all.
  if (movePath && failed.length) {
    return { change: null, failed: [...failed, `${group.rel} was not moved to ${displayPath(movePath)}: a hunk of it did not apply.`], already }
  }
  if (applied === 0 && !movePath) return { change: null, failed, already }
  const secretError = checkTeamMemSecrets(movePath ?? absPath, text)
  if (secretError) throw new Error(secretError)
  const formatError = checkMemoryFileFormat(movePath ?? absPath, text)
  if (formatError) throw new Error(formatError)
  const structuredPatch = getPatchFromContents({
    filePath: absPath,
    oldContent: current.content,
    newContent: text,
  })
  return {
    change: {
      type: movePath ? 'move' : 'update',
      absPath,
      movePath,
      oldContent: current.content,
      newContent: text,
      encoding: current.encoding,
      endings: current.endings,
      ...countAddDel(structuredPatch),
      structuredPatch,
    },
    failed,
    already,
  }
}

/**
 * Applies a validated patch: plans every file, stages what applies in memory,
 * then commits in order with an atomic re-check per file and best-effort
 * rollback if a write fails part-way. What did not apply rides back in
 * `notApplied`; a call that stages nothing and fails something throws the
 * whole list, and under CLAUDIN_PATCH_ALL_OR_NOTHING any failure does.
 */
export async function runApplyPatch(
  input: ApplyPatchInput,
  context: ToolUseContext,
  messageId: UUID,
): Promise<{ output: ApplyPatchOutput; newMessages: DiagnosticAttachment[] }> {
  const hunks = parsePatch(input.patchText).hunks
  const strict = isAllOrNothing()
  const plans = planPatch(hunks, context, strict)

  const staged: StagedChange[] = []
  const notApplied: string[] = []
  const alreadyApplied: string[] = []
  const appliedUnread: string[] = []
  for (const plan of plans) {
    if (plan.kind === 'problem') {
      notApplied.push(plan.message)
      continue
    }
    if (plan.kind === 'already') {
      alreadyApplied.push(plan.note)
      continue
    }
    try {
      const file = stageFile(plan.group)
      notApplied.push(...file.failed)
      alreadyApplied.push(...file.already)
      if (file.change) {
        staged.push(file.change)
        if (plan.unread) appliedUnread.push(plan.group.rel)
      }
    } catch (e) {
      notApplied.push(e instanceof Error ? e.message : String(e))
    }
  }

  if (notApplied.length && (strict || staged.length === 0)) {
    if (notApplied.length === 1 && alreadyApplied.length === 0) throw new Error(notApplied[0])
    const total = hunks.reduce((n, h) => n + changesIn(h), 0)
    throw new Error(
      `${APPLY_PATCH_TOOL_NAME} could not apply ${notApplied.length} of ${total} changes — ` +
        `${strict ? 'fix all of them, then resubmit the whole patch' : 'nothing was written'}:\n` +
        bullets(notApplied) +
        (alreadyApplied.length ? `\nAlready applied:\n${bullets(alreadyApplied)}` : ''),
    )
  }

  // Phases 2 & 3 — commit with rollback, then post-write wiring.
  const { committed, newMessages } = staged.length
    ? await commitStagedChanges(staged, context, messageId)
    : { committed: [], newMessages: [] }

  return {
    output: {
      files: committed.map(c => ({
        absPath: c.absPath,
        type: c.type,
        movePath: c.movePath,
        additions: c.additions,
        deletions: c.deletions,
        structuredPatch: c.structuredPatch,
      })),
      ...(notApplied.length > 0 && { notApplied }),
      ...(alreadyApplied.length > 0 && { alreadyApplied }),
      ...(appliedUnread.length > 0 && { appliedUnread }),
    },
    newMessages,
  }
}

/** Why `then` did not run: something in the patch did not apply, so its check would test half of it. */
export function thenSkippedFor(output: ApplyPatchOutput): string | undefined {
  const n = output.notApplied?.length ?? 0
  return n ? `then skipped: ${n} change${n === 1 ? '' : 's'} did not apply — fix ${n === 1 ? 'it' : 'them'} first` : undefined
}

/** Model-facing one-line-per-file summary, then what did not apply (diagnostics ride newMessages). */
export function summarizeApplyPatch(output: ApplyPatchOutput): string {
  const lines = output.files.map(f => {
    if (f.type === 'add') return `A ${displayPath(f.absPath)}`
    if (f.type === 'delete') return `D ${displayPath(f.absPath)}`
    const target = f.type === 'move' ? f.movePath! : f.absPath
    return `M ${displayPath(target)}`
  })
  const notApplied = output.notApplied ?? []
  const out = lines.length
    ? [`${notApplied.length ? 'Applied part of the patch' : 'Success. Applied the patch'} to the following files:`, ...lines]
    : ['Nothing to change: every change in the patch is already applied.']
  if (output.appliedUnread?.length) {
    out.push(`Note: ${output.appliedUnread.join(', ')} had not been read — patched because every hunk matched it exactly.`)
  }
  if (output.alreadyApplied?.length) out.push('Already applied, nothing changed:', bullets(output.alreadyApplied))
  if (notApplied.length) out.push('NOT applied — send a patch with only these hunks:', bullets(notApplied))
  return out.join('\n')
}

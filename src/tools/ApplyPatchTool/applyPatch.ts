// Orchestration for the Patch tool: validation, permission resolution,
// staging, atomic commit with best-effort rollback, and post-write wiring
// (read-state, LSP, file history, IDE notify, diagnostics). Deliberately free
// of any `ink`/UI import so it stays a pure module that unit-tests cheaply
// (.claudin/rules/testing.md, "Ink/React components load under `bun test`").
// The thin Tool definition + UI live in ApplyPatchTool.ts / UI.tsx.
//
// Resubmit. When every problem with a patch is a read-gate refusal that served
// the lines it refused over (servedRegion.ts), the identical patch now passes —
// and sending it again cost the model the whole patch as output a second time:
// in the session A/B of 2026-09-23, 24 of 63 claudin sessions re-sent a patch of
// ~8k chars that way. So such a refusal keeps the patch (one per readFileState,
// i.e. per agent) and says `patchText: "*** Resubmit"` applies it as sent. The
// model still sees the lines before the write lands. Any other Patch call
// drops the kept patch. Killswitch: CLAUDIN_DISABLE_PATCH_RESUBMIT=1, which also
// turns the sentinel back into an unparseable patch.
//
// Read gate. Update and Delete need the file to have been read, and any read
// counts: the whole file, an outline, a symbol, a range, an injected CLAUDE.md,
// a Read since clipped out of the transcript, a file changed on disk after it
// was read. Whether a hunk applies is decided where it is applied — stageHunk
// matches its context and "-" lines against the file as it is at that moment,
// so a wrong hunk is refused there and nothing the patch does not name is
// overwritten. Until 2026-09-24 this tool held Edit's gate (a full view,
// coverage of every hunk, no change since the read), and each of those
// refusals was answered with a Read that mostly bought nothing: half the
// coverage refusals and 17 of the 30 stale ones in the 2026-09-14..20 census
// came back as the identical patch (team memory tool-error-census-2026-09-20).
// Edit, Write and NotebookEdit keep the full gate (.claudin/rules/cache.md).

import type { UUID } from 'crypto'
import { extname, relative } from 'path'
import type { StructuredPatchHunk } from 'diff'
import type { ResolvedInput, ToolUseContext, ValidationResult } from 'src/tools/Tool.js'
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
  deriveNewContentsFromChunks,
  type Hunk,
  isResubmitSentinel,
  parsePatch,
  RESUBMIT_SENTINEL,
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

/** The served refusal's own instruction; dropped when the refusal offers the resubmit instead. */
const SERVED_RESEND = ' — resubmit the same patch:'

function servedSuffix(served: string): string {
  return ` The lines it needs are shown below and now count as read${SERVED_RESEND}\n${served}`
}

const RESUBMIT_HINT = `\nEvery line the patch needs now counts as read, so it applies exactly as sent: call ${APPLY_PATCH_TOOL_NAME} with patchText "${RESUBMIT_SENTINEL}" instead of sending the patch again.`

/** The tool-name prefix each single-problem message carries, dropped when several are listed. */
const MESSAGE_PREFIX_RE = new RegExp(`^${APPLY_PATCH_TOOL_NAME}:?\\s*`)

/** The patch a served refusal kept, per agent: a sub-agent's readFileState is its own. */
const pendingResubmits = new WeakMap<FileStateCache, string>()

function isResubmitEnabled(): boolean {
  return !isEnvTruthy(process.env.CLAUDIN_DISABLE_PATCH_RESUBMIT)
}

/**
 * `*** Resubmit` becomes the patch the previous call's served refusal kept;
 * any other input passes through and drops what was kept, so the sentinel
 * only ever means the patch refused one Patch call earlier.
 */
export function resolveApplyPatchInput(
  input: ApplyPatchInput,
  context: ToolUseContext,
): ResolvedInput<ApplyPatchInput> {
  if (!isResubmitEnabled()) return { ok: true, input }
  const kept = pendingResubmits.get(context.readFileState)
  pendingResubmits.delete(context.readFileState)
  if (!isResubmitSentinel(input.patchText)) return { ok: true, input }
  if (kept === undefined) {
    return {
      ok: false,
      message: `${APPLY_PATCH_TOOL_NAME}: "${RESUBMIT_SENTINEL}" applies the patch the previous ${APPLY_PATCH_TOOL_NAME} call was refused for, and there is none — send the whole patch.`,
    }
  }
  return { ok: true, input: { ...input, patchText: kept } }
}

/**
 * Validates the patch before any permission prompt or write: parses it,
 * rejects empty / duplicate / notebook targets, and requires every Update or
 * Delete target to have been read — in any form, see "Read gate" above.
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

  const seen = new Set<string>()
  const fs = getFsImplementation()

  // Collect ALL problems across every file section rather than bailing on the
  // first — since a patch is atomic, one bad section rejects the whole batch,
  // so surfacing them one-per-round forces the model into an O(N) fix-resubmit
  // loop for an N-file patch. Reporting them together lets it converge in one
  // pass. At most one problem is recorded per file (checks are sequential).
  const failures: string[] = []
  let firstErrorCode = 1
  // Failures whose fix is reading the file. Counted so an N-file patch can be
  // told to batch those reads into ONE message — otherwise the cheapest path
  // the model can see is read-one/patch-one, which is the round-trip waste this
  // tool exists to avoid.
  let readRemedyFailures = 0
  // Failures whose refusal served the lines it needed: when every failure is
  // one, the identical patch passes and can be resubmitted by reference.
  let servedFailures = 0
  const note = (message: string, errorCode = 1): void => {
    if (failures.length === 0) firstErrorCode = errorCode
    failures.push(message)
  }

  for (const hunk of hunks) {
    let absPath: string
    try {
      absPath = resolveHunkPath(hunk.path)
    } catch (e) {
      note(
        `${APPLY_PATCH_TOOL_NAME}: invalid path ${JSON.stringify(hunk.path)}: ${e instanceof Error ? e.message : String(e)}`,
      )
      continue
    }
    const rel = displayPath(absPath)

    if (seen.has(absPath)) {
      note(
        `${APPLY_PATCH_TOOL_NAME}: ${rel} appears in more than one section. Combine the changes into a single section.`,
      )
      continue
    }
    seen.add(absPath)

    if (extname(absPath) === '.ipynb') {
      note(
        `${APPLY_PATCH_TOOL_NAME} cannot edit Jupyter notebooks. Use the NotebookEdit tool for ${rel}.`,
      )
      continue
    }

    if (hunk.type === 'add') {
      if (fs.existsSync(absPath)) {
        note(
          `${APPLY_PATCH_TOOL_NAME}: cannot Add File ${rel} — it already exists. Use "*** Update File:" to modify it.`,
        )
      }
      continue
    }

    // Update / Delete require the file to exist and to have been read.
    if (!fs.existsSync(absPath)) {
      note(
        `${APPLY_PATCH_TOOL_NAME}: cannot ${hunk.type === 'delete' ? 'Delete' : 'Update'} ${rel} — the file does not exist.`,
      )
      continue
    }

    // Any read counts — see "Read gate" in the header.
    if (context.readFileState.get(absPath) === undefined) {
      const message = `${APPLY_PATCH_TOOL_NAME}: ${readGateMessage('never-read', rel, 'patching it')}`
      const served =
        hunk.type === 'update' ? serveUpdateHunk(hunk, absPath, context) : null
      if (served) {
        note(message + servedSuffix(served), 2)
        servedFailures++
      } else {
        note(message, 2)
        readRemedyFailures++
      }
      continue
    }

    if (hunk.type === 'update' && hunk.movePath) {
      const { movePath } = hunkTargets(hunk)
      if (movePath && fs.existsSync(movePath)) {
        note(
          `${APPLY_PATCH_TOOL_NAME}: cannot move ${rel} to ${displayPath(movePath)} — the destination already exists.`,
        )
      }
    }
  }

  if (failures.length === 0) return { result: true }
  const resubmit = servedFailures === failures.length && isResubmitEnabled()
  if (resubmit) {
    // One instruction, not two: "resubmit the same patch" read as "send it
    // again", the output this exists to save.
    pendingResubmits.set(context.readFileState, input.patchText)
    const shown = failures.map(m => m.replace(SERVED_RESEND, ':'))
    if (shown.length === 1) return fail(shown[0] + RESUBMIT_HINT, firstErrorCode)
    return fail(
      `${APPLY_PATCH_TOOL_NAME} found ${shown.length} problems, each shown with the lines it needs:\n` +
        shown.map(m => `  • ${m.replace(MESSAGE_PREFIX_RE, '')}`).join('\n') +
        RESUBMIT_HINT,
      firstErrorCode,
    )
  }
  if (failures.length === 1) return fail(failures[0], firstErrorCode)
  return fail(
    `${APPLY_PATCH_TOOL_NAME} found ${failures.length} problems — fix all of them, then resubmit the whole patch:\n` +
      failures
        .map(m => `  • ${m.replace(MESSAGE_PREFIX_RE, '')}`)
        .join('\n') +
      (readRemedyFailures >= 2
        ? '\nAny file above that needs a read: do them all in ONE message (parallel Read calls), then resubmit the whole patch.'
        : ''),
    firstErrorCode,
  )
}

/** Every absolute path the patch would write to or remove (for permissioning). */
export function resolveApplyPatchPaths(input: ApplyPatchInput): string[] {
  const hunks = parsePatch(input.patchText).hunks
  const paths: string[] = []
  for (const hunk of hunks) {
    const { absPath, movePath } = hunkTargets(hunk)
    paths.push(absPath)
    if (movePath) paths.push(movePath)
  }
  return paths
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

/** Reads current content and computes the new content for one hunk. */
function stageHunk(hunk: Hunk): StagedChange {
  const { absPath, movePath } = hunkTargets(hunk)

  if (hunk.type === 'add') {
    const newContent =
      hunk.contents.length === 0 || hunk.contents.endsWith('\n')
        ? hunk.contents
        : `${hunk.contents}\n`
    const secretError = checkTeamMemSecrets(absPath, newContent)
    if (secretError) throw new Error(secretError)
    const structuredPatch = getPatchFromContents({
      filePath: absPath,
      oldContent: '',
      newContent,
    })
    return {
      type: 'add',
      absPath,
      oldContent: null,
      newContent,
      encoding: 'utf8',
      endings: 'LF',
      ...countAddDel(structuredPatch),
      structuredPatch,
    }
  }

  const current = readFileForStaging(absPath)

  if (hunk.type === 'delete') {
    const structuredPatch = getPatchFromContents({
      filePath: absPath,
      oldContent: current.content,
      newContent: '',
    })
    return {
      type: 'delete',
      absPath,
      oldContent: current.content,
      newContent: '',
      encoding: current.encoding,
      endings: current.endings,
      ...countAddDel(structuredPatch),
      structuredPatch,
    }
  }

  // update (optionally a move)
  const newContent = deriveNewContentsFromChunks(
    absPath,
    hunk.chunks,
    current.content,
  )
  const secretError = checkTeamMemSecrets(movePath ?? absPath, newContent)
  if (secretError) throw new Error(secretError)
  const structuredPatch = getPatchFromContents({
    filePath: absPath,
    oldContent: current.content,
    newContent,
  })
  return {
    type: movePath ? 'move' : 'update',
    absPath,
    movePath,
    oldContent: current.content,
    newContent,
    encoding: current.encoding,
    endings: current.endings,
    ...countAddDel(structuredPatch),
    structuredPatch,
  }
}

/**
 * Applies a validated patch: stages everything in memory (failing before any
 * write), then commits in order with an atomic re-check per file and
 * best-effort rollback if a write fails part-way. Returns the structured
 * result plus any LSP diagnostic attachment messages to surface to the model.
 */
export async function runApplyPatch(
  input: ApplyPatchInput,
  context: ToolUseContext,
  messageId: UUID,
): Promise<{ output: ApplyPatchOutput; newMessages: DiagnosticAttachment[] }> {
  const hunks = parsePatch(input.patchText).hunks

  // Phase 1 — stage all changes in memory. Any failure here writes nothing.
  // Collect every staging failure (context mismatch, secret guard, …) instead
  // of throwing on the first: a patch is atomic, so one unmatched section
  // rejects the whole batch — reporting them one-per-round would force the
  // model into an O(N) fix-resubmit loop for an N-file patch.
  const staged: StagedChange[] = []
  const stageErrors: string[] = []
  for (const hunk of hunks) {
    try {
      staged.push(stageHunk(hunk))
    } catch (e) {
      stageErrors.push(e instanceof Error ? e.message : String(e))
    }
  }
  if (stageErrors.length === 1) {
    throw new Error(stageErrors[0])
  }
  if (stageErrors.length > 1) {
    throw new Error(
      `${APPLY_PATCH_TOOL_NAME} could not stage ${stageErrors.length} of ${hunks.length} file sections — fix all of them, then resubmit the whole patch:\n` +
        stageErrors.map(m => `  • ${m}`).join('\n'),
    )
  }

  // Phases 2 & 3 — atomic commit with rollback, then post-write wiring.
  const { committed, newMessages } = await commitStagedChanges(
    staged,
    context,
    messageId,
  )

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
    },
    newMessages,
  }
}

/** Model-facing one-line-per-file summary (diagnostics ride newMessages). */
export function summarizeApplyPatch(output: ApplyPatchOutput): string {
  const lines = output.files.map(f => {
    if (f.type === 'add') return `A ${displayPath(f.absPath)}`
    if (f.type === 'delete') return `D ${displayPath(f.absPath)}`
    const target = f.type === 'move' ? f.movePath! : f.absPath
    return `M ${displayPath(target)}`
  })
  return `Success. Applied the patch to the following files:\n${lines.join('\n')}`
}

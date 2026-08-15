// Transactional multi-file write, shared by every tool that rewrites a batch of
// files in one shot (apply_patch, Rename).
//
// The contract: callers stage every change in memory FIRST — so a failure to
// build any of them writes nothing — then hand the staged list here.
// `commitStagedChanges` writes in order with a per-file atomic re-check, rolls
// every already-written file back if any of them fails, and only then does the
// post-write wiring (read-state, file history, LSP, IDE notify, diagnostics).
//
// Deliberately free of any `ink`/UI import so it stays unit-testable under
// `bun test`.

import type { UUID } from 'crypto'
import { dirname } from 'path'
import type { StructuredPatchHunk } from 'diff'

import type { ToolUseContext } from 'src/Tool.js'
import { diagnosticTracker } from 'src/platform/diagnosticTracking.js'
import {
  armFileForLateDiagnostics,
  buildPostEditDiagnosticsMessages,
} from 'src/platform/lsp/diagnosticsForToolResult.js'
import { clearDeliveredDiagnosticsForFile } from 'src/platform/lsp/LSPDiagnosticRegistry.js'
import { getLspServerManager } from 'src/platform/lsp/manager.js'
import { notifyVscodeFileUpdated } from 'src/services/mcp/vscodeSdkMcp.js'
import { checkTeamMemSecrets } from 'src/services/teamMemorySync/teamMemSecretGuard.js'
import { logForDebugging } from 'src/shared/debug.js'
import { countLinesChanged, getPatchFromContents } from 'src/vcs/git/diff.js'
import { countAddDel } from 'src/vcs/git/diffStat.js'
import { AbortError, isENOENT } from 'src/shared/errors.js'
import { getFileModificationTime, writeTextContent } from 'src/shared/fs/file.js'
import {
  fileHistoryEnabled,
  fileHistoryTrackEdit,
} from 'src/shared/fs/fileHistory.js'
import {
  type LineEndingType,
  readFileSyncWithMetadata,
} from 'src/shared/fs/fileRead.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { logError } from 'src/shared/log.js'
import { FILE_UNEXPECTEDLY_MODIFIED_ERROR } from 'src/tools/FileEditTool/constants.js'

// A batch touching this many files prompts once even under acceptEdits — a
// large multi-file write is qualitatively different from a single edit.
export const BATCH_CONFIRM_THRESHOLD = 20

export type StagedChangeType = 'add' | 'update' | 'delete' | 'move'

export type StagedChange = {
  type: StagedChangeType
  absPath: string
  movePath?: string
  // null when the file did not exist before (an `add`).
  oldContent: string | null
  // '' for a delete.
  newContent: string
  encoding: BufferEncoding
  endings: LineEndingType
  additions: number
  deletions: number
  structuredPatch: StructuredPatchHunk[]
}

// LSP diagnostic attachment messages, derived from the wiring helper so we
// don't depend on the AttachmentMessage type's module path.
export type DiagnosticAttachment = Awaited<
  ReturnType<typeof buildPostEditDiagnosticsMessages>
>[number]

export type CommitStagedOptions = {
  /**
   * Mark the rewritten files as a partial view in `readFileState`. Use this
   * when the model never saw the file content (a mechanical rewrite it did not
   * author), so a later hand-edit is forced to Read first.
   */
  markReadStatePartial?: boolean
}

export type FileForStaging = {
  content: string
  fileExists: boolean
  encoding: BufferEncoding
  endings: LineEndingType
}

export function readFileForStaging(absPath: string): FileForStaging {
  try {
    const meta = readFileSyncWithMetadata(absPath)
    return {
      content: meta.content,
      fileExists: true,
      encoding: meta.encoding,
      endings: meta.lineEndings,
    }
  } catch (e) {
    if (isENOENT(e)) {
      return { content: '', fileExists: false, encoding: 'utf8', endings: 'LF' }
    }
    throw e
  }
}

// Re-exported so apply_patch/Rename keep importing it from here; the body moved
// to utils/diffStat.js so the TUI collapse path can count without pulling this
// module's LSP/MCP/team-memory graph in.
export { countAddDel }

/**
 * Stages a whole-content rewrite of an existing file. For callers that compute
 * the new text themselves (a codemod) instead of deriving it from patch hunks.
 * Throws if the file is missing or the new content would leak a secret into
 * tracked team memory.
 *
 * `base` is the read `newContent` was derived from. A caller that already read
 * the file MUST pass it: `oldContent` is what the commit-time modification
 * check compares disk against, so re-reading here would compare a fresh
 * snapshot with itself and silently overwrite an edit that landed in between.
 */
export function stageContentReplacement(
  absPath: string,
  newContent: string,
  base?: FileForStaging,
): StagedChange {
  const current = base ?? readFileForStaging(absPath)
  if (!current.fileExists) {
    throw new Error(`${absPath} no longer exists.`)
  }
  const secretError = checkTeamMemSecrets(absPath, newContent)
  if (secretError) throw new Error(secretError)
  const structuredPatch = getPatchFromContents({
    filePath: absPath,
    oldContent: current.content,
    newContent,
  })
  return {
    type: 'update',
    absPath,
    oldContent: current.content,
    newContent,
    encoding: current.encoding,
    endings: current.endings,
    ...countAddDel(structuredPatch),
    structuredPatch,
  }
}

/** True when the on-disk content no longer matches what we staged. */
export function isUnexpectedlyModified(change: StagedChange): boolean {
  const fs = getFsImplementation()
  if (change.oldContent === null) {
    // An add: the file must still not exist.
    return fs.existsSync(change.absPath)
  }
  // A move's destination was validated as non-existent; if it appeared since
  // (TOCTOU, or call() reached without validateInput), bail out rather than
  // clobber it — writeChange would otherwise overwrite the destination
  // unconditionally before unlinking the source.
  if (
    change.type === 'move' &&
    change.movePath &&
    fs.existsSync(change.movePath)
  ) {
    return true
  }
  const current = readFileForStaging(change.absPath)
  return !current.fileExists || current.content !== change.oldContent
}

export function writeChange(change: StagedChange): void {
  const fs = getFsImplementation()
  switch (change.type) {
    case 'add':
    case 'update':
      fs.mkdirSync(dirname(change.absPath))
      writeTextContent(
        change.absPath,
        change.newContent,
        change.encoding,
        change.endings,
      )
      break
    case 'move':
      fs.mkdirSync(dirname(change.movePath!))
      writeTextContent(
        change.movePath!,
        change.newContent,
        change.encoding,
        change.endings,
      )
      fs.unlinkSync(change.absPath)
      break
    case 'delete':
      fs.unlinkSync(change.absPath)
      break
  }
}

/** Best-effort reversal of an already-committed change. Never throws. */
export function rollbackChange(change: StagedChange): void {
  const fs = getFsImplementation()
  try {
    switch (change.type) {
      case 'add':
        if (fs.existsSync(change.absPath)) fs.unlinkSync(change.absPath)
        break
      case 'update':
      case 'delete':
        if (change.oldContent !== null) {
          writeTextContent(
            change.absPath,
            change.oldContent,
            change.encoding,
            change.endings,
          )
        }
        break
      case 'move':
        if (change.oldContent !== null) {
          writeTextContent(
            change.absPath,
            change.oldContent,
            change.encoding,
            change.endings,
          )
        }
        if (change.movePath && fs.existsSync(change.movePath)) {
          fs.unlinkSync(change.movePath)
        }
        break
    }
  } catch (e) {
    logError(e)
  }
}

function notifyLsp(target: string, content: string): void {
  const lspManager = getLspServerManager()
  if (!lspManager) return
  clearDeliveredDiagnosticsForFile(`file://${target}`)
  lspManager.changeFile(target, content).catch((err: Error) => {
    logForDebugging(`LSP: changeFile failed for ${target}: ${err.message}`)
    logError(err)
  })
  lspManager.saveFile(target).catch((err: Error) => {
    logForDebugging(`LSP: saveFile failed for ${target}: ${err.message}`)
    logError(err)
  })
}

/**
 * Commits a staged batch: writes in order with an atomic re-check per file and
 * best-effort rollback if a write fails part-way, then does the post-write
 * wiring for every surviving file. Returns the committed changes plus any LSP
 * diagnostic attachment messages to surface to the model.
 */
export async function commitStagedChanges(
  staged: StagedChange[],
  context: ToolUseContext,
  messageId: UUID,
  options: CommitStagedOptions = {},
): Promise<{ committed: StagedChange[]; newMessages: DiagnosticAttachment[] }> {
  const { readFileState, updateFileHistoryState, agentId, abortController } =
    context

  const committed: StagedChange[] = []
  try {
    for (const change of staged) {
      if (abortController.signal.aborted) {
        throw new AbortError()
      }

      if (isUnexpectedlyModified(change)) {
        throw new Error(FILE_UNEXPECTEDLY_MODIFIED_ERROR)
      }

      const historyTargets =
        change.type === 'move'
          ? [change.absPath, change.movePath!]
          : [change.absPath]
      if (fileHistoryEnabled()) {
        for (const t of historyTargets) {
          await fileHistoryTrackEdit(updateFileHistoryState, t, messageId)
        }
      }
      await diagnosticTracker.beforeFileEditedCompat(change.absPath)

      // Record the change as in-flight BEFORE touching the filesystem. A move
      // writes the destination and then unlinks the source; if that unlink
      // throws (e.g. a read-only source directory), pushing afterwards would
      // leave this change out of the rollback loop — orphaning the written
      // destination while the source survives, a half-applied move that still
      // propagates the error. rollbackChange is a no-op for a not-yet-written
      // change (its existsSync/oldContent guards), so tracking intent first
      // makes a partial write fully reversible.
      committed.push(change)
      writeChange(change)
    }
  } catch (e) {
    for (let i = committed.length - 1; i >= 0; i--) {
      rollbackChange(committed[i])
    }
    throw e
  }

  const newMessages: DiagnosticAttachment[] = []
  for (const change of committed) {
    countLinesChanged(
      change.structuredPatch,
      change.type === 'add' ? change.newContent : undefined,
    )

    if (change.type === 'delete') {
      readFileState.delete(change.absPath)
      continue
    }

    const target = change.type === 'move' ? change.movePath! : change.absPath
    if (change.type === 'move') {
      readFileState.delete(change.absPath)
    }
    readFileState.set(target, {
      content: change.newContent,
      timestamp: getFileModificationTime(target),
      offset: undefined,
      limit: undefined,
      ...(options.markReadStatePartial ? { isPartialView: true } : {}),
    })
    notifyLsp(target, change.newContent)
    notifyVscodeFileUpdated(target, change.oldContent ?? '', change.newContent)
    armFileForLateDiagnostics(target, agentId)
    newMessages.push(...(await buildPostEditDiagnosticsMessages(target)))
  }

  return { committed, newMessages }
}

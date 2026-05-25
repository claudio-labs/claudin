/**
 * Handlers for the 4 LSPTool write-ops: rename, codeActions (read), apply
 * CodeAction, renameFile. Kept out of LSPTool.ts to keep that file scannable.
 *
 * Each handler:
 *   1. Asks the server (rename, codeAction, willRenameFiles)
 *   2. Normalizes the WorkspaceEdit via workspaceEdit.ts
 *   3. Gates the touched paths through checkBatchWritePermission
 *   4. Applies edits atomically (rollback on failure)
 *   5. Notifies the server via didChange for each modified file
 *   6. Returns a formatted summary
 *
 * `codeActions` is read-only: lists actions and caches them for the
 * follow-up applyCodeAction call.
 */

import { pathToFileURL } from 'node:url'
import type {
  CodeAction,
  CodeActionContext,
  Range,
  WorkspaceEdit,
} from 'vscode-languageserver-types'
import type { LSPServerManager } from '../../services/lsp/LSPServerManager.js'
import { peekPendingDiagnosticsForFile } from '../../services/lsp/LSPDiagnosticRegistry.js'
import { withServerMutex } from '../../services/lsp/serverMutex.js'
import { toError } from '../../utils/errors.js'
import { getFileModificationTimeAsync } from '../../utils/file.js'
import type { FileStateCache } from '../../utils/fileStateCache.js'
import { logError } from '../../utils/log.js'
import {
  cacheCodeAction,
  getCachedCodeAction,
} from './codeActionCache.js'
import {
  type FormattedCodeAction,
  formatCodeActionList,
  formatWorkspaceEditResult,
  isCommandOnlyAction,
} from './formatters.js'
import {
  type ApplyResult,
  applyNormalizedEdit,
  pathsTouchedByEdit,
  resolveWorkspaceEdit,
} from './workspaceEdit.js'
import {
  getPreparedWriteOp,
  invalidatePreparedWriteOp,
  type PrepInput,
} from './writeOpPrep.js'

import type { ToolPermissionContext } from '../../Tool.js'
import { checkBatchWritePermission } from '../../utils/permissions/filesystem.js'
import { LSP_TOOL_NAME } from './prompt.js'

export type WriteOpResult = {
  formatted: string
  resultCount?: number
  fileCount?: number
}

export type WriteOpDeps = {
  manager: LSPServerManager
  toolPermissionContext: ToolPermissionContext
  cwd: string
  /** Optional: when present, post-write sync keeps the cache aligned with
   *  disk so the next FileEdit/FileWrite doesn't trip the "modified since
   *  last read" gate and burn a turn re-reading. */
  readFileState?: FileStateCache
}

function position1to0(line: number, character: number): {
  line: number
  character: number
} {
  return { line: line - 1, character: character - 1 }
}

function rangeFromOneBased(
  startLine: number,
  startChar: number,
  endLine: number | undefined,
  endChar: number | undefined,
): Range {
  const start = position1to0(startLine, startChar)
  const end = position1to0(endLine ?? startLine, endChar ?? startChar)
  return { start, end }
}

async function gateAndApply(
  edit: WorkspaceEdit,
  deps: WriteOpDeps,
  approvedPaths?: ReadonlySet<string>,
): Promise<ApplyResult> {
  const paths = pathsTouchedByEdit(edit)
  // Drift check: if a server response expanded the edit between prep
  // (when the user saw the agg-diff prompt) and apply, the new paths
  // were never approved. Hard stop on any path outside the approved
  // set.
  if (approvedPaths) {
    const drift = paths.filter(p => !approvedPaths.has(p))
    if (drift.length > 0) {
      throw new Error(
        `LSP write-op touched paths not approved at preflight: ${drift.join(', ')}`,
      )
    }
  }
  // Defense-in-depth: by the time call() runs, checkPermissions has
  // already gated the touched paths through the same batch policy and
  // routed `ask` through the UI prompt. Re-check for hard denies (in
  // case a dynamic rule changed mid-flight). `ask` is only a problem
  // when we have NO approvedPaths recorded — otherwise the user already
  // saw the prompt and a one-shot "Allow once" approval doesn't persist
  // into permissionUpdates, so re-policy would spuriously say 'ask'.
  const decision = checkBatchWritePermission(
    LSP_TOOL_NAME,
    paths,
    deps.toolPermissionContext,
  )
  if (decision.behavior === 'deny') {
    throw new Error(decision.message)
  }
  if (decision.behavior === 'ask' && !approvedPaths) {
    throw new Error(
      `LSP write-op needs reconfirmation after preflight cache expired: ${decision.message ?? 'retry the operation to see the aggregated diff.'}`,
    )
  }
  const normalized = resolveWorkspaceEdit(edit)
  if (normalized.hasUnsupported) {
    throw new Error(
      `WorkspaceEdit contains unsupported operations: ${normalized.unsupportedReasons.join('; ')}`,
    )
  }
  return applyNormalizedEdit(normalized, { write: true })
}

/**
 * Apply a write-op using the prep cached by checkPermissions when present,
 * falling back to a fresh request when the cache missed (TTL expired
 * between prep and apply, or call ran without preflight). The prep entry
 * is invalidated post-apply because the on-disk state changed.
 */
async function applyFromPrep(
  prepInput: PrepInput,
  fallback: () => Promise<WorkspaceEdit | null | undefined>,
  deps: WriteOpDeps,
): Promise<ApplyResult | null> {
  let prep = getPreparedWriteOp(prepInput)
  if (!prep) {
    const edit = await fallback()
    if (!edit) return null
    // No approvedPaths → gateAndApply will throw on 'ask' so we don't
    // silently bypass the agg-diff prompt the user never saw.
    const applied = await gateAndApply(edit, deps)
    return applied
  }
  const applied = await gateAndApply(prep.edit, deps, new Set(prep.paths))
  invalidatePreparedWriteOp(prepInput)
  return applied
}

async function notifyServerOfChanges(
  manager: LSPServerManager,
  result: ApplyResult,
  readFileState?: FileStateCache,
): Promise<void> {
  // Skip didChange for paths that are about to be renamed-out: the
  // didRenameFiles close/open below covers them, and notifying the
  // server about content at a URI we're about to delete can leave
  // diagnostics queued against the dead URI in some servers.
  const renamedOldPaths = new Set(result.renamedPaths.map(r => r.oldPath))
  for (const path of result.modifiedPaths) {
    if (renamedOldPaths.has(path)) continue
    const after = result.afterContents.get(path)
    if (after === undefined) continue
    try {
      await manager.changeFile(path, after)
    } catch (e) {
      // didChange failure means the server still has the pre-edit AST.
      // Logging at debug only would mask the divergence and silently
      // produce wrong refactors next turn. Surface visibly and drop our
      // didOpen tracking so the next op re-opens with current contents.
      logError(
        new Error(
          `LSP didChange failed for ${path} after WorkspaceEdit: ${toError(e).message}. Invalidating server state — next LSP op will re-open with disk contents.`,
        ),
      )
      manager.invalidateOpenFile(path)
    }
    // Sync the agent-side readFileState. We only refresh entries the cache
    // already tracks: writing without a prior Read still requires a Read
    // for the next FileEdit (the gate is intentional). For tracked paths,
    // post-write the on-disk state matches `after`, so freezing that pair
    // (content + mtime) prevents the next FileEdit/Write from tripping
    // "modified since last read" and burning a turn re-reading.
    if (readFileState?.has(path)) {
      try {
        readFileState.set(path, {
          content: after,
          timestamp: await getFileModificationTimeAsync(path),
          offset: undefined,
          limit: undefined,
        })
      } catch {
        // stat failed (file racing) — drop the entry so the next
        // FileEdit/Write triggers a fresh Read instead of trusting stale state.
        readFileState.delete(path)
      }
    }
  }
  // Spec 3.16+ workspace/didRenameFiles must follow the move so the server
  // can finalize its index. The manager also rotates local didOpen/didClose
  // tracking so subsequent textDocument requests resolve to the new URI.
  if (result.renamedPaths.length > 0) {
    try {
      await manager.notifyDidRenameFiles(result.renamedPaths)
    } catch (e) {
      // Same rationale as didChange: a failed didRenameFiles leaves the
      // server indexing the old URI. Invalidate both sides so the next op
      // forces a fresh didOpen on the new path.
      logError(
        new Error(
          `LSP didRenameFiles failed: ${toError(e).message}. Invalidating renamed paths — next LSP op will re-open with disk contents.`,
        ),
      )
      for (const r of result.renamedPaths) {
        manager.invalidateOpenFile(r.oldPath)
        manager.invalidateOpenFile(r.newPath)
      }
    }
  }
  // Rename sync: agent had Read'd the file pre-rename → cache key is the
  // old path. Drop the old entry (it points to a non-existent file) so a
  // FileEdit against the old path correctly fails ENOENT instead of
  // appearing "fresh". For the new path we only seed when the rename
  // moved content we already know (afterContents has an entry keyed by
  // oldPath only when the edit also touched it pre-rename — most pure
  // renames don't, so we just stat the new path lazily on next Read).
  if (readFileState && result.renamedPaths.length > 0) {
    for (const r of result.renamedPaths) {
      if (r.oldPath !== r.newPath) {
        readFileState.delete(r.oldPath)
      }
    }
  }
}

// ---------------------------------------------------------------------------
// rename
// ---------------------------------------------------------------------------

export async function handleRename(
  input: {
    filePath: string
    absolutePath: string
    line: number
    character: number
    newName: string
  },
  deps: WriteOpDeps,
): Promise<WriteOpResult> {
  const server = deps.manager.getServerForFile(input.absolutePath)
  const serverName = server?.name ?? 'unknown'
  // Capability gate: skip the round-trip when the server advertises no
  // rename support. Capabilities is undefined until initialize completes —
  // in that window we fall through and let the request play out (the
  // server will respond with null or a MethodNotFound error, surfaced
  // verbatim).
  if (
    server?.capabilities !== undefined &&
    !server.capabilities.renameProvider
  ) {
    return {
      formatted: `Server '${serverName}' does not support textDocument/rename.`,
    }
  }

  return withServerMutex(serverName, async () => {
    const prepInput: PrepInput = {
      operation: 'rename',
      absolutePath: input.absolutePath,
      line: input.line,
      character: input.character,
      newName: input.newName,
    }
    const applied = await applyFromPrep(
      prepInput,
      async () => {
        const uri = pathToFileURL(input.absolutePath).href
        return (await deps.manager.sendRequest(
          input.absolutePath,
          'textDocument/rename',
          {
            textDocument: { uri },
            position: position1to0(input.line, input.character),
            newName: input.newName,
          },
        )) as WorkspaceEdit | null | undefined
      },
      deps,
    )
    if (!applied) {
      return {
        formatted: 'Rename returned no changes (server may not support rename here).',
      }
    }
    await notifyServerOfChanges(deps.manager, applied, deps.readFileState)
    return {
      formatted: formatWorkspaceEditResult(applied, deps.cwd),
      fileCount: applied.modifiedPaths.length,
    }
  })
}

// ---------------------------------------------------------------------------
// codeActions (read-only)
// ---------------------------------------------------------------------------

export async function handleCodeActions(
  input: {
    filePath: string
    absolutePath: string
    line: number
    character: number
    endLine?: number
    endCharacter?: number
    only?: string[]
  },
  deps: WriteOpDeps,
): Promise<WriteOpResult> {
  const server = deps.manager.getServerForFile(input.absolutePath)
  const serverName = server?.name ?? 'unknown'
  if (
    server?.capabilities !== undefined &&
    !server.capabilities.codeActionProvider
  ) {
    return {
      formatted: `Server '${serverName}' does not support textDocument/codeAction.`,
      resultCount: 0,
    }
  }
  const uri = pathToFileURL(input.absolutePath).href
  const range = rangeFromOneBased(
    input.line,
    input.character,
    input.endLine,
    input.endCharacter,
  )
  // LSP CodeActionContext.diagnostics: source from the server's most recent
  // publishDiagnostics for this file so quickfix-style actions ("Add missing
  // import", "Implement interface") surface. Registry only retains pending
  // (undelivered) diagnostics — if a prior turn already drained them, this
  // returns []. Refactor-style actions still appear regardless, and servers
  // that index the file independently (rust-analyzer, gopls) re-attach
  // diagnostics on demand.
  // Severity in the internal registry is a string label; LSP expects the
  // numeric DiagnosticSeverity (1=Error, 2=Warning, 3=Info, 4=Hint).
  const severityMap: Record<string, 1 | 2 | 3 | 4> = {
    Error: 1,
    Warning: 2,
    Info: 3,
    Hint: 4,
  }
  const diagnostics = peekPendingDiagnosticsForFile(uri).map(d => ({
    range: d.range,
    message: d.message,
    severity: severityMap[d.severity],
    source: d.source,
    code: d.code,
  }))
  const context: CodeActionContext = {
    diagnostics,
    only: input.only,
  }

  const actions = (await deps.manager.sendRequest(
    input.absolutePath,
    'textDocument/codeAction',
    {
      textDocument: { uri },
      range,
      context,
    },
  )) as Array<CodeAction> | null | undefined

  const formatted: FormattedCodeAction[] = []
  for (const a of actions ?? []) {
    if (!a || typeof a !== 'object' || !('title' in a)) continue
    // Command-only actions cannot be applied programmatically (we don't
    // proxy `workspace/executeCommand`). Surface them in the list so the
    // agent sees what the server offered, but skip caching so a later
    // applyCodeAction call fails fast with an actionable error instead of
    // silently picking up a useless cache entry.
    const commandOnly = isCommandOnlyAction(a)
    const actionId = commandOnly
      ? `ca_unsupported_${formatted.length}`
      : cacheCodeAction(a, input.absolutePath, serverName)
    formatted.push({
      actionId,
      title: a.title,
      kind: a.kind,
      isPreferred: a.isPreferred,
      disabled: a.disabled?.reason,
      unsupported: commandOnly ? true : undefined,
    })
  }
  return {
    formatted: formatCodeActionList(formatted),
    resultCount: formatted.length,
  }
}

// ---------------------------------------------------------------------------
// applyCodeAction
// ---------------------------------------------------------------------------

export async function handleApplyCodeAction(
  input: { filePath: string; absolutePath: string; actionId: string },
  deps: WriteOpDeps,
): Promise<WriteOpResult> {
  if (input.actionId.startsWith('ca_unsupported_')) {
    throw new Error(
      `This code action is command-only (server only exposes a workspace/executeCommand handler) and cannot be applied programmatically. Open the file in your editor and trigger the action there.`,
    )
  }
  const cached = getCachedCodeAction(input.actionId)
  if (!cached) {
    throw new Error(
      `Unknown or expired actionId: ${input.actionId}. Re-list code actions with codeActions and retry.`,
    )
  }
  if (cached.action.disabled?.reason) {
    throw new Error(
      `Code action "${cached.action.title}" is disabled: ${cached.action.disabled.reason}`,
    )
  }

  return withServerMutex(cached.serverName, async () => {
    const prepInput: PrepInput = {
      operation: 'applyCodeAction',
      absolutePath: input.absolutePath,
      actionId: input.actionId,
    }
    const applied = await applyFromPrep(
      prepInput,
      async () => {
        let action = cached.action
        if (action.edit === undefined && action.data !== undefined) {
          const resolved = (await deps.manager.sendRequest(
            cached.filePath,
            'codeAction/resolve',
            action,
          )) as CodeAction | null | undefined
          if (resolved && resolved.edit) action = resolved
        }
        if (!action.edit) {
          throw new Error(
            `Code action "${action.title}" resolved without a WorkspaceEdit; nothing to apply.`,
          )
        }
        return action.edit
      },
      deps,
    )
    if (!applied) {
      throw new Error(
        `Code action "${cached.action.title}" resolved without a WorkspaceEdit; nothing to apply.`,
      )
    }
    await notifyServerOfChanges(deps.manager, applied, deps.readFileState)
    return {
      formatted: formatWorkspaceEditResult(applied, deps.cwd),
      fileCount: applied.modifiedPaths.length,
    }
  })
}

// ---------------------------------------------------------------------------
// renameFile
// ---------------------------------------------------------------------------

export async function handleRenameFile(
  input: {
    filePath: string
    absolutePath: string
    newPath: string
    absoluteNewPath: string
  },
  deps: WriteOpDeps,
): Promise<WriteOpResult> {
  const server = deps.manager.getServerForFile(input.absolutePath)
  const serverName = server?.name ?? 'unknown'
  // workspace/willRenameFiles is gated by workspace.fileOperations.willRename.
  // If the server hasn't advertised it, asking is guaranteed to fail; refuse
  // up front so the user gets actionable guidance instead of a JSON-RPC error.
  const willRename =
    server?.capabilities?.workspace?.fileOperations?.willRename
  if (server?.capabilities !== undefined && !willRename) {
    throw new Error(
      `Server '${serverName}' does not support workspace/willRenameFiles. ` +
        `Use shell mv with caution — imports will not be updated.`,
    )
  }

  return withServerMutex(serverName, async () => {
    const oldUri = pathToFileURL(input.absolutePath).href
    const newUri = pathToFileURL(input.absoluteNewPath).href
    const prepInput: PrepInput = {
      operation: 'renameFile',
      absolutePath: input.absolutePath,
      absoluteNewPath: input.absoluteNewPath,
    }
    const applied = await applyFromPrep(
      prepInput,
      async () => {
        let edit: WorkspaceEdit | null | undefined
        try {
          edit = (await deps.manager.sendRequest(
            input.absolutePath,
            'workspace/willRenameFiles',
            { files: [{ oldUri, newUri }] },
          )) as WorkspaceEdit | null | undefined
        } catch (e) {
          const msg = toError(e).message
          throw new Error(
            `Server does not support file rename with import updates (workspace/willRenameFiles): ${msg}. Use shell mv with caution — imports will not be updated.`,
          )
        }
        return {
          ...(edit ?? {}),
          documentChanges: [
            ...(edit?.documentChanges ?? []),
            { kind: 'rename', oldUri, newUri },
          ],
        }
      },
      deps,
    )
    if (!applied) {
      return {
        formatted: 'Rename returned no changes.',
      }
    }
    await notifyServerOfChanges(deps.manager, applied, deps.readFileState)
    return {
      formatted: formatWorkspaceEditResult(applied, deps.cwd),
      fileCount: applied.modifiedPaths.length,
    }
  })
}

/**
 * Pre-flight stage for LSPTool write-ops.
 *
 * Permission gating for write-ops (rename / applyCodeAction / renameFile)
 * needs the list of affected paths, which is only knowable after the LSP
 * server answers the corresponding request. Doing the request from inside
 * `call()` makes `behavior: 'ask'` impossible to honor — by the time the
 * tool runs, the permission system has already decided. This module runs
 * the request from `checkPermissions`, caches the normalized result, and
 * lets `call()` reuse it so the LSP server is only asked once.
 *
 * Cache key is a JSON-shape projection of the user-supplied inputs that
 * deterministically identify the write-op. TTL is short to avoid carrying
 * stale results across turns; a miss in `call()` triggers a recompute.
 */

import { pathToFileURL } from 'node:url'
import type {
  CodeAction,
  WorkspaceEdit,
} from 'vscode-languageserver-types'
import type { LSPServerManager } from '../../services/lsp/LSPServerManager.js'
import { logForDebugging } from '../../utils/debug.js'
import { toError } from '../../utils/errors.js'
import { getCachedCodeAction } from './codeActionCache.js'
import {
  type ApplyResult,
  type NormalizedEdit,
  applyNormalizedEdit,
  pathsTouchedByEdit,
  resolveWorkspaceEdit,
} from './workspaceEdit.js'
import { getPatchFromContents } from '../../utils/diff.js'

const TTL_MS = 5 * 60 * 1000
const MAX_ENTRIES = 32

export type PrepInput =
  | {
      operation: 'rename'
      absolutePath: string
      line: number
      character: number
      newName: string
    }
  | {
      operation: 'applyCodeAction'
      absolutePath: string
      actionId: string
    }
  | {
      operation: 'renameFile'
      absolutePath: string
      absoluteNewPath: string
    }

export type PreparedWriteOp = {
  /** Server name that owns the edit — used for mutex routing in call(). */
  serverName: string
  /** Final composite edit ready to apply. */
  edit: WorkspaceEdit
  /** Normalized edit (overlap-checked, sorted) ready for the applier. */
  normalized: NormalizedEdit
  /** Unique absolute paths the apply will touch. */
  paths: string[]
  /** Resolved CodeAction (post codeAction/resolve) when prep was for applyCodeAction. */
  resolvedAction?: CodeAction
  storedAt: number
}

const cache = new Map<string, PreparedWriteOp>()

function cacheKey(input: PrepInput): string {
  return JSON.stringify(input)
}

function evictExpired(now: number): void {
  for (const [key, entry] of cache) {
    if (now - entry.storedAt > TTL_MS) cache.delete(key)
  }
}

function evictOldestIfFull(): void {
  if (cache.size < MAX_ENTRIES) return
  const firstKey = cache.keys().next().value
  if (firstKey !== undefined) cache.delete(firstKey)
}

export function getPreparedWriteOp(input: PrepInput): PreparedWriteOp | undefined {
  const key = cacheKey(input)
  const entry = cache.get(key)
  if (!entry) return undefined
  if (Date.now() - entry.storedAt > TTL_MS) {
    cache.delete(key)
    return undefined
  }
  return entry
}

export function invalidatePreparedWriteOp(input: PrepInput): void {
  cache.delete(cacheKey(input))
}

function store(input: PrepInput, prep: PreparedWriteOp): void {
  const now = Date.now()
  evictExpired(now)
  evictOldestIfFull()
  cache.set(cacheKey(input), { ...prep, storedAt: now })
}

export type PrepDeps = {
  manager: LSPServerManager
}

/**
 * Compute the WorkspaceEdit the server would emit for this write-op and
 * normalize it, without writing anything. Returns null when the server
 * has nothing to do (rename returned no changes) — the caller surfaces
 * that as a no-op result.
 */
export async function prepareWriteOp(
  input: PrepInput,
  deps: PrepDeps,
): Promise<PreparedWriteOp | null> {
  const cached = getPreparedWriteOp(input)
  if (cached) return cached

  const prep = await computePrep(input, deps)
  if (prep) store(input, prep)
  return prep
}

async function computePrep(
  input: PrepInput,
  deps: PrepDeps,
): Promise<PreparedWriteOp | null> {
  const server = deps.manager.getServerForFile(input.absolutePath)
  const serverName = server?.name ?? 'unknown'

  let edit: WorkspaceEdit | null | undefined
  let resolvedAction: CodeAction | undefined

  if (input.operation === 'rename') {
    if (
      server?.capabilities !== undefined &&
      !server.capabilities.renameProvider
    ) {
      // No capability — surface as no-op so checkPermissions doesn't fail
      // a request that hasn't even been attempted yet. call() will emit
      // the user-facing capability message.
      return null
    }
    const uri = pathToFileURL(input.absolutePath).href
    edit = (await deps.manager.sendRequest(
      input.absolutePath,
      'textDocument/rename',
      {
        textDocument: { uri },
        position: { line: input.line - 1, character: input.character - 1 },
        newName: input.newName,
      },
    )) as WorkspaceEdit | null | undefined
  } else if (input.operation === 'applyCodeAction') {
    const cachedAction = getCachedCodeAction(input.actionId)
    if (!cachedAction) {
      // Let call() emit the canonical "unknown actionId" error.
      return null
    }
    let action = cachedAction.action
    if (action.edit === undefined && action.data !== undefined) {
      try {
        const resolved = (await deps.manager.sendRequest(
          cachedAction.filePath,
          'codeAction/resolve',
          action,
        )) as CodeAction | null | undefined
        if (resolved && resolved.edit) action = resolved
      } catch (e) {
        logForDebugging(
          `codeAction/resolve failed in prep: ${toError(e).message}`,
        )
        return null
      }
    }
    if (!action.edit) return null
    resolvedAction = action
    edit = action.edit
  } else {
    // renameFile
    const willRename =
      server?.capabilities?.workspace?.fileOperations?.willRename
    if (server?.capabilities !== undefined && !willRename) {
      return null
    }
    const oldUri = pathToFileURL(input.absolutePath).href
    const newUri = pathToFileURL(input.absoluteNewPath).href
    try {
      edit = (await deps.manager.sendRequest(
        input.absolutePath,
        'workspace/willRenameFiles',
        { files: [{ oldUri, newUri }] },
      )) as WorkspaceEdit | null | undefined
    } catch (e) {
      logForDebugging(
        `workspace/willRenameFiles failed in prep: ${toError(e).message}`,
      )
      return null
    }
    // The disk rename itself is part of the composite edit so the
    // batch-permission gate sees both the import-edit paths and the
    // old/new path.
    edit = {
      ...(edit ?? {}),
      documentChanges: [
        ...(edit?.documentChanges ?? []),
        { kind: 'rename', oldUri, newUri },
      ],
    }
  }

  if (!edit) return null
  const normalized = resolveWorkspaceEdit(edit)
  if (normalized.hasUnsupported) {
    // Defer the surface to call() so the user gets the same message
    // regardless of whether prep ran or not.
    return null
  }
  const paths = pathsTouchedByEdit(edit)

  return {
    serverName,
    edit,
    normalized,
    paths,
    resolvedAction,
    storedAt: 0,
  }
}

/**
 * Read before-contents for every path the prep will touch and produce a
 * single concatenated unified-diff preview for the permission prompt.
 * Truncated to `maxLines`.
 *
 * Pure read; never mutates disk. Surfaces failures inline so the prompt
 * still shows something useful when one file in the batch is unreadable.
 */
export async function buildAggregatedDiffPreview(
  prep: PreparedWriteOp,
  options: { maxLines: number } = { maxLines: 50 },
): Promise<string> {
  let result: ApplyResult
  try {
    // Dry-run apply: returns before/after maps without writing.
    result = await applyNormalizedEdit(prep.normalized, { write: false })
  } catch (e) {
    return `(diff preview unavailable: ${toError(e).message})`
  }

  const sections: string[] = []
  for (const filePath of result.modifiedPaths) {
    const before = result.beforeContents.get(filePath) ?? ''
    const after = result.afterContents.get(filePath) ?? ''
    if (before === after) continue
    const hunks = getPatchFromContents({
      filePath,
      oldContent: before,
      newContent: after,
    })
    const block: string[] = [`--- ${filePath}`]
    for (const h of hunks) {
      block.push(
        `@@ -${h.oldStart},${h.oldLines} +${h.newStart},${h.newLines} @@`,
      )
      for (const line of h.lines) block.push(line)
    }
    sections.push(block.join('\n'))
  }
  if (result.renamedPaths.length > 0) {
    const renames = result.renamedPaths
      .map(r => `${r.oldPath} -> ${r.newPath}`)
      .join('\n')
    sections.push(`Renames:\n${renames}`)
  }

  const joined = sections.join('\n\n')
  if (joined.length === 0) return '(no diff changes)'

  const allLines = joined.split('\n')
  if (allLines.length <= options.maxLines) return joined
  const head = allLines.slice(0, options.maxLines).join('\n')
  const remaining = allLines.length - options.maxLines
  return `${head}\n... (${remaining} more line${remaining === 1 ? '' : 's'})`
}

/** Test-only. */
export function __resetWriteOpPrepCacheForTests(): void {
  cache.clear()
}

/** Test-only. Inject a hand-crafted prep entry to exercise drift paths. */
export function __setPreparedWriteOpForTests(
  input: PrepInput,
  prep: PreparedWriteOp,
): void {
  cache.set(cacheKey(input), { ...prep, storedAt: Date.now() })
}

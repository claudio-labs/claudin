import chalk from 'chalk'
import { dirname } from 'node:path'
import {
  addDirHelpMessage,
  type ResolveDirectoryResult,
  resolveExistingDirectory,
} from 'src/commands/add-dir/validation.js'
import type { LocalJSXCommandContext } from 'src/commands/commands.js'
import { applyPermissionUpdate } from 'src/permissions/PermissionUpdate.js'
import { pathInWorkingPath } from 'src/permissions/filesystem.js'
import {
  getAdditionalDirectoriesForClaudeMd,
  getPendingSessionWakeup,
  setAdditionalDirectoriesForClaudeMd,
} from 'src/platform/bootstrap/state.js'
import { SandboxManager } from 'src/platform/sandbox/sandbox-adapter.js'
import {
  getPreviousSessionDir,
  type RerootResult,
  rerootSession,
} from 'src/sessions/rerootSession.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { logError } from 'src/shared/log.js'
import type { LocalCommandResult } from 'src/shared/types/command.js'
import {
  getCurrentWorktreeSession,
  type WorktreeSession,
} from 'src/vcs/git/worktree.js'

export type CdTarget =
  | { kind: 'empty' }
  | { kind: 'previous' }
  | { kind: 'path'; path: string }

export function parseCdTarget(args: string): CdTarget {
  const trimmed = args.trim()
  if (!trimmed) {
    return { kind: 'empty' }
  }
  if (trimmed === '-') {
    return { kind: 'previous' }
  }
  return { kind: 'path', path: trimmed }
}

export function formatCdResult(
  result: RerootResult,
  keptPreviousDir: boolean,
  cancelledWakeup: boolean,
): string {
  const notes = [
    keptPreviousDir
      ? `${result.previousCwd} kept accessible for this session`
      : null,
    'transcript stays under the original project',
    cancelledWakeup ? 'cancelled the pending /loop wakeup' : null,
    '/cd - to return',
  ].filter(note => note !== null)
  return `Moved this session to ${chalk.bold(result.newCwd)}\n${chalk.dim(notes.join(' · '))}`
}

export type CdDeps = {
  currentWorktreeSession: () => WorktreeSession | null
  resolveDirectory: (path: string) => Promise<ResolveDirectoryResult>
  reroot: (dir: string) => RerootResult
  previousDir: () => string | null
  hasPendingWakeup: () => boolean
  currentCwd: () => string
  refreshSandbox: () => void
}

const defaultDeps: CdDeps = {
  currentWorktreeSession: getCurrentWorktreeSession,
  resolveDirectory: resolveExistingDirectory,
  reroot: rerootSession,
  previousDir: getPreviousSessionDir,
  hasPendingWakeup: () => getPendingSessionWakeup() !== null,
  currentCwd: getCwd,
  refreshSandbox: () => SandboxManager.refreshConfig(),
}

function text(value: string): LocalCommandResult {
  return { type: 'text', value }
}

export async function call(
  args: string,
  context: LocalJSXCommandContext,
  deps: CdDeps = defaultDeps,
): Promise<LocalCommandResult> {
  const target = parseCdTarget(args)
  if (target.kind === 'empty') {
    return text(
      `Usage: ${chalk.bold('/cd <path>')} — moves this session to another directory.\n${chalk.dim('/cd - returns to the previous one.')}`,
    )
  }

  // A worktree session owns its own enter/exit bookkeeping (and the sandbox
  // resolves the main repo once, assuming it cannot change mid-session), so
  // leaving one sideways would strand both.
  if (deps.currentWorktreeSession()) {
    return text(
      `This session is inside a worktree. Use ${chalk.bold('ExitWorktree')} to leave it first, then ${chalk.bold('/cd')}.`,
    )
  }

  let requestedPath: string
  if (target.kind === 'previous') {
    const previous = deps.previousDir()
    if (!previous) {
      return text(
        'This session has not moved yet, so there is no previous directory.',
      )
    }
    requestedPath = previous
  } else {
    requestedPath = target.path
  }

  const resolved = await deps.resolveDirectory(requestedPath)
  if (resolved.resultType !== 'success') {
    // addDirHelpMessage phrases this one as "did you mean to *add* the parent
    // directory", which is /add-dir's question, not /cd's.
    if (resolved.resultType === 'notADirectory') {
      return text(
        `${chalk.bold(resolved.directoryPath)} is not a directory. Did you mean ${chalk.bold(dirname(resolved.absolutePath))}?`,
      )
    }
    return text(addDirHelpMessage(resolved))
  }
  if (resolved.absolutePath === deps.currentCwd()) {
    return text(`Already in ${chalk.bold(resolved.absolutePath)}.`)
  }

  const cancelledWakeup = deps.hasPendingWakeup()
  let moved: RerootResult
  try {
    moved = deps.reroot(resolved.absolutePath)
  } catch (e) {
    const message = e instanceof Error ? e.message : 'Unknown error'
    logError(new Error(`/cd failed to move to ${resolved.absolutePath}: ${message}`))
    return text(
      `Could not move to ${chalk.bold(resolved.absolutePath)}: ${message}`,
    )
  }

  // The move re-rooted permissions onto the new directory, so keep the old one
  // reachable for the rest of the session — paths the conversation already
  // refers to would otherwise start prompting. Session-scoped, never persisted.
  const keptPreviousDir = !pathInWorkingPath(moved.previousCwd, moved.newCwd)
  if (keptPreviousDir) {
    const updatedContext = applyPermissionUpdate(
      context.getAppState().toolPermissionContext,
      {
        type: 'addDirectories',
        directories: [moved.previousCwd],
        destination: 'session',
      },
    )
    context.setAppState(prev => ({
      ...prev,
      toolPermissionContext: updatedContext,
    }))
    const currentDirs = getAdditionalDirectoriesForClaudeMd()
    if (!currentDirs.includes(moved.previousCwd)) {
      setAdditionalDirectoriesForClaudeMd([...currentDirs, moved.previousCwd])
    }
  }
  // Both directories changed for Bash: the new root, and the old one as an
  // additional directory.
  deps.refreshSandbox()

  return text(formatCdResult(moved, keptPreviousDir, cancelledWakeup))
}

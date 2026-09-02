import chalk from 'chalk'
import { stat } from 'fs/promises'
import { dirname, resolve } from 'path'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { expandPath } from 'src/shared/fs/path.js'
import {
  allWorkingDirectories,
  pathInWorkingPath,
} from 'src/permissions/filesystem.js'

export type ResolveDirectoryResult =
  | {
      resultType: 'success'
      absolutePath: string
    }
  | {
      resultType: 'emptyPath'
    }
  | {
      resultType: 'pathNotFound' | 'notADirectory'
      directoryPath: string
      absolutePath: string
    }

export type AddDirectoryResult =
  | ResolveDirectoryResult
  | {
      resultType: 'alreadyInWorkingDirectory'
      directoryPath: string
      workingDir: string
    }

/**
 * Resolve a user-supplied path to an existing directory.
 *
 * Shared by /add-dir and /cd. The "already inside a working directory" check
 * sits on top of this in validateDirectoryForWorkspace() rather than here,
 * because for /cd that is the normal case, not an error.
 */
export async function resolveExistingDirectory(
  directoryPath: string,
): Promise<ResolveDirectoryResult> {
  if (!directoryPath) {
    return {
      resultType: 'emptyPath',
    }
  }

  // resolve() strips the trailing slash expandPath can leave on absolute
  // inputs, so /foo and /foo/ map to the same storage key (CC-33).
  const absolutePath = resolve(expandPath(directoryPath))

  // Check if path exists and is a directory (single syscall)
  try {
    const stats = await stat(absolutePath)
    if (!stats.isDirectory()) {
      return {
        resultType: 'notADirectory',
        directoryPath,
        absolutePath,
      }
    }
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    // Match prior existsSync() semantics: treat any of these as "not found"
    // rather than re-throwing. EACCES/EPERM in particular must not crash
    // startup when a settings-configured additional directory is inaccessible.
    if (
      code === 'ENOENT' ||
      code === 'ENOTDIR' ||
      code === 'EACCES' ||
      code === 'EPERM'
    ) {
      return {
        resultType: 'pathNotFound',
        directoryPath,
        absolutePath,
      }
    }
    throw e
  }

  return {
    resultType: 'success',
    absolutePath,
  }
}

export async function validateDirectoryForWorkspace(
  directoryPath: string,
  permissionContext: ToolPermissionContext,
): Promise<AddDirectoryResult> {
  const resolved = await resolveExistingDirectory(directoryPath)
  if (resolved.resultType !== 'success') {
    return resolved
  }

  // Get current permission context
  const currentWorkingDirs = allWorkingDirectories(permissionContext)

  // Check if already within an existing working directory
  for (const workingDir of currentWorkingDirs) {
    if (pathInWorkingPath(resolved.absolutePath, workingDir)) {
      return {
        resultType: 'alreadyInWorkingDirectory',
        directoryPath,
        workingDir,
      }
    }
  }

  return resolved
}

export function addDirHelpMessage(result: AddDirectoryResult): string {
  switch (result.resultType) {
    case 'emptyPath':
      return 'Please provide a directory path.'
    case 'pathNotFound':
      return `Path ${chalk.bold(result.absolutePath)} was not found.`
    case 'notADirectory': {
      const parentDir = dirname(result.absolutePath)
      return `${chalk.bold(result.directoryPath)} is not a directory. Did you mean to add the parent directory ${chalk.bold(parentDir)}?`
    }
    case 'alreadyInWorkingDirectory':
      return `${chalk.bold(result.directoryPath)} is already accessible within the existing working directory ${chalk.bold(result.workingDir)}.`
    case 'success':
      return `Added ${chalk.bold(result.absolutePath)} as a working directory.`
  }
}

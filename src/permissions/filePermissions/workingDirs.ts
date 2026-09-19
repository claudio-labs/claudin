import memoize from 'lodash-es/memoize.js'
import { posix } from 'path'
import { normalizeCaseForComparison } from 'src/permissions/filePermissions/pathCase.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getPathsForPermissionCheck } from 'src/shared/fs/fsOperations.js'
import {
  containsPathTraversal,
  expandPath,
  relativePath,
} from 'src/shared/fs/path.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

export function allWorkingDirectories(
  context: ToolPermissionContext,
): Set<string> {
  return new Set([
    getOriginalCwd(),
    ...context.additionalWorkingDirectories.keys(),
  ])
}

// Working directories are session-stable; memoize their resolved forms to
// avoid repeated existsSync/lstatSync/realpathSync syscalls on every
// permission check. Keyed by path string — getPathsForPermissionCheck is
// deterministic for existing directories within a session.
const getResolvedWorkingDirPaths = memoize(getPathsForPermissionCheck)

export function pathInAllowedWorkingPath(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): boolean {
  // Check both the original path and the resolved symlink path
  const pathsToCheck =
    precomputedPathsToCheck ?? getPathsForPermissionCheck(path)

  // Resolve working directories the same way we resolve input paths so
  // comparisons are symmetric. Without this, a resolved input path
  // (e.g. /System/Volumes/Data/home/... on macOS) would not match an
  // unresolved working directory (/home/...), causing false denials.
  const workingPaths = Array.from(
    allWorkingDirectories(toolPermissionContext),
  ).flatMap(wp => getResolvedWorkingDirPaths(wp))

  // All paths must be within allowed working paths
  // If any resolved path is outside, deny access
  return pathsToCheck.every(pathToCheck =>
    workingPaths.some(workingPath =>
      pathInWorkingPath(pathToCheck, workingPath),
    ),
  )
}

export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const absolutePath = expandPath(path)
  const absoluteWorkingPath = expandPath(workingPath)

  // On macOS, handle common symlink issues:
  // - /var -> /private/var
  // - /tmp -> /private/tmp
  const normalizedPath = absolutePath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')
  const normalizedWorkingPath = absoluteWorkingPath
    .replace(/^\/private\/var\//, '/var/')
    .replace(/^\/private\/tmp(\/|$)/, '/tmp$1')

  // Normalize case for case-insensitive comparison to prevent bypassing security
  // checks on case-insensitive filesystems (macOS/Windows) like .cLauDe/CoMmAnDs
  const caseNormalizedPath = normalizeCaseForComparison(normalizedPath)
  const caseNormalizedWorkingPath = normalizeCaseForComparison(
    normalizedWorkingPath,
  )

  // Use cross-platform relative path helper
  const relative = relativePath(caseNormalizedWorkingPath, caseNormalizedPath)

  // Same path
  if (relative === '') {
    return true
  }

  if (containsPathTraversal(relative)) {
    return false
  }

  // Path is inside (relative path that doesn't go up)
  return !posix.isAbsolute(relative)
}

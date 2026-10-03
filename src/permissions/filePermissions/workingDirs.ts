import { normalizeCaseForComparison } from 'src/permissions/filePermissions/pathCase.js'
import {
  formsOf,
  settledFormsOf,
  type PathForms,
} from 'src/permissions/filePermissions/pathForms.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
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

/**
 * True when every form of `path` lies inside some form of some working
 * directory. Forms passed by the caller are trusted as they are; an empty list
 * proves nothing, so it never counts as inside.
 */
export function pathInAllowedWorkingPath(
  path: string,
  toolPermissionContext: ToolPermissionContext,
  precomputedPathsToCheck?: readonly string[],
): boolean {
  const forms = precomputedPathsToCheck ?? formsOf(path)
  if (forms.length === 0) return false

  const roots: PathForms = [
    ...allWorkingDirectories(toolPermissionContext),
  ].flatMap(settledFormsOf)
  return forms.every(form => roots.some(root => pathInWorkingPath(form, root)))
}

/**
 * Lexical containment: `.`/`..` and `~` are applied, symlinks are not
 * followed, and case is ignored.
 */
export function pathInWorkingPath(path: string, workingPath: string): boolean {
  const child = comparable(path)
  const parent = comparable(workingPath)
  const route = relativePath(parent, child)
  if (route === '') return true
  return !containsPathTraversal(route) && !route.startsWith('/')
}

/** Absolute, folded, and with the macOS `/private` temp aliases removed. */
function comparable(path: string): string {
  return withoutPrivateAlias(normalizeCaseForComparison(expandPath(path)))
}

// macOS reaches /tmp and /var through /private. Only the spellings that name
// the directory or something below it are mapped: `/private/var` alone is
// left as is, and so is any name that merely starts with `tmp` or `var`.
function withoutPrivateAlias(path: string): string {
  const aliased =
    path === '/private/tmp' ||
    path.startsWith('/private/tmp/') ||
    path.startsWith('/private/var/')
  return aliased ? path.slice('/private'.length) : path
}

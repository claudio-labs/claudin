import { getPathsForPermissionCheck } from 'src/shared/fs/fsOperations.js'

/**
 * Every spelling a path reaches: as given (with `~` expanded), each hop of a
 * symlink chain, its final target and, for a path that does not exist yet,
 * where its deepest existing ancestor really lives.
 */
export type PathForms = readonly string[]

export function formsOf(path: string): PathForms {
  return getPathsForPermissionCheck(path)
}

const settledForms = new Map<string, PathForms>()

/**
 * The forms of a configured location (a working directory, a sandbox entry),
 * resolved once per path string for the life of the process. A link that is
 * re-pointed later keeps its first resolution.
 */
export function settledFormsOf(path: string): PathForms {
  let forms = settledForms.get(path)
  if (forms === undefined) {
    forms = formsOf(path)
    settledForms.set(path, forms)
  }
  return forms
}

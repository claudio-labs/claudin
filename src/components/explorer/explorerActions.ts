/**
 * Pure helpers for the /explorer create/rename actions. Framework-free (no
 * React/Ink) so they're unit-testable under `bun test` — ExplorerDialog.tsx
 * itself reaches ../ink.js and can't be imported in tests.
 */

import { dirname, relative, resolve, sep } from 'path'
import type { TreeRow } from 'src/components/diff/fileTree.js'

/** A dir row's key is `${root}\u0000${relDir}` (see fileTree.ts flattenDir). */
const NUL = '\u0000'

/**
 * Directory prefix (with trailing '/') to prefill the new-file prompt from the
 * currently selected row: a file's parent dir, a dir's own path, or '' at root.
 */
export function createPrefill(row: TreeRow | undefined, root: string): string {
  if (!row) return ''
  if (row.kind === 'file') {
    const d = dirname(row.file.path)
    return d === '.' ? '' : `${d}/`
  }
  if (row.kind === 'dir') {
    const prefix = `${root}${NUL}`
    const rel = row.key.startsWith(prefix) ? row.key.slice(prefix.length) : ''
    return rel ? `${rel}/` : ''
  }
  return '' // group row
}

export type ResolvedNewPath =
  | { ok: true; relPath: string; fullPath: string }
  | { ok: false; message: string }

/**
 * Validate a typed file path for create/rename: non-empty, names a file (not a
 * trailing-slash directory), and stays under the project root. Returns the
 * normalized project-relative path plus the absolute target.
 */
export function resolveNewFilePath(root: string, raw: string): ResolvedNewPath {
  const value = raw.trim()
  if (!value) return { ok: false, message: 'Empty file name' }
  if (value.endsWith('/')) return { ok: false, message: 'Not a file name' }
  const fullPath = resolve(root, value)
  const rootWithSep = root.endsWith(sep) ? root : root + sep
  if (fullPath !== root && !fullPath.startsWith(rootWithSep)) {
    return { ok: false, message: 'Path escapes project root' }
  }
  return { ok: true, relPath: relative(root, fullPath), fullPath }
}

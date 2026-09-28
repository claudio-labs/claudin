/**
 * How the directory walk compares paths: normalized, in NFC (a home path may
 * arrive in another form), case-insensitive on Windows, by whole segments.
 */
import { sep } from 'path'

import { normalizePathForComparison } from 'src/shared/fs/file.js'

function comparable(path: string): string {
  return normalizePathForComparison(path.normalize('NFC'))
}

export function isSamePath(a: string, b: string): boolean {
  return comparable(a) === comparable(b)
}

/** Whether `inner` lies below `outer`. `<root>-tools` does not lie below `<root>`. */
export function isStrictlyInside(inner: string, outer: string): boolean {
  const innerPath = comparable(inner)
  const outerPath = comparable(outer)
  const outerPrefix = outerPath.endsWith(sep) ? outerPath : `${outerPath}${sep}`
  return innerPath !== outerPath && innerPath.startsWith(outerPrefix)
}

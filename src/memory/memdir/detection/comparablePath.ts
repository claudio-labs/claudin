import { posix, win32 } from 'path'

export type PathPlatform = 'posix' | 'windows'

const BACKSLASH_RE = /\\/g
const TRAILING_SLASHES_RE = /\/+$/

/**
 * One spelling per location, so paths can be compared as strings: dot
 * segments resolved and `/` as the separator, with case folded on Windows,
 * where the filesystem ignores it.
 */
export function comparablePath(path: string, platform: PathPlatform): string {
  if (platform === 'posix') return posix.normalize(path)
  return win32.normalize(path).replace(BACKSLASH_RE, '/').toLowerCase()
}

/** Free text such as a shell command, folded the same way on Windows. */
export function comparableText(text: string, platform: PathPlatform): string {
  if (platform === 'posix') return text
  return text.replace(BACKSLASH_RE, '/').toLowerCase()
}

export function withoutTrailingSlashes(path: string): string {
  return path.replace(TRAILING_SLASHES_RE, '')
}

/** Both comparable. The directory itself is not below itself. */
export function isStrictlyBelow(path: string, dir: string): boolean {
  const prefix = `${withoutTrailingSlashes(dir)}/`
  return path.startsWith(prefix) && path.length > prefix.length
}

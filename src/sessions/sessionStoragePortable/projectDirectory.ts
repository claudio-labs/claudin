import { join } from 'path'
import { djb2Hash } from 'src/shared/data/hash.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'

const NOT_NAME_UNIT = /[^A-Za-z0-9]/g
const MAX_NAME_LENGTH = 200

// The native binary installed from npm runs on Bun and has always named long
// directories with Bun's hash; the Node bundle, its fallback, with djb2. Both
// stay: settling on one would orphan the sessions stored under the other.
function longNameSuffix(name: string): string {
  if (typeof Bun === 'undefined') return Math.abs(djb2Hash(name)).toString(36)
  return Bun.hash(name).toString(36)
}

/**
 * A directory name for `name`: every UTF-16 unit that is not an ASCII letter
 * or digit becomes `-`, so no name can hold a separator or climb out. Past 200
 * characters it is cut and suffixed with a hash of the original name.
 */
export function sanitizePath(name: string): string {
  const sanitized = name.replace(NOT_NAME_UNIT, '-')
  if (sanitized.length <= MAX_NAME_LENGTH) return sanitized
  return `${sanitized.slice(0, MAX_NAME_LENGTH)}-${longNameSuffix(name)}`
}

export function getProjectsDir(): string {
  return join(getClaudinConfigHomeDir(), 'projects')
}

/** Where the sessions of `projectDir` live, worked out at every call. */
export function getProjectDir(projectDir: string): string {
  return join(getProjectsDir(), sanitizePath(projectDir))
}

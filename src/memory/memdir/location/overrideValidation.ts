import * as nodePath from 'path'

/** The path functions validation needs; `path.win32` exercises the Windows rules on any host. */
export type PathApi = Pick<
  typeof nodePath,
  'isAbsolute' | 'join' | 'normalize' | 'sep'
>

type OverrideRejection =
  | 'not-a-string'
  | 'empty'
  | 'nul-byte'
  | 'home-or-above'
  | 'relative'
  | 'drive-root'
  | 'too-short'
  | 'unc-path'

export type OverrideCheck =
  | { readonly ok: true; readonly dir: string }
  | { readonly ok: false; readonly reason: OverrideRejection }

export type OverrideOptions = {
  /** The setting expands `~/`; the environment variable takes paths as written. */
  readonly expandHome: boolean
  readonly homeDir: string
  readonly paths?: PathApi
}

const HOME_PREFIX_RE = /^~[/\\]/
const DRIVE_ONLY_RE = /^[A-Za-z]:$/
const POSIX_TRAILING_SEPARATORS_RE = /\/+$/
const WINDOWS_TRAILING_SEPARATORS_RE = /[/\\]+$/
const MIN_DIR_LENGTH = 3

/**
 * The memory directory is auto-approved for reads and writes, so an override
 * that resolves to a root, a share or the home directory would widen that
 * grant to far more than a memory folder.
 */
export function validateMemoryDirOverride(
  raw: unknown,
  options: OverrideOptions,
): OverrideCheck {
  const paths = options.paths ?? nodePath
  if (typeof raw !== 'string') return rejected('not-a-string')
  if (raw === '') return rejected('empty')
  if (raw.includes('\0')) return rejected('nul-byte')

  let candidate = raw
  if (options.expandHome) {
    const expanded = expandHome(raw, options.homeDir, paths)
    if (expanded === null) return rejected('home-or-above')
    candidate = expanded
  }

  const normalized = paths.normalize(candidate)
  if (!paths.isAbsolute(normalized)) return rejected('relative')
  const dir = stripTrailingSeparators(normalized, paths)
  if (DRIVE_ONLY_RE.test(dir)) return rejected('drive-root')
  if (dir.length < MIN_DIR_LENGTH) return rejected('too-short')
  if (dir.startsWith('\\\\') || dir.startsWith('//')) {
    return rejected('unc-path')
  }
  return { ok: true, dir }
}

export function stripTrailingSeparators(path: string, paths: PathApi): string {
  const trailing =
    paths.sep === '\\'
      ? WINDOWS_TRAILING_SEPARATORS_RE
      : POSIX_TRAILING_SEPARATORS_RE
  return path.replace(trailing, '')
}

/** `null` when the value names the home directory or one of its ancestors. */
function expandHome(
  raw: string,
  homeDir: string,
  paths: PathApi,
): string | null {
  if (raw === '~') return null
  if (!HOME_PREFIX_RE.test(raw)) return raw
  const expanded = stripTrailingSeparators(
    paths.normalize(paths.join(homeDir, raw.slice(2))),
    paths,
  )
  const home = stripTrailingSeparators(paths.normalize(homeDir), paths)
  const coversHome =
    expanded === '' ||
    expanded === home ||
    home.startsWith(`${expanded}${paths.sep}`)
  return coversHome ? null : expanded
}

function rejected(reason: OverrideRejection): OverrideCheck {
  return { ok: false, reason }
}

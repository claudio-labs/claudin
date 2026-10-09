import { join, resolve, sep } from 'path'
import {
  ENTRYPOINT_NAME,
  MEMORY_SCOPES,
  type MemoryScope,
  withoutTrailingSep,
} from 'src/memory/memdir/memoryScopes.js'
import {
  getAutoMemPath,
  getGlobalMemPath,
  isAutoMemoryEnabled,
  isGlobalMemoryEnabled,
} from 'src/memory/memdir/paths.js'
import { getTeamMemPath } from 'src/memory/memdir/teamMemPaths.js'
import {
  getFsImplementation,
  getPathsForPermissionCheck,
} from 'src/shared/fs/fsOperations.js'

/**
 * The memory directories of this session, decided once: which are on, where
 * each is, and which one a path is in. Everything that asks "is this a
 * memory, and whose?" — the permission carve-outs, the format guard, the
 * forks' tool gate, the transcript, /memory — asks here.
 *
 * Memory off means no directory. The private and team directories are on
 * together (the team one is nested in the private one); the global one also
 * follows isGlobalMemoryEnabled.
 */
export type MemoryDir = {
  scope: MemoryScope
  /** Absolute, with a trailing separator. */
  root: string
  /** Its `MEMORY.md`. */
  index: string
}

function rootOf(scope: MemoryScope): string {
  switch (scope) {
    case 'global':
      return getGlobalMemPath()
    case 'private':
      return getAutoMemPath()
    case 'team':
      return getTeamMemPath()
  }
}

/** Where `scope`'s index is, whether or not the directory is in use. */
export function memoryIndexPath(scope: MemoryScope): string {
  return join(rootOf(scope), ENTRYPOINT_NAME)
}

/** The directories in use, general to specific (MEMORY_SCOPES order). */
export function getMemoryDirs(): MemoryDir[] {
  if (!isAutoMemoryEnabled()) return []
  return MEMORY_SCOPES.filter(
    scope => scope !== 'global' || isGlobalMemoryEnabled(),
  ).map(scope => ({ scope, root: rootOf(scope), index: memoryIndexPath(scope) }))
}

export function getMemoryDir(scope: MemoryScope): MemoryDir | null {
  return getMemoryDirs().find(dir => dir.scope === scope) ?? null
}

/**
 * The directory of `dirs` that `path` is in, or null. The deepest root wins:
 * the team directory sits inside the private one, and a file in it is team
 * memory. Pure, for callers that test with directories of their own.
 * SECURITY: resolve() makes the path absolute and folds `..`, so
 * `team/../../x` is judged where it lands, not where it starts.
 */
export function findMemoryDir(
  dirs: readonly MemoryDir[],
  path: string,
): MemoryDir | null {
  const abs = resolve(path)
  let found: MemoryDir | null = null
  for (const dir of dirs) {
    if (abs.startsWith(dir.root) && (found === null || dir.root.length > found.root.length)) {
      found = dir
    }
  }
  return found
}

/** The scope of the session's directory that `path` is in, or null. */
export function memoryScopeOf(path: string): MemoryScope | null {
  return findMemoryDir(getMemoryDirs(), path)?.scope ?? null
}

function realRoot(root: string): string | null {
  try {
    return (getFsImplementation().realpathSync(root) + sep).normalize('NFC')
  } catch {
    return null
  }
}

/**
 * Where `dir` really is, when that may stand for it: a directory nested in
 * another (team in private) only if it really is inside its parent — a
 * committed `.claudin/memory/team` symlink to elsewhere must not move it.
 */
function trustedRealRoot(dir: MemoryDir, dirs: readonly MemoryDir[]): string | null {
  const real = realRoot(dir.root)
  const parent = findMemoryDir(
    dirs.filter(other => other !== dir),
    dir.root,
  )
  if (real === null || parent === null) return real
  const parentReal = realRoot(parent.root)
  return parentReal !== null && real.startsWith(parentReal) ? real : null
}

/**
 * The scope of `path` for a permission decision — the no-prompt carve-out
 * (internalPaths.ts). SECURITY: the path, every symlink it resolves through
 * and its final target (getPathsForPermissionCheck) must all lie in that one
 * directory, as written or where it really is; a symlink inside a memory
 * directory that leads out of it gets no carve-out.
 */
export function memoryScopeForPermission(path: string): MemoryScope | null {
  const dirs = getMemoryDirs()
  const dir = findMemoryDir(dirs, path)
  if (dir === null) return null
  const roots = [dir.root, trustedRealRoot(dir, dirs)].filter(
    (root): root is string => root !== null,
  )
  const inside = (p: string) => roots.some(root => resolve(p).startsWith(root))
  return getPathsForPermissionCheck(path).every(inside) ? dir.scope : null
}

/**
 * The directories as a prompt names them, without the trailing separator.
 * Private and team are in use together; global only while it is on.
 */
export function promptRoots(dirs: readonly MemoryDir[]): {
  global: string | null
  private: string
  team: string
} {
  const root = (scope: MemoryScope): string | null => {
    const dir = dirs.find(d => d.scope === scope)
    return dir ? withoutTrailingSep(dir.root) : null
  }
  return { global: root('global'), private: root('private') ?? '', team: root('team') ?? '' }
}

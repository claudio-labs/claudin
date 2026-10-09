import { join, sep } from 'path'
import type { MemoryDir } from 'src/memory/memdir/memoryDirs.js'
import { ENTRYPOINT_NAME, type MemoryScope } from 'src/memory/memdir/memoryScopes.js'

/** One memory directory as getMemoryDirs() returns it: root with a trailing separator, index beside it. */
export function testMemoryDir(scope: MemoryScope, root: string): MemoryDir {
  const withSep = root.endsWith(sep) ? root : root + sep
  return { scope, root: withSep, index: join(withSep, ENTRYPOINT_NAME) }
}

/**
 * A directory list for tests, in getMemoryDirs() order (global, private,
 * team). `global` is optional, as the global dir is off under its killswitch.
 */
export function testMemoryDirs(roots: {
  private: string
  team: string
  global?: string
}): MemoryDir[] {
  return [
    ...(roots.global !== undefined ? [testMemoryDir('global', roots.global)] : []),
    testMemoryDir('private', roots.private),
    testMemoryDir('team', roots.team),
  ]
}

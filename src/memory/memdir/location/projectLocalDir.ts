import { sep } from 'path'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'

export type ProjectLocalCandidate = {
  readonly dir: string
  readonly repoRoot: string
  readonly legacyDir: string
}

export type ProjectLocalFs = {
  readonly makeDir: (dir: string, mode: number) => void
  readonly realPath: (path: string) => string
  readonly setMode: (path: string, mode: number) => void
}

export type ProjectLocalDeps = {
  readonly fs: ProjectLocalFs
  /** Copies legacy memory into the new directory when it holds none yet. */
  readonly copyLegacyMemory: (legacyDir: string, dir: string) => void
  /** Project roots already offered the copy in this process. */
  readonly copiedRoots: Set<string>
}

const PRIVATE_DIR_MODE = 0o700

/**
 * Prepares `<repo>/.claudin/memory/` for use and says whether it may be used.
 * A symlinked `.claudin` or `.claudin/memory` leading out of the repository,
 * or a directory that cannot be created or resolved, rules it out: the caller
 * memoizes the answer, so an unverified path must never be accepted.
 */
export function adoptProjectLocalDir(
  candidate: ProjectLocalCandidate,
  projectRoot: string,
  deps: ProjectLocalDeps,
): boolean {
  let inside: boolean
  try {
    deps.fs.makeDir(candidate.dir, PRIVATE_DIR_MODE)
    inside = isStrictlyInside(
      deps.fs.realPath(candidate.dir),
      deps.fs.realPath(candidate.repoRoot),
    )
  } catch (error) {
    logForDebugging(
      `Project-local memory at ${candidate.dir} is unusable (${errorMessage(error)}); using ${candidate.legacyDir}`,
    )
    return false
  }
  if (!inside) {
    logForDebugging(
      `Project-local memory at ${candidate.dir} resolves outside ${candidate.repoRoot}; using ${candidate.legacyDir}`,
      { level: 'warn' },
    )
    return false
  }

  // An existing directory keeps whatever mode it was created with.
  try {
    deps.fs.setMode(candidate.dir, PRIVATE_DIR_MODE)
  } catch (error) {
    logForDebugging(
      `Could not restrict ${candidate.dir} to its owner: ${errorMessage(error)}`,
    )
  }

  copyLegacyMemoryOnce(candidate, projectRoot, deps)
  return true
}

function copyLegacyMemoryOnce(
  candidate: ProjectLocalCandidate,
  projectRoot: string,
  deps: ProjectLocalDeps,
): void {
  if (deps.copiedRoots.has(projectRoot)) return
  deps.copiedRoots.add(projectRoot)
  try {
    deps.copyLegacyMemory(candidate.legacyDir, candidate.dir)
  } catch (error) {
    logError(error)
  }
}

function isStrictlyInside(path: string, root: string): boolean {
  const prefix = root.endsWith(sep) ? root : `${root}${sep}`
  return path.startsWith(prefix) && path.length > prefix.length
}

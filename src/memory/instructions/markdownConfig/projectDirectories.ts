/**
 * The project's `.claudin/<subdir>` directories: found from the cwd upward,
 * nearest first, and for a linked worktree the main checkout's as well.
 */
import { statSync } from 'fs'
import { homedir } from 'os'
import { dirname, resolve } from 'path'

import {
  type ClaudeConfigDirectory,
  configSubdirOf,
} from 'src/memory/instructions/markdownConfig/configDirectories.js'
import { isSamePath, isStrictlyInside } from 'src/memory/instructions/markdownConfig/pathComparison.js'
import { getProjectRoot } from 'src/platform/bootstrap/state.js'
import { isFsInaccessible } from 'src/shared/errors.js'
import { findCanonicalGitRoot, findGitRoot } from 'src/vcs/git/git.js'

export type ProjectWalkDeps = {
  homeDir: () => string
  /** The session's project root, whose repository nested repositories walk up to. */
  sessionRoot: () => string
  findGitRoot: (path: string) => string | null
  /** Resolves a worktree to its main checkout, so both count as one repository. */
  findCanonicalGitRoot: (path: string) => string | null
}

// Read on every call: the home directory, the session root and the git
// lookups all belong to the moment the walk runs.
export const projectWalkDeps: ProjectWalkDeps = {
  homeDir: () => homedir(),
  sessionRoot: () => getProjectRoot(),
  findGitRoot: path => findGitRoot(path),
  findCanonicalGitRoot: path => findCanonicalGitRoot(path),
}

export function walkProjectConfigDirs(
  subdir: ClaudeConfigDirectory,
  cwd: string,
  deps: ProjectWalkDeps,
): string[] {
  const start = resolve(cwd)
  const stop = walkStop(start, deps)
  const home = deps.homeDir()
  const found: string[] = []
  for (const dir of selfAndAncestors(start)) {
    // Home's own `.claudin` is the user source, which is read on its own.
    if (isSamePath(dir, home)) break
    const candidate = configSubdirOf(dir, subdir)
    if (isDirectory(candidate)) found.push(candidate)
    if (stop !== undefined && isSamePath(dir, stop)) break
  }
  return found
}

/**
 * The last directory the walk looks at, or `undefined` outside any repository,
 * where only home or the filesystem root ends it. A repository nested in the
 * session's own (a submodule, a vendored clone) walks on to the session's
 * root so that it does not hide the project's configuration. A worktree of
 * the session's repository is that same repository, and stops at its own root.
 */
export function walkStop(start: string, deps: ProjectWalkDeps): string | undefined {
  const repoRoot = deps.findGitRoot(start)
  if (repoRoot === null) return undefined
  const sessionRepoRoot = deps.findGitRoot(deps.sessionRoot())
  if (sessionRepoRoot === null || !isStrictlyInside(repoRoot, sessionRepoRoot)) return repoRoot
  return isSameRepository(repoRoot, sessionRepoRoot, deps) ? repoRoot : sessionRepoRoot
}

/**
 * The main checkout's `.claudin/<subdir>`, when the cwd is in a linked
 * worktree whose root has none among the walked directories. A worktree made
 * from a commit that tracks the directory has its own copy; this fills in
 * what the checkout lacks, such as untracked files or a sparse checkout.
 */
export function worktreeFallbackDirs(
  subdir: ClaudeConfigDirectory,
  cwd: string,
  walked: readonly string[],
  deps: ProjectWalkDeps,
): string[] {
  const start = resolve(cwd)
  const repoRoot = deps.findGitRoot(start)
  const mainRoot = deps.findCanonicalGitRoot(start)
  if (repoRoot === null || mainRoot === null || isSamePath(repoRoot, mainRoot)) return []
  const ownDir = configSubdirOf(repoRoot, subdir)
  if (walked.some(dir => isSamePath(dir, ownDir))) return []
  return [configSubdirOf(mainRoot, subdir)]
}

function isSameRepository(a: string, b: string, deps: ProjectWalkDeps): boolean {
  const mainOfA = deps.findCanonicalGitRoot(a)
  const mainOfB = deps.findCanonicalGitRoot(b)
  return mainOfA !== null && mainOfB !== null && isSamePath(mainOfA, mainOfB)
}

function* selfAndAncestors(start: string): Generator<string> {
  let dir = start
  while (true) {
    yield dir
    const parent = dirname(dir)
    if (parent === dir) return
    dir = parent
  }
}

/**
 * Only a directory is a source. Missing, dangling, looping or forbidden paths
 * contribute nothing; any other error (a name too long, an I/O error) is the
 * caller's.
 */
function isDirectory(path: string): boolean {
  try {
    return statSync(path).isDirectory()
  } catch (error) {
    if (isFsInaccessible(error)) return false
    throw error
  }
}

import { LRUCache } from 'lru-cache'
import { isAbsolute, join, resolve } from 'path'
import { logError } from 'src/shared/log.js'
import type { GitFiles } from 'src/vcs/git/gitFilesystem/gitFiles.js'

const GITFILE_PREFIX = 'gitdir:'
/** A target spanning lines, or holding a NUL, names no directory git would use. */
const UNUSABLE_TARGET = /[\0\r\n]/

/**
 * The directory a `.git` file names, resolved against the directory that
 * holds it, as a submodule's relative `gitdir: ../../.git/modules/x` needs.
 * Laxer than git on one point: no blank is required after the colon.
 */
export function parseGitFile(text: string, holder: string): string | null {
  const content = text.trim()
  if (!content.startsWith(GITFILE_PREFIX)) return null
  const target = content.slice(GITFILE_PREFIX.length).trim()
  if (target === '' || UNUSABLE_TARGET.test(target)) return null
  return resolve(holder, target)
}

/** `<dir>/.git` read as a gitfile: the directory it names, if that exists. */
export async function readGitFile(dir: string, files: GitFiles): Promise<string | null> {
  const text = await files.readText(join(dir, '.git'))
  if (text === null) return null
  const target = parseGitFile(text, dir)
  if (target === null) return null
  return (await files.isDirectory(target)) ? target : null
}

/** Where a linked worktree's git directory keeps the shared refs and config. */
export async function readCommonDir(gitDir: string, files: GitFiles): Promise<string | null> {
  const target = (await files.readText(join(gitDir, 'commondir')))?.trim()
  if (!target) return null
  return isAbsolute(target) ? target : resolve(gitDir, target)
}

export type GitDirLocatorDeps = {
  files: GitFiles
  /** The nearest directory at or above `startPath` that holds a `.git` entry. */
  findRoot(startPath: string): string | null
  /** Where to start when the caller names no path. */
  defaultStart(): string
  maxRemembered: number
}

export type GitDirLocator = {
  locate(startPath?: string): Promise<string | null>
  forget(): void
}

/**
 * Answers are remembered per start path, a null among them, until forget().
 * A start path not asked about before always reads the disk.
 */
export function createGitDirLocator(deps: GitDirLocatorDeps): GitDirLocator {
  const remembered = new LRUCache<string, Promise<string | null>>({ max: deps.maxRemembered })

  async function lookUp(start: string): Promise<string | null> {
    const root = deps.findRoot(start)
    if (root === null) return null
    const dotGit = join(root, '.git')
    if (await deps.files.isDirectory(dotGit)) return dotGit
    return readGitFile(root, deps.files)
  }

  return {
    locate(startPath) {
      const start = resolve(startPath ?? deps.defaultStart())
      const known = remembered.get(start)
      if (known !== undefined) return known
      const answer = lookUp(start).catch((error: unknown) => {
        logError(error)
        return null
      })
      remembered.set(start, answer)
      return answer
    },
    forget() {
      remembered.clear()
    },
  }
}

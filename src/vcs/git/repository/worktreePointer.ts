import { readFileSync, realpathSync } from 'fs'
import { basename, dirname, isAbsolute, join, normalize, resolve } from 'path'
import {
  type ProbeEntry,
  probeEntry,
  reportUnexpectedFsError,
} from 'src/vcs/git/repository/entryKind.js'

/** The reads that judging a `.git` file takes, injectable so the rules can be exercised without a disk. */
export type WorktreeFs = {
  readonly kind: ProbeEntry
  /** A file's text, or null when it cannot be read. */
  readonly readText: (path: string) => string | null
  /** The path with every symlink resolved, or null when it does not resolve. */
  readonly realPath: (path: string) => string | null
}

/** What a `.git` file claims: the administrative directory it names, and the shared git directory behind that. */
type WorktreePointer = {
  readonly adminDir: string
  readonly commonDir: string
}

const GITDIR_PREFIX = 'gitdir: '
const LINE_ENDINGS_RE = /[\r\n]+$/

/**
 * The identity of the repository rooted at `root`. For a linked worktree whose
 * pointer is genuine, that is the main working tree, or a bare repository's
 * own directory. Anything else, a submodule included, is its own identity.
 */
export function canonicalRootOf(root: string, fs: WorktreeFs): string {
  const pointer = readWorktreePointer(root, fs)
  const identity =
    pointer !== null && isGenuineLinkedWorktree(pointer, root, fs)
      ? ownerOf(pointer.commonDir)
      : root
  return identity.normalize('NFC')
}

function readWorktreePointer(root: string, fs: WorktreeFs): WorktreePointer | null {
  const dotGit = join(root, '.git')
  if (fs.kind(dotGit) !== 'file') return null
  const content = fs.readText(dotGit)
  if (content === null || !content.startsWith(GITDIR_PREFIX)) return null
  const target = withoutLineEndings(content.slice(GITDIR_PREFIX.length))
  if (target === '') return null
  const adminDir = resolve(root, target)
  const commonDirText = fs.readText(join(adminDir, 'commondir'))
  if (commonDirText === null) return null
  const commonDir = withoutLineEndings(commonDirText)
  return commonDir === '' ? null : { adminDir, commonDir: resolve(adminDir, commonDir) }
}

/**
 * Whether git itself registered `root` as a worktree of the repository its
 * `.git` file names. Project config, trust and hooks are keyed by the
 * canonical root, and a cloned repository controls its own `.git` file, so the
 * pointer is believed only when both rules hold:
 *   1. the admin directory is a direct child of `<shared git dir>/worktrees`;
 *   2. the admin directory's back-link names this checkout's own `.git`.
 *      Symlinks in the checkout's path are resolved, but not in the `.git`
 *      entry itself, so a `.git` symlinked to another worktree's is refused.
 * A back-link recorded as a relative path never matches, which keeps a
 * worktree made with `--relative-paths` as its own root: the state stored
 * under those roots would otherwise move.
 */
function isGenuineLinkedWorktree(pointer: WorktreePointer, root: string, fs: WorktreeFs): boolean {
  const isRegisteredEntry = dirname(pointer.adminDir) === join(pointer.commonDir, 'worktrees')
  return isRegisteredEntry && backLinkNamesCheckout(pointer.adminDir, root, fs)
}

function backLinkNamesCheckout(adminDir: string, root: string, fs: WorktreeFs): boolean {
  const backLinkText = fs.readText(join(adminDir, 'gitdir'))
  const realRoot = fs.realPath(root)
  if (backLinkText === null || realRoot === null) return false
  const backLink = withoutLineEndings(backLinkText)
  return isAbsolute(backLink) && normalize(backLink) === join(realRoot, '.git')
}

// The shared git directory is `<main working tree>/.git`, except in a bare
// repository, which is the shared directory itself.
function ownerOf(commonDir: string): string {
  return basename(commonDir) === '.git' ? dirname(commonDir) : commonDir
}

function withoutLineEndings(text: string): string {
  return text.replace(LINE_ENDINGS_RE, '')
}

export const nodeWorktreeFs: WorktreeFs = {
  kind: probeEntry,
  readText: path => {
    try {
      return readFileSync(path, 'utf8')
    } catch (error) {
      reportUnexpectedFsError(path, error)
      return null
    }
  },
  realPath: path => {
    try {
      return realpathSync(path)
    } catch (error) {
      reportUnexpectedFsError(path, error)
      return null
    }
  },
}

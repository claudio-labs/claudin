import { join } from 'path'
import { getCwd } from 'src/shared/fs/cwd.js'
import { type ProbeEntry, probeEntry } from 'src/vcs/git/repository/entryKind.js'

/**
 * Whether git started in `dir` could take `dir` itself for a bare repository,
 * and so read hooks and config from it; the shell tools ask before running
 * git in such a directory. A `.git` file, or a `.git` directory holding a
 * regular HEAD, settles it as a checkout. Otherwise any one indicator flags
 * it: a regular HEAD file, or an `objects/` or `refs/` directory. That also
 * flags a checkout's subdirectory that holds `refs/`, a false positive the
 * callers can afford, since all they do is ask.
 */
function looksLikeBareRepository(dir: string, probe: ProbeEntry): boolean {
  const dotGit = probe(join(dir, '.git'))
  if (dotGit === 'file') return false
  if (dotGit === 'directory' && probe(join(dir, '.git', 'HEAD')) === 'file') return false
  return (
    probe(join(dir, 'HEAD')) === 'file' ||
    probe(join(dir, 'objects')) === 'directory' ||
    probe(join(dir, 'refs')) === 'directory'
  )
}

/** Judges the session cwd, synchronously. */
export function isCurrentDirectoryBareGitRepo(): boolean {
  return looksLikeBareRepository(getCwd(), probeEntry)
}

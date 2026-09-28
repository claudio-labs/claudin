import { QUICK_READ_TIMEOUT_MS, runGit } from 'src/vcs/git/repository/runGit.js'
import { type GitFileStatus, parseStatusPorcelain } from 'src/vcs/git/repository/statusPorcelain.js'

const AUTO_STASH_LABEL = 'Claudin auto-stash'

/**
 * Whether `git status --porcelain` in the process working directory reports
 * nothing; untracked files count unless `ignoreUntracked` is set. Outside a
 * repository git reports nothing either, so the tree reads as clean there:
 * teleport and the remote-session preconditions proceed on that answer.
 */
export async function getIsClean(options: { ignoreUntracked?: boolean } = {}): Promise<boolean> {
  const args = ['status', '--porcelain']
  if (options.ignoreUntracked) args.push('--untracked-files=no')
  const status = await runGit(args, { cwd: 'process' })
  return !status.ok || status.stdout.trim() === ''
}

/** The changes in `cwd`, or in the process working directory; two empty lists outside a repository or on failure. */
export async function getFileStatus(cwd?: string): Promise<GitFileStatus> {
  const status = await runGit(['status', '--porcelain', '-z'], {
    cwd: cwd ? { dir: cwd } : 'process',
    timeoutMs: QUICK_READ_TIMEOUT_MS,
  })
  return status.ok ? parseStatusPorcelain(status.stdout) : { tracked: [], untracked: [] }
}

/**
 * Stashes every change in the process directory's repository, untracked files
 * included, under `message`. Stashing the whole tree at once means neither
 * the subdirectory it runs from nor the spelling of a name can make it fail.
 * True when git succeeds, a tree with nothing to stash included (no entry is
 * made then).
 */
export async function stashToCleanState(
  message: string = `${AUTO_STASH_LABEL} - ${new Date().toISOString()}`,
): Promise<boolean> {
  const stash = await runGit(['stash', 'push', '--include-untracked', `--message=${message}`], {
    cwd: 'process',
    mutates: true,
  })
  return stash.ok
}

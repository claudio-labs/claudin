import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import { gitExe } from 'src/vcs/git/git.js'

/**
 * On every call. A background read must never take `index.lock` from under
 * the user's own git commands, and a non-ASCII name must come out as it is on
 * disk, so the numbers, the hunks and the file the reviewer opens agree on it.
 */
const EVERY_CALL = ['--no-optional-locks', '-c', 'core.quotePath=false'] as const

/**
 * On every diff. The repository's own settings must not turn the output into
 * something the parsers cannot read (`color.diff=always`), nor run a program
 * of their choosing (`diff.external`).
 */
const EVERY_DIFF = ['--no-color', '--no-ext-diff'] as const

/** The hunks are keyed by the path after these, whatever diff.noprefix or diff.mnemonicPrefix say. */
const FIXED_PREFIXES = ['--src-prefix=a/', '--dst-prefix=b/'] as const

export type DiffOutput = 'totals' | 'numbers' | 'patch'

const OUTPUT_FLAGS: Record<DiffOutput, readonly string[]> = {
  totals: ['--shortstat'],
  numbers: ['--numstat'],
  patch: FIXED_PREFIXES,
}

export type GitLimits = { timeoutMs: number; maxBytes?: number }

/**
 * The working tree and index compared with `commit`. The closing `--` keeps a
 * file that happens to be named like the commit from making git refuse.
 */
export function diffArgs(commit: string, output: DiffOutput): string[] {
  return ['diff', ...EVERY_DIFF, ...OUTPUT_FLAGS[output], commit, '--']
}

/** Untracked files that the standard excludes do not ignore, one by one. */
export const UNTRACKED_FILES_ARGS: readonly string[] = ['ls-files', '--others', '--exclude-standard']

export function mergeBaseArgs(base: string): string[] {
  return ['merge-base', 'HEAD', base]
}

/**
 * Runs git in `cwd`, without a shell. The output, or null when git fails, is
 * too slow, or prints more than the limit allows.
 */
export async function runGit(cwd: string, args: readonly string[], limits: GitLimits): Promise<string | null> {
  const result = await execFileNoThrowWithCwd(gitExe(), [...EVERY_CALL, ...args], {
    cwd,
    timeout: limits.timeoutMs,
    maxBuffer: limits.maxBytes,
    preserveOutputOnError: false,
  })
  return result.code === 0 && result.error === undefined ? result.stdout : null
}

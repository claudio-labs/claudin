import { execFile } from 'child_process'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { probeEntry } from 'src/vcs/git/repository/entryKind.js'
import { gitExe } from 'src/vcs/git/repository/gitExecutable.js'

/**
 * Where a git command runs. Three directories are in play, and which one a
 * function uses is part of its contract: a directory the caller names, the
 * session cwd (`getCwd()`, which honours `runWithCwdOverride`), or the process
 * working directory.
 */
export type WorkingDirectory = { readonly dir: string } | 'session' | 'process'

type GitRunOptions = {
  readonly cwd: WorkingDirectory
  /** Set for commands that change the repository. The rest skip git's optional locks, so they never race the user's own git. */
  readonly mutates?: boolean
  readonly timeoutMs?: number
  /** Runs this instead of the resolved `gitExe()`. */
  readonly program?: string
}

/** Never thrown: a failure is `ok: false`, and each caller maps it to its documented fallback. */
type GitRun = { readonly ok: boolean; readonly stdout: string }

/** For status reads behind the UI, which should give up rather than hold it. */
export const QUICK_READ_TIMEOUT_MS = 5_000
// Only bounds a git that hangs: status in a large repository can take minutes.
const DEFAULT_TIMEOUT_MS = 10 * 60_000
const MAX_OUTPUT_BYTES = 64 * 1024 * 1024
const NOT_RUN: GitRun = { ok: false, stdout: '' }

export function runGit(args: readonly string[], options: GitRunOptions): Promise<GitRun> {
  const cwd = existingDirectory(options.cwd)
  if (cwd === null) return Promise.resolve(NOT_RUN)
  const argv = options.mutates ? [...args] : ['--no-optional-locks', ...args]
  return new Promise(resolve => {
    execFile(
      options.program ?? gitExe(),
      argv,
      {
        cwd,
        encoding: 'utf8',
        maxBuffer: MAX_OUTPUT_BYTES,
        timeout: options.timeoutMs ?? DEFAULT_TIMEOUT_MS,
        windowsHide: true,
      },
      (error, stdout) => {
        // A non-zero exit is an answer ("not a repository", "no upstream"). A
        // git that could not start, timed out or overflowed is worth a trace.
        if (error !== null && typeof error.code !== 'number') {
          logForDebugging(`git ${args[0] ?? ''} did not complete: ${error.message}`)
        }
        resolve({ ok: error === null, stdout })
      },
    )
  })
}

function existingDirectory(where: WorkingDirectory): string | null {
  const path = directoryOf(where)
  return path !== null && probeEntry(path) === 'directory' ? path : null
}

function directoryOf(where: WorkingDirectory): string | null {
  if (where === 'session') return getCwd()
  if (where !== 'process') return where.dir
  try {
    return process.cwd()
  } catch (error) {
    // The process directory can be deleted from under a running CLI.
    logForDebugging(`No process working directory: ${errorMessage(error)}`)
    return null
  }
}

import { runGit } from 'src/vcs/git/repository/runGit.js'

// Looked up on PATH when called, rather than the gitExe() resolved once.
const GIT_ON_PATH = 'git'

/**
 * Whether git ignores `filePath`, read relative to `cwd` unless absolute:
 * every `.gitignore`, `info/exclude` and the global excludes file, with git's
 * own precedence, and never a tracked file. False outside a repository, for a
 * path outside it, and on any failure.
 */
export async function isPathGitignored(filePath: string, cwd: string): Promise<boolean> {
  const verdict = await runGit(['check-ignore', '--quiet', '--', filePath], {
    cwd: { dir: cwd },
    program: GIT_ON_PATH,
  })
  return verdict.ok
}

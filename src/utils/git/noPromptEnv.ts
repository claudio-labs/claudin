/**
 * Env vars that stop git/SSH from prompting for credentials.
 *
 * A credential prompt opens `/dev/tty` and blocks forever in a non-interactive
 * child, so every code path that shells out to git wants these. Kept in its own
 * leaf module rather than in `worktree.ts` so a caller can have the constant
 * without pulling in that file's dependency graph (config, hooks, tmux glue).
 *
 * `GIT_TERMINAL_PROMPT=0` stops git from opening /dev/tty itself.
 * `GIT_ASKPASS=''` disables askpass GUI helpers.
 */
export const GIT_NO_PROMPT_ENV: Readonly<Record<string, string>> = {
  GIT_TERMINAL_PROMPT: '0',
  GIT_ASKPASS: '',
}

/**
 * Worktree support is always available in this CLI. The switch stays because
 * option parsing and the tool list still ask it; it reads no setting,
 * environment variable, flag or directory.
 */
export function isWorktreeModeEnabled(): boolean {
  return true
}

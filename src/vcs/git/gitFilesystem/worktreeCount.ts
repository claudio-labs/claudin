import { join } from 'path'
import { readCommonDir } from 'src/vcs/git/gitFilesystem/gitDir.js'
import type { GitFiles } from 'src/vcs/git/gitFilesystem/gitFiles.js'

/**
 * The main worktree plus one per directory under `worktrees/` in the shared
 * git directory: what `git worktree list` shows, from any of the worktrees.
 * A worktree deleted without `git worktree prune` still counts until the prune.
 */
export async function countWorktrees(gitDir: string, files: GitFiles): Promise<number> {
  const storeDir = (await readCommonDir(gitDir, files)) ?? gitDir
  const linked = await files.listDirectories(join(storeDir, 'worktrees'))
  return 1 + (linked?.length ?? 0)
}

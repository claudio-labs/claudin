import { basename } from 'path'

export interface CwdLocation {
  /** Folder name of the project root — the main checkout's, even from a worktree. */
  project: string
  /** Folder name of the linked worktree the cwd is in; empty in the main checkout. */
  worktree: string
}

/**
 * Names for the prompt footer's project and worktree pills. `gitRoot` is the
 * checkout the cwd is in and `canonicalRoot` the main repository it belongs
 * to (findGitRoot / findCanonicalGitRoot) — they differ only inside a linked
 * worktree. Outside a repo the project is the directory Claudin started in.
 */
export function describeCwdLocation(
  gitRoot: string | null,
  canonicalRoot: string | null,
  startDir: string,
  home: string,
): CwdLocation {
  const projectRoot = canonicalRoot ?? startDir
  return {
    project: home && projectRoot === home ? '~' : basename(projectRoot) || projectRoot,
    worktree: gitRoot && canonicalRoot && gitRoot !== canonicalRoot ? basename(gitRoot) : '',
  }
}

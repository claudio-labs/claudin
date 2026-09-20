/**
 * What runs once, right after a worktree is first created: propagate
 * settings.local.json, point the worktree at the main repo's git hooks, and
 * hand off to includeFiles for the symlinks and the .worktreeinclude copy.
 */

import { copyFile, stat } from 'fs/promises'
import { dirname, join } from 'path'
import {
  getInitialSettings,
  getRelativeSettingsFilePathForSource,
} from 'src/platform/settings/settings.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { execFileNoThrowWithCwd } from 'src/shared/proc/execFileNoThrow.js'
import { gitExe } from 'src/vcs/git/git.js'
import { parseGitConfigValue } from 'src/vcs/git/gitConfigParser.js'
import { getCommonDir, resolveGitDir } from 'src/vcs/git/gitFilesystem.js'
import {
  copyWorktreeIncludeFiles,
  mkdirRecursive,
  symlinkDirectories,
} from 'src/vcs/git/worktree/includeFiles.js'

/**
 * Post-creation setup for a newly created worktree.
 * Propagates settings.local.json, configures git hooks, and symlinks directories.
 */
export async function performPostCreationSetup(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  // Copy settings.local.json to the worktree's .claudin directory
  // This propagates local settings (which may contain secrets) to the worktree
  const localSettingsRelativePath =
    getRelativeSettingsFilePathForSource('localSettings')
  const sourceSettingsLocal = join(repoRoot, localSettingsRelativePath)
  try {
    const destSettingsLocal = join(worktreePath, localSettingsRelativePath)
    await mkdirRecursive(dirname(destSettingsLocal))
    await copyFile(sourceSettingsLocal, destSettingsLocal)
    logForDebugging(
      `Copied settings.local.json to worktree: ${destSettingsLocal}`,
    )
  } catch (e: unknown) {
    const code = getErrnoCode(e)
    if (code !== 'ENOENT') {
      logForDebugging(
        `Failed to copy settings.local.json: ${(e as Error).message}`,
        { level: 'warn' },
      )
    }
  }

  // Configure the worktree to use hooks from the main repository
  // This solves issues with .husky and other git hooks that use relative paths
  const huskyPath = join(repoRoot, '.husky')
  const gitHooksPath = join(repoRoot, '.git', 'hooks')
  let hooksPath: string | null = null
  for (const candidatePath of [huskyPath, gitHooksPath]) {
    try {
      const s = await stat(candidatePath)
      if (s.isDirectory()) {
        hooksPath = candidatePath
        break
      }
    } catch {
      // Path doesn't exist or can't be accessed
    }
  }
  if (hooksPath) {
    // `git config` (no --worktree flag) writes to the main repo's .git/config,
    // shared by all worktrees. Once set, every subsequent worktree create is a
    // no-op — skip the subprocess (~14ms spawn) when the value already matches.
    const gitDir = await resolveGitDir(repoRoot)
    const configDir = gitDir ? ((await getCommonDir(gitDir)) ?? gitDir) : null
    const existing = configDir
      ? await parseGitConfigValue(configDir, 'core', null, 'hooksPath')
      : null
    if (existing !== hooksPath) {
      const { code: configCode, stderr: configError } =
        await execFileNoThrowWithCwd(
          gitExe(),
          ['config', 'core.hooksPath', hooksPath],
          { cwd: worktreePath },
        )
      if (configCode === 0) {
        logForDebugging(
          `Configured worktree to use hooks from main repository: ${hooksPath}`,
        )
      } else {
        logForDebugging(`Failed to configure hooks path: ${configError}`, {
          level: 'error',
        })
      }
    }
  }

  // Symlink directories to avoid disk bloat (opt-in via settings)
  const settings = getInitialSettings()
  const dirsToSymlink = settings.worktree?.symlinkDirectories ?? []
  if (dirsToSymlink.length > 0) {
    await symlinkDirectories(repoRoot, worktreePath, dirsToSymlink)
  }

  // Copy gitignored files specified in .worktreeinclude (best-effort)
  await copyWorktreeIncludeFiles(repoRoot, worktreePath)

}

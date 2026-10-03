/**
 * What runs once, right after a worktree is first created: propagate
 * settings.local.json, point the worktree at the main repo's git hooks, and
 * hand off to includeFiles for the symlinks and the .worktreeinclude copy.
 *
 * Each step is best effort: a failure is logged and the next step still runs.
 */

import { copyFile, stat } from 'fs/promises'
import { dirname, isAbsolute, join } from 'path'
import {
  getInitialSettings,
  getRelativeSettingsFilePathForSource,
} from 'src/platform/settings/settings.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { git } from 'src/vcs/git/worktree/gitCommand.js'
import {
  copyWorktreeIncludeFiles,
  mkdirRecursive,
  symlinkDirectories,
} from 'src/vcs/git/worktree/includeFiles.js'

type SetupStep = {
  readonly name: string
  run(repoRoot: string, worktreePath: string): Promise<void>
}

async function isDirectory(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isDirectory()
  } catch {
    return false
  }
}

async function isFile(path: string): Promise<boolean> {
  try {
    return (await stat(path)).isFile()
  } catch {
    return false
  }
}

async function copyLocalSettings(repoRoot: string, worktreePath: string): Promise<void> {
  const relative = getRelativeSettingsFilePathForSource('localSettings')
  const source = join(repoRoot, relative)
  if (!(await isFile(source))) return
  const target = join(worktreePath, relative)
  await mkdirRecursive(dirname(target))
  await copyFile(source, target)
}

/** The hooks directory the repository should share with its worktrees, or null to leave it. */
async function chooseHooksDirectory(
  repoRoot: string,
  configured: string | null,
): Promise<string | null> {
  // A configured directory is kept; only its spelling is made absolute, so a
  // worktree reaches the main checkout's files instead of its own copy.
  if (configured !== null && configured !== '') {
    return isAbsolute(configured) ? configured : join(repoRoot, configured)
  }
  for (const candidate of [join(repoRoot, '.husky'), join(repoRoot, '.git', 'hooks')]) {
    if (await isDirectory(candidate)) return candidate
  }
  return null
}

async function shareHooksPath(repoRoot: string): Promise<void> {
  const current = await git(repoRoot, 'config', '--get', 'core.hooksPath')
  const configured = current.ok ? current.stdout.trim() : null
  const chosen = await chooseHooksDirectory(repoRoot, configured)
  if (chosen === null || chosen === configured) return
  const written = await git(repoRoot, 'config', 'core.hooksPath', chosen)
  if (!written.ok) throw new Error(written.stderr.trim())
}

async function linkConfiguredDirectories(repoRoot: string, worktreePath: string): Promise<void> {
  const entries = getInitialSettings().worktree?.symlinkDirectories ?? []
  if (entries.length > 0) await symlinkDirectories(repoRoot, worktreePath, entries)
}

async function copyIncludedFiles(repoRoot: string, worktreePath: string): Promise<void> {
  const copied = await copyWorktreeIncludeFiles(repoRoot, worktreePath)
  if (copied.length > 0) logForDebugging(`worktree: copied ${copied.length} file(s) named in .worktreeinclude`)
}

const SETUP_STEPS: readonly SetupStep[] = [
  { name: 'local settings', run: copyLocalSettings },
  { name: 'hooks path', run: shareHooksPath },
  { name: 'linked directories', run: linkConfiguredDirectories },
  { name: '.worktreeinclude', run: copyIncludedFiles },
]

export async function performPostCreationSetup(
  repoRoot: string,
  worktreePath: string,
): Promise<void> {
  for (const step of SETUP_STEPS) {
    try {
      await step.run(repoRoot, worktreePath)
    } catch (error) {
      logForDebugging(`worktree setup: ${step.name} failed: ${errorMessage(error)}`, { level: 'warn' })
    }
  }
}

/**
 * The world the worktree characterization suites run the unit in.
 *
 * The unit starts git itself, reads settings and hooks, publishes the current
 * worktree session and moves the process working directory. A lab gives one
 * test fresh temp directories for all of that, and `close()` hands every piece
 * of process state back as it found it:
 * - git runs with no global or system config and HOME in the lab
 *   (`isolateGitEnv`); fixtures are built with `ScratchGit`, which isolates
 *   its own processes the same way;
 * - CLAUDIN_CONFIG_DIR, the session's original directory and the managed
 *   settings directory all point into the lab, so no real settings are read;
 * - hooks run without the workspace-trust prompt (a non-interactive session);
 * - the current worktree session, the mutation locks and the in-memory
 *   project config start and end empty.
 */

import { mkdirSync, writeFileSync } from 'fs'
import { join } from 'path'

import {
  getAllowedSettingSources,
  getIsNonInteractiveSession,
  getOriginalCwd,
  setAllowedSettingSources,
  setIsInteractive,
  setOriginalCwd,
} from 'src/platform/bootstrap/state.js'
import { resetProjectConfigForTests } from 'src/platform/config/config.js'
import { resetHooksConfigSnapshot } from 'src/platform/lifecycleHooks/hooksConfigSnapshot.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath, getManagedSettingsDropInDir } from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { runWithCwdOverride } from 'src/shared/fs/cwd.js'
import { isolateGitEnv, type IsolatedGitEnv } from 'src/vcs/git/__testutils__/isolatedGitEnv.js'
import { ScratchGit } from 'src/vcs/git/__testutils__/scratchRepos.js'
import {
  _resetGitWorktreeMutationLocksForTesting,
  restoreWorktreeSession,
} from 'src/vcs/git/worktree.js'

const ALL_SOURCES: SettingSource[] = [
  'userSettings',
  'projectSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
]

/** Variables a lab clears for its lifetime; `close()` puts them back. */
const CLEARED = ['CLAUDIN_SIMPLE', 'TMUX', 'TMUX_PANE', 'CLAUDE_CODE_USE_COWORK_PLUGINS']

export type Upstream = {
  /** A bare repository whose `main` holds `base`. */
  origin: string
  /** A clone of `origin`: `origin/main` and `origin/HEAD` exist locally. */
  clone: string
  /** The commit both start from. */
  base: string
}

export type CommandHook = { type: 'command'; command: string }

export type WorktreeLab = {
  readonly git: ScratchGit
  readonly home: string
  readonly configDir: string
  /** The session's original directory: empty, outside every repository. */
  readonly anchor: string
  readonly env: IsolatedGitEnv
  /** A bare `origin` holding one commit on `main`, and a clone of it. */
  upstream(label: string): Upstream
  /** Replaces the user settings file and drops every settings memo. */
  writeSettings(settings: Record<string, unknown>): void
  /** Runs `action` with the session working directory (`getCwd()`) at `dir`. */
  inSession<T>(dir: string, action: () => T): T
  close(): void
}

const quote = (text: string): string => `'${text.replaceAll("'", `'\\''`)}'`

/**
 * A command hook that saves the JSON it is given to `recordTo` and, when
 * `printDir` is set, creates that directory and prints it.
 */
export function recordingHook(recordTo: string, printDir?: string): CommandHook {
  const steps = [`cat > ${quote(recordTo)}`]
  if (printDir !== undefined) {
    steps.push(`mkdir -p ${quote(printDir)}`, `printf '%s\\n' ${quote(printDir)}`)
  }
  return { type: 'command', command: steps.join('; ') }
}

/** A command hook that fails, printing `why` on stderr. */
export function failingHook(why: string): CommandHook {
  return { type: 'command', command: `cat > /dev/null; echo ${quote(why)} >&2; exit 3` }
}

export function openWorktreeLab(): WorktreeLab {
  const git = new ScratchGit()
  const home = git.tempDir('home')
  const configDir = join(home, 'claudin-config')
  const anchor = git.tempDir('anchor')
  const managed = git.tempDir('managed')
  mkdirSync(configDir)

  const env = isolateGitEnv(home)
  for (const name of CLEARED) env.set(name, undefined)
  env.set('CLAUDIN_CONFIG_DIR', configDir)

  const saved = {
    processDir: process.cwd(),
    originalCwd: getOriginalCwd(),
    interactive: !getIsNonInteractiveSession(),
    sources: [...getAllowedSettingSources()],
  }
  setOriginalCwd(anchor)
  setIsInteractive(false)
  setAllowedSettingSources([...ALL_SOURCES])
  getManagedFilePath.cache.set(undefined, managed)
  getManagedSettingsDropInDir.cache.set(undefined, join(managed, 'managed-settings.d'))

  const resetUnitState = (): void => {
    restoreWorktreeSession(null)
    _resetGitWorktreeMutationLocksForTesting()
    resetProjectConfigForTests()
    resetSettingsCache()
    resetHooksConfigSnapshot()
  }
  resetUnitState()

  return {
    git,
    home,
    configDir,
    anchor,
    env,
    upstream(label) {
      const seed = git.repo(`${label}-seed`)
      const base = git.run(seed, 'rev-parse', 'HEAD')
      const origin = git.tempDir(`${label}-origin`)
      git.run(origin, 'init', '-q', '--bare', '-b', 'main')
      git.run(seed, 'push', '-q', origin, 'main')
      const holder = git.tempDir(`${label}-clone`)
      const clone = join(holder, 'repo')
      git.run(holder, 'clone', '-q', origin, clone)
      return { origin, clone, base }
    },
    writeSettings(settings) {
      writeFileSync(join(configDir, 'settings.json'), JSON.stringify(settings))
      resetSettingsCache()
      resetHooksConfigSnapshot()
    },
    inSession(dir, action) {
      return runWithCwdOverride(dir, action)
    },
    close() {
      process.chdir(saved.processDir)
      resetUnitState()
      getManagedFilePath.cache.delete(undefined)
      getManagedSettingsDropInDir.cache.delete(undefined)
      setAllowedSettingSources(saved.sources)
      setIsInteractive(saved.interactive)
      setOriginalCwd(saved.originalCwd)
      env.restore()
      resetSettingsCache()
      resetHooksConfigSnapshot()
      git.cleanup()
    },
  }
}

/** The paths `git worktree list` reports for `repo`, main working tree first. */
export function registeredWorktrees(git: ScratchGit, repo: string): string[] {
  return git
    .run(repo, 'worktree', 'list', '--porcelain', '-z')
    .split('\0')
    .filter(field => field.startsWith('worktree '))
    .map(field => field.slice('worktree '.length))
}

/** The commit `ref` names in `repo`, or null when it names nothing. */
export function commitOf(git: ScratchGit, repo: string, ref: string): string | null {
  const outcome = git.attempt(repo, 'rev-parse', '--verify', '--quiet', `${ref}^{commit}`)
  return outcome.ok ? outcome.stdout : null
}

/** Every local branch of `repo`, sorted. */
export function localBranches(git: ScratchGit, repo: string): string[] {
  const listed = git.run(repo, 'for-each-ref', '--format=%(refname:short)', 'refs/heads')
  return listed === '' ? [] : listed.split('\n').sort()
}

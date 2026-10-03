/**
 * A throwaway world for the `permissions/filePaths` characterization suites.
 *
 * Every directory the path checks consult is moved under one fresh temp root:
 * the config home, the per-user temp dir, the managed-settings dir and the
 * session's project. The process-wide memos that cache those locations are
 * dropped on the way in and on the way out, so one test never sees another's
 * directories. `os.homedir()` cannot be redirected under Bun (it ignores a
 * runtime HOME), so `~` cases name entries under the real home that do not
 * exist, and nothing is ever written there.
 */
import { spawnSync } from 'node:child_process'
import {
  mkdirSync,
  mkdtempSync,
  realpathSync,
  rmSync,
  symlinkSync,
  writeFileSync,
} from 'node:fs'
import { tmpdir } from 'node:os'
import { dirname, join } from 'node:path'

import { getPlansDirectory } from 'src/agent/plans/plans.js'
import { getAutoMemPath } from 'src/memory/memdir/paths.js'
import {
  getCwdState,
  getFlagSettingsPath,
  getOriginalCwd,
  getProjectRoot,
  setCwdState,
  setFlagSettingsPath,
  setOriginalCwd,
  setProjectRoot,
} from 'src/platform/bootstrap/state.js'
import {
  getManagedFilePath,
  getManagedSettingsDropInDir,
} from 'src/platform/settings/managedPath.js'
import { resetSettingsCache } from 'src/platform/settings/settingsCache.js'
import { getClaudeTempDir } from 'src/platform/tmpdir.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getPlatform, type Platform } from 'src/shared/proc/platform.js'
import {
  getEmptyToolPermissionContext,
  type ToolPermissionContext,
} from 'src/tools/Tool.js'

// The bundled-skills root is named after the build version, which only the
// bundler inlines. Any read that reaches the last carve-out needs it.
const buildGlobals = globalThis as { MACRO?: { VERSION?: string } }
if (!buildGlobals.MACRO) buildGlobals.MACRO = { VERSION: 'filepaths-lab' }

/** Every variable the unit or its collaborators read to place a directory. */
const ISOLATED_ENV = [
  'CLAUDIN_CONFIG_DIR',
  'CLAUDIN_TMPDIR',
  'CLAUDIN_SCRATCHPAD',
  'CLAUDE_COWORK_MEMORY_PATH_OVERRIDE',
  'CLAUDE_CODE_REMOTE_MEMORY_DIR',
  'CLAUDE_CODE_USE_COWORK_PLUGINS',
  'GIT_CONFIG_GLOBAL',
  'GIT_CONFIG_NOSYSTEM',
] as const

export type Lab = {
  /** The temp root; everything below is real and disposable. */
  readonly root: string
  /** The session's original cwd, cwd and project root. */
  readonly project: string
  /** A sibling of the project that no working directory covers. */
  readonly outside: string
  /** CLAUDIN_CONFIG_DIR. */
  readonly config: string
  /** CLAUDIN_TMPDIR, the base of the per-user Claudin temp dir. */
  readonly tmp: string
  /** Where managed (policy) settings are read from. */
  readonly admin: string
  /** Writes `text` at `path`, creating its parents, and returns the path. */
  file(path: string, text?: string): string
  /** Creates a directory with its parents and returns it. */
  dir(path: string): string
  /** Makes `link` point at `target` (which need not exist) and returns `link`. */
  link(link: string, target: string): string
  /** Turns `dir` into a git repository, isolated from the user's git config. */
  gitInit(dir: string): void
  /** Moves the session to `dir` (original cwd, cwd and project root). */
  moveSession(dir: string): void
  /** Answers `getPlatform()` with `platform` until the lab closes. */
  pretendPlatform(platform: Platform): void
  /** Drops the cached directory lookups after an environment change. */
  forget(): void
  close(): void
}

type Saved = {
  env: Record<string, string | undefined>
  originalCwd: string
  cwd: string
  projectRoot: string
  flagPath: string | undefined
}

function dropMemos(): void {
  getPlansDirectory.cache.clear?.()
  getAutoMemPath.cache.clear?.()
  getClaudeTempDir.cache.clear?.()
  getClaudinConfigHomeDir.cache.clear?.()
  getProjectDir.cache.clear()
  resetSettingsCache()
}

export function openLab(): Lab {
  const saved: Saved = {
    env: Object.fromEntries(ISOLATED_ENV.map(k => [k, process.env[k]])),
    originalCwd: getOriginalCwd(),
    cwd: getCwdState(),
    projectRoot: getProjectRoot(),
    flagPath: getFlagSettingsPath(),
  }

  const root = realpathSync(mkdtempSync(join(tmpdir(), 'filepaths-lab-')))
  const at = (name: string) => {
    const p = join(root, name)
    mkdirSync(p, { recursive: true })
    return p
  }
  const project = at('workspace')
  const outside = at('elsewhere')
  const config = at('config-home')
  const tmp = at('tmp')
  const admin = at('admin')

  for (const key of ISOLATED_ENV) delete process.env[key]
  process.env.CLAUDIN_CONFIG_DIR = config
  process.env.CLAUDIN_TMPDIR = tmp
  process.env.GIT_CONFIG_GLOBAL = '/dev/null'
  process.env.GIT_CONFIG_NOSYSTEM = '1'

  getManagedFilePath.cache.set(undefined, admin)
  getManagedSettingsDropInDir.cache.set(undefined, join(admin, 'managed-settings.d'))
  setFlagSettingsPath(undefined)

  const moveSession = (dir: string) => {
    setOriginalCwd(dir)
    setCwdState(dir)
    setProjectRoot(dir)
    dropMemos()
  }
  moveSession(project)

  return {
    root,
    project,
    outside,
    config,
    tmp,
    admin,
    file(path, text = '') {
      mkdirSync(dirname(path), { recursive: true })
      writeFileSync(path, text)
      return path
    },
    dir(path) {
      mkdirSync(path, { recursive: true })
      return path
    },
    link(link, target) {
      mkdirSync(dirname(link), { recursive: true })
      symlinkSync(target, link)
      return link
    },
    gitInit(dir) {
      const run = spawnSync('git', ['init', '-q', dir], {
        env: { ...process.env, HOME: root },
      })
      if (run.status !== 0) throw new Error(`git init failed: ${run.stderr}`)
    },
    moveSession,
    pretendPlatform(platform) {
      getPlatform.cache.set(undefined, platform)
    },
    forget: dropMemos,
    close() {
      getPlatform.cache.clear?.()
      getManagedFilePath.cache.delete(undefined)
      getManagedSettingsDropInDir.cache.delete(undefined)
      for (const key of ISOLATED_ENV) {
        const value = saved.env[key]
        if (value === undefined) delete process.env[key]
        else process.env[key] = value
      }
      setFlagSettingsPath(saved.flagPath)
      setOriginalCwd(saved.originalCwd)
      setCwdState(saved.cwd)
      setProjectRoot(saved.projectRoot)
      dropMemos()
      rmSync(root, { recursive: true, force: true })
    },
  }
}

type RuleList = { allow?: string[]; deny?: string[] }

/**
 * A permission context: `mode` (default 'default'), extra working
 * directories, and allow/deny rules given as CLI-argument rule strings.
 */
export function permissionContext(
  options: {
    mode?: ToolPermissionContext['mode']
    dirs?: string[]
  } & RuleList = {},
): ToolPermissionContext {
  const base = getEmptyToolPermissionContext()
  return {
    ...base,
    mode: options.mode ?? 'default',
    additionalWorkingDirectories: new Map(
      (options.dirs ?? []).map(d => [d, { path: d, source: 'cliArg' as const }]),
    ),
    alwaysAllowRules: options.allow ? { cliArg: options.allow } : {},
    alwaysDenyRules: options.deny ? { cliArg: options.deny } : {},
  }
}

/** The rule-pattern spelling of an absolute path (`//abs/path`). */
export function absoluteRule(tool: 'Read' | 'Edit', path: string): string {
  return `${tool}(/${path})`
}

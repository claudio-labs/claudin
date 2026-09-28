/**
 * Where markdown configuration is read from, in reading order, and the
 * settings and policy that switch each source off. Evaluated on every load:
 * the environment, the setting sources and the policy can change between them.
 */
import { join } from 'path'

import {
  type ClaudeConfigDirectory,
  configSubdirOf,
} from 'src/memory/instructions/markdownConfig/configDirectories.js'
import {
  projectWalkDeps,
  walkProjectConfigDirs,
  worktreeFallbackDirs,
} from 'src/memory/instructions/markdownConfig/projectDirectories.js'
import { isSettingSourceEnabled, type SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import {
  type CustomizationSurface,
  isRestrictedToPluginOnly,
} from 'src/platform/settings/pluginOnlyPolicy.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'

export type SourceDirectory = { source: SettingSource; baseDir: string }

type LoadScope = {
  subdir: ClaudeConfigDirectory
  cwd: string
  /** The upward walk, run once, and only when a project source is on. */
  walked: () => readonly string[]
}

type ConfigSource = {
  source: SettingSource
  isOn: (subdir: ClaudeConfigDirectory) => boolean
  directories: (scope: LoadScope) => readonly string[]
}

// Only agents are locked here. The skills listing applies the lock to legacy
// commands itself, and the other subdirectories have no surface of their own.
const PLUGIN_LOCKABLE: Partial<Record<ClaudeConfigDirectory, CustomizationSurface>> = {
  agents: 'agents',
}

function isLockedToPlugins(subdir: ClaudeConfigDirectory): boolean {
  const surface = PLUGIN_LOCKABLE[subdir]
  return surface !== undefined && isRestrictedToPluginOnly(surface)
}

function readsFrom(source: 'userSettings' | 'projectSettings'): ConfigSource['isOn'] {
  return subdir => isSettingSourceEnabled(source) && !isLockedToPlugins(subdir)
}

const CONFIG_SOURCES: readonly ConfigSource[] = [
  {
    // Set by an administrator: neither the setting sources nor the lock apply.
    source: 'policySettings',
    isOn: () => true,
    directories: ({ subdir }) => [configSubdirOf(getManagedFilePath(), subdir)],
  },
  {
    source: 'userSettings',
    isOn: readsFrom('userSettings'),
    directories: ({ subdir }) => [join(getClaudinConfigHomeDir(), subdir)],
  },
  {
    source: 'projectSettings',
    isOn: readsFrom('projectSettings'),
    directories: ({ walked }) => walked(),
  },
  {
    source: 'projectSettings',
    isOn: readsFrom('projectSettings'),
    directories: ({ subdir, cwd, walked }) =>
      worktreeFallbackDirs(subdir, cwd, walked(), projectWalkDeps),
  },
]

/** Throws what the upward walk throws. */
export function sourceDirectoriesFor(subdir: ClaudeConfigDirectory, cwd: string): SourceDirectory[] {
  let walk: readonly string[] | undefined
  const scope: LoadScope = {
    subdir,
    cwd,
    walked: () => (walk ??= walkProjectConfigDirs(subdir, cwd, projectWalkDeps)),
  }
  return CONFIG_SOURCES.filter(row => row.isOn(subdir)).flatMap(row =>
    row.directories(scope).map(baseDir => ({ source: row.source, baseDir })),
  )
}

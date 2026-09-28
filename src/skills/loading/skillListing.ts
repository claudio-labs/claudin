/**
 * The skills listed for a cwd: the enabled sources in order, each file once,
 * the path-scoped skills held back until a matching file is touched, and one
 * cached result per cwd.
 */
import { join } from 'path'

import { getProjectDirsUpToHome } from 'src/memory/instructions/markdownConfigLoader.js'
import { getAdditionalDirectoriesForClaudeMd } from 'src/platform/bootstrap/state.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getManagedFilePath } from 'src/platform/settings/managedPath.js'
import { logForDebugging } from 'src/shared/debug.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import type { Command } from 'src/shared/types/command.js'
import {
  clearLegacyCommandsCache,
  readLegacyCommands,
} from 'src/skills/loading/legacyCommands.js'
import {
  forgetPathScopedSkills,
  holdPathScopedSkill,
  wasActivated,
} from 'src/skills/loading/sessionSkills.js'
import {
  type LoadedSkill,
  readSkillsDirectory,
  realPathOf,
} from 'src/skills/loading/skillsDirectory.js'
import {
  allowsProjectSkills,
  readSourceGates,
  type SourceGates,
} from 'src/skills/loading/sourceGates.js'

type SkillSource = {
  source: SettingSource
  isOn: (gates: SourceGates) => boolean
  directories: (cwd: string) => string[]
}

const CONFIG_DIR = '.claudin'

// In listing order. Bare mode keeps only the `--add-dir` row, whose project
// gates still apply: bare mode is no way around the policy.
const SKILL_SOURCES: readonly SkillSource[] = [
  {
    source: 'policySettings',
    isOn: gates => !gates.bare && gates.managedSkills,
    directories: () => [getSkillsPath('policySettings', 'skills')],
  },
  {
    source: 'userSettings',
    isOn: gates => !gates.bare && gates.userSettings && !gates.lockedToPlugins,
    directories: () => [getSkillsPath('userSettings', 'skills')],
  },
  {
    source: 'projectSettings',
    isOn: gates => !gates.bare && allowsProjectSkills(gates),
    directories: cwd => getProjectDirsUpToHome('skills', cwd),
  },
  {
    source: 'projectSettings',
    isOn: allowsProjectSkills,
    directories: () =>
      getAdditionalDirectoriesForClaudeMd().map(dir => join(dir, CONFIG_DIR, 'skills')),
  },
]

/** Last in the listing. The plugin-only lock drops the managed ones too. */
const legacyCommandsOn = (gates: SourceGates): boolean =>
  !gates.bare && !gates.lockedToPlugins

const listings = new Map<string, Promise<Command[]>>()

export function getSkillDirCommands(cwd: string): Promise<Command[]> {
  const cached = listings.get(cwd)
  if (cached !== undefined) return cached
  const listing = loadListing(cwd).catch((error: unknown) => {
    // Not kept, so that the next call tries again.
    listings.delete(cwd)
    throw error
  })
  listings.set(cwd, listing)
  return listing
}

export function clearSkillCaches(): void {
  listings.clear()
  clearLegacyCommandsCache()
  forgetPathScopedSkills()
}

/** Where a source keeps its skills or commands; a project's is relative. */
export function getSkillsPath(source: SettingSource | 'plugin', dir: 'skills' | 'commands'): string {
  switch (source) {
    case 'policySettings':
      return join(getManagedFilePath(), CONFIG_DIR, dir)
    case 'userSettings':
      return join(getClaudinConfigHomeDir(), dir)
    case 'projectSettings':
      return `${CONFIG_DIR}/${dir}`
    case 'plugin':
      return 'plugin'
    default:
      return ''
  }
}

async function loadListing(cwd: string): Promise<Command[]> {
  const gates = readSourceGates()
  const [skills, legacyCommands] = await Promise.all([
    readSkillSources(cwd, gates),
    legacyCommandsOn(gates) ? readLegacyCommands(cwd) : [],
  ])
  const unique = await withoutRepeatedFiles([...skills, ...legacyCommands])
  // The file tools do not activate path-scoped skills in bare mode, so a held
  // skill would never show up: bare mode lists them all at once.
  if (gates.bare) return unique.map(skill => skill.command)
  return listOrHold(unique)
}

async function readSkillSources(
  cwd: string,
  gates: SourceGates,
): Promise<LoadedSkill[]> {
  const reads = SKILL_SOURCES.filter(entry => entry.isOn(gates)).flatMap(entry =>
    entry.directories(cwd).map(dir => readSkillsDirectory(dir, entry.source)),
  )
  return (await Promise.all(reads)).flat()
}

/**
 * When two entries reach the same file through symlinks, the first one wins,
 * whatever its name. One whose real path does not resolve is kept.
 */
async function withoutRepeatedFiles(
  skills: readonly LoadedSkill[],
): Promise<LoadedSkill[]> {
  const realPaths = await Promise.all(skills.map(skill => realPathOf(skill.filePath)))
  const seen = new Set<string>()
  return skills.filter((skill, index) => {
    const realPath = realPaths[index]
    if (realPath === undefined) return true
    if (seen.has(realPath)) {
      logForDebugging(`[skills] ${skill.filePath} is ${realPath}, listed already`)
      return false
    }
    seen.add(realPath)
    return true
  })
}

function listOrHold(skills: readonly LoadedSkill[]): Command[] {
  const listed: Command[] = []
  for (const { command } of skills) {
    if (command.paths !== undefined && !wasActivated(command.name)) {
      holdPathScopedSkill(command, command.paths)
    } else {
      listed.push(command)
    }
  }
  return listed
}

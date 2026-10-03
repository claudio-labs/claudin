import { join, normalize, sep } from 'path'
import { getPlansDirectory } from 'src/agent/plans/plans.js'
import { getScratchpadDir, isScratchpadEnabled } from 'src/agent/scratchpad.js'
import { getToolResultsDir } from 'src/agent/tools/toolResultStorage.js'
import { hasAutoMemPathOverride, isAutoMemPath } from 'src/memory/memdir/paths.js'
import { getSessionMemoryDir } from 'src/memory/session/paths.js'
import { pathInWorkingPath } from 'src/permissions/filePermissions/workingDirs.js'
import { normalizeCaseForComparison } from 'src/permissions/filePermissions/pathCase.js'
import type { PermissionResult } from 'src/permissions/PermissionResult.js'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { SETTING_SOURCES } from 'src/platform/settings/constants.js'
import { getSettingsFilePathForSource } from 'src/platform/settings/settings.js'
import { getProjectTempDir } from 'src/platform/tmpdir.js'
import { getProjectDir } from 'src/sessions/sessionStorage.js'
import { getClaudinConfigHomeDir } from 'src/shared/envUtils.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { expandPath } from 'src/shared/fs/path.js'
import { getBundledSkillsRoot } from 'src/skills/bundledSkillsRoot.js'
import { isAgentMemoryPath } from 'src/tools/AgentTool/agentMemory.js'

const AGENT_DIRECTORY = '.claudin'

/** The `.claudin` entries of the session's project that configure the agent. */
const PROJECT_CONFIG_DIRECTORIES = ['commands', 'agents', 'skills'] as const

/** Settings file names that are settings in whichever project they sit. */
const PROJECT_SETTINGS_FILE_NAMES = ['settings.json', 'settings.local.json'] as const

/** Characters that would turn a skill name into a rule pattern of its own. */
const UNSAFE_SKILL_NAME = /\.\.|[*?[\]]/

// ─── Settings and config ────────────────────────────────────────────────────

function settingsFilesOfEverySource(): string[] {
  return SETTING_SOURCES.map(getSettingsFilePathForSource).filter(
    (path): path is string => path !== undefined,
  )
}

function foldedAbsolute(path: string): string {
  return normalizeCaseForComparison(expandPath(path))
}

export function isClaudeSettingsPath(filePath: string): boolean {
  const target = foldedAbsolute(filePath)
  const isProjectSettings = PROJECT_SETTINGS_FILE_NAMES.some(name =>
    target.endsWith(`${sep}${AGENT_DIRECTORY}${sep}${name}`),
  )
  if (isProjectSettings) return true
  return settingsFilesOfEverySource().some(
    settingsFile => foldedAbsolute(settingsFile) === target,
  )
}

export function isClaudeConfigFilePath(filePath: string): boolean {
  if (isClaudeSettingsPath(filePath)) return true
  const agentDirectory = join(getOriginalCwd(), AGENT_DIRECTORY)
  return PROJECT_CONFIG_DIRECTORIES.some(entry =>
    pathInWorkingPath(filePath, join(agentDirectory, entry)),
  )
}

// ─── Skill scope ────────────────────────────────────────────────────────────

type SkillRoot = { readonly directory: string; readonly rulePrefix: string }

function skillRoots(): SkillRoot[] {
  return [
    {
      directory: join(getOriginalCwd(), AGENT_DIRECTORY, 'skills'),
      rulePrefix: `/${AGENT_DIRECTORY}/skills/`,
    },
    {
      // Spelled from `~` whatever the config home is: that is the global rule
      // convention `fileRules` reads.
      directory: join(getClaudinConfigHomeDir(), 'skills'),
      rulePrefix: `~/${AGENT_DIRECTORY}/skills/`,
    },
  ]
}

function componentsOf(path: string): string[] {
  return path.split(sep).filter(part => part !== '')
}

/**
 * The components of `path` below `directory`, compared in any case, or null
 * when `path` is not below it.
 */
function componentsBelow(path: string, directory: string): string[] | null {
  const outer = componentsOf(directory)
  const inner = componentsOf(path)
  if (inner.length <= outer.length) return null
  const sharesPrefix = outer.every(
    (part, index) =>
      normalizeCaseForComparison(part) === normalizeCaseForComparison(inner[index] ?? ''),
  )
  return sharesPrefix ? inner.slice(outer.length) : null
}

export function getClaudeSkillScope(
  filePath: string,
): { skillName: string; pattern: string } | null {
  const target = expandPath(filePath)
  for (const root of skillRoots()) {
    const below = componentsBelow(target, root.directory)
    // A skill scope needs a file inside a skill: the name plus something more.
    if (below === null || below.length < 2) continue
    const skillName = below[0] ?? ''
    if (UNSAFE_SKILL_NAME.test(skillName)) return null
    return { skillName, pattern: `${root.rulePrefix}${skillName}/**` }
  }
  return null
}

// ─── Harness carve-outs ─────────────────────────────────────────────────────

type Operation = 'read' | 'write'

type Carveout = {
  /** What the allow reason names. */
  readonly label: string
  readonly opens: (operation: Operation) => boolean
  /** Receives the path with `.` and `..` applied, compared as text. */
  readonly contains: (path: string) => boolean
}

function withoutTrailingSeparator(directory: string): string {
  return directory.length > 1 && directory.endsWith(sep)
    ? directory.slice(0, -1)
    : directory
}

/** Anything strictly below `directory()`. */
function below(directory: () => string): (path: string) => boolean {
  return path => path.startsWith(withoutTrailingSeparator(directory()) + sep)
}

/** `directory()` itself and anything below it. */
function atOrBelow(directory: () => string): (path: string) => boolean {
  const strictlyBelow = below(directory)
  return path =>
    path === withoutTrailingSeparator(directory()) || strictlyBelow(path)
}

// Any `.md` directly in the plans directory, not only the current slug: the
// slug can be regenerated mid-session, and plan mode refuses every other
// write, so an exact-slug match could lock the agent out of its own plan.
// The plans owner keeps the directory itself inside the project or falls
// back to the config home.
function isPlanFile(path: string): boolean {
  const plans = withoutTrailingSeparator(getPlansDirectory())
  if (!path.startsWith(plans + sep)) return false
  const name = path.slice(plans.length + 1)
  return !name.includes(sep) && name.endsWith('.md')
}

function isPreviewLaunchConfig(path: string): boolean {
  const launchConfig = join(getOriginalCwd(), AGENT_DIRECTORY, 'launch.json')
  return normalizeCaseForComparison(path) === normalizeCaseForComparison(launchConfig)
}

const readOnly = (operation: Operation): boolean => operation === 'read'
const readAndWrite = (): boolean => true

/**
 * Listed in the order reads are tried; writes try the entries that open them
 * in the same order. Reason wording comes from `label`.
 */
const CARVEOUTS: readonly Carveout[] = [
  {
    label: 'session memory',
    opens: readOnly,
    contains: below(getSessionMemoryDir),
  },
  {
    label: "this project directory's session files",
    opens: readOnly,
    contains: atOrBelow(() => getProjectDir(getCwd())),
  },
  {
    label: 'plan files of this session',
    opens: readAndWrite,
    contains: isPlanFile,
  },
  {
    label: 'tool results',
    opens: readOnly,
    contains: atOrBelow(getToolResultsDir),
  },
  {
    label: 'the session scratchpad',
    opens: () => isScratchpadEnabled(),
    contains: atOrBelow(getScratchpadDir),
  },
  {
    label: 'the project temp directory',
    opens: readOnly,
    contains: below(getProjectTempDir),
  },
  {
    label: 'agent memory',
    opens: readAndWrite,
    contains: path => isAgentMemoryPath(path),
  },
  {
    label: 'auto memory',
    // A memory override points at a directory the user chose, not one the
    // harness made, so writes there go through the normal checks.
    opens: operation => operation === 'read' || !hasAutoMemPathOverride(),
    contains: path => isAutoMemPath(path),
  },
  {
    label: 'task files',
    opens: readOnly,
    contains: atOrBelow(() => join(getClaudinConfigHomeDir(), 'tasks')),
  },
  {
    label: 'team files',
    opens: readOnly,
    contains: atOrBelow(() => join(getClaudinConfigHomeDir(), 'teams')),
  },
  {
    label: 'bundled skill files',
    opens: readOnly,
    contains: below(getBundledSkillsRoot),
  },
  {
    label: 'the preview launch config',
    opens: operation => operation === 'write',
    contains: isPreviewLaunchConfig,
  },
]

const GERUND: Record<Operation, string> = { read: 'Reading', write: 'Writing' }

function openedByCarveout(
  absolutePath: string,
  input: { [key: string]: unknown },
  operation: Operation,
): PermissionResult {
  const path = normalize(absolutePath)
  const carveout = CARVEOUTS.find(
    entry => entry.opens(operation) && entry.contains(path),
  )
  if (carveout === undefined) return { behavior: 'passthrough', message: '' }
  return {
    behavior: 'allow',
    updatedInput: input,
    decisionReason: {
      type: 'other',
      reason: `${GERUND[operation]} ${carveout.label} needs no prompt`,
    },
  }
}

export function checkEditableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  return openedByCarveout(absolutePath, input, 'write')
}

export function checkReadableInternalPath(
  absolutePath: string,
  input: { [key: string]: unknown },
): PermissionResult {
  return openedByCarveout(absolutePath, input, 'read')
}

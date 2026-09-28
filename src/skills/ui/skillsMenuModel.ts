/**
 * The /skills dialog as plain data: which commands it lists, the group each
 * one falls in, the order of the groups and of their rows, and the text of
 * every heading and row. SkillsMenu.tsx renders the result and handles the
 * keys. docs/tech/rewrite/skills/SkillsMenu.md is the spec.
 */
import type { Command, CommandBase, PromptCommand } from 'src/commands/commands.js'

/** A command the dialog treats as a skill. */
export type Skill = CommandBase & PromptCommand

type Origin = NonNullable<CommandBase['loadedFrom']>

/** A source whose skills live in a directory, in the terms `getSkillsPath` takes. */
type DirectorySource = 'projectSettings' | 'userSettings' | 'policySettings' | 'plugin'

type GroupSource = DirectorySource | 'mcp'

/** What the model needs from outside: where a source keeps its files, and what a skill costs. */
export type SkillsMenuDeps = {
  /** The directory a source keeps its skills, or its legacy commands, in, as the dialog shows a path. */
  directoryOf: (source: DirectorySource, dir: 'skills' | 'commands') => string
  /** The formatted estimate of what a skill puts in the prompt ahead of time: `7`, `1.5k`. */
  estimateOf: (skill: Skill) => string
}

type SkillRow = {
  /** Unique within the group, two skills of the same name included. */
  key: string
  /** The name, then ` - ` and its last segment when the name is namespaced. */
  label: string
  /** What follows the label, dim: the plugin, for a plugin skill that names one, then the estimate. */
  detail: string
}

export type SkillGroup = {
  source: GroupSource
  title: string
  /** Shown in parentheses after the title. An MCP group whose skills name no server has none. */
  subtitle?: string
  rows: SkillRow[]
}

type SubtitleRule = (skills: readonly Skill[], deps: SkillsMenuDeps) => string | undefined

type GroupRule = {
  source: GroupSource
  title: string
  /** Receives the group's skills in row order. */
  subtitle: SubtitleRule
}

/** Bundled and managed prompts, and prompts with no origin, are not listed. */
const SKILL_ORIGINS: ReadonlySet<Origin> = new Set<Origin>(['skills', 'commands_DEPRECATED', 'plugin', 'mcp'])

const SEPARATOR = ' · '

/**
 * Prompt commands loaded from a skills directory, a legacy commands directory,
 * a plugin or an MCP server. Hidden and model-disabled skills count too.
 */
export function isSkill(command: Command): command is Skill {
  return command.type === 'prompt' && command.loadedFrom !== undefined && SKILL_ORIGINS.has(command.loadedFrom)
}

/** A namespaced name repeats its last segment: `frontend:lint - lint`. */
export function skillLabel(name: string): string {
  const lastColon = name.lastIndexOf(':')
  return lastColon === -1 ? name : `${name} - ${name.slice(lastColon + 1)}`
}

/** The server an MCP skill's name starts with: `srv` for `srv:deploy`, none for `plain` or `:plain`. */
export function mcpServerOf(name: string): string | undefined {
  const firstColon = name.indexOf(':')
  return firstColon > 0 ? name.slice(0, firstColon) : undefined
}

/** A file-based group shows its skills directory, and its commands directory too once it holds a legacy command. */
function directoriesOf(source: DirectorySource): SubtitleRule {
  return (skills, deps) => {
    const directories = [deps.directoryOf(source, 'skills')]
    if (skills.some(skill => skill.loadedFrom === 'commands_DEPRECATED')) {
      directories.push(deps.directoryOf(source, 'commands'))
    }
    return directories.join(', ')
  }
}

/** Each server once, in row order; no subtitle at all when no skill names one. */
function mcpServers(skills: readonly Skill[]): string | undefined {
  const servers = new Set(skills.flatMap(skill => mcpServerOf(skill.name) ?? []))
  return servers.size > 0 ? [...servers].join(', ') : undefined
}

/** The groups in display order. A source missing from this table gets no group, so its skills are not listed. */
const GROUPS: readonly GroupRule[] = [
  { source: 'projectSettings', title: 'Project skills', subtitle: directoriesOf('projectSettings') },
  { source: 'userSettings', title: 'User skills', subtitle: directoriesOf('userSettings') },
  { source: 'policySettings', title: 'Managed skills', subtitle: directoriesOf('policySettings') },
  // getSkillsPath calls a plugin's directory `plugin`, so the heading reads `Plugin skills (plugin)`.
  { source: 'plugin', title: 'Plugin skills', subtitle: directoriesOf('plugin') },
  { source: 'mcp', title: 'MCP skills', subtitle: mcpServers },
]

/** Only a skill from the plugin source names its plugin, and only when the manifest has a name. */
function pluginNameOf(skill: Skill): string | undefined {
  if (skill.source !== 'plugin') return undefined
  return skill.pluginInfo?.pluginManifest.name || undefined
}

function rowDetail(skill: Skill, deps: SkillsMenuDeps): string {
  const plugin = pluginNameOf(skill)
  const pluginPart = plugin === undefined ? '' : `${SEPARATOR}${plugin}`
  return `${pluginPart}${SEPARATOR}~${deps.estimateOf(skill)} description tokens`
}

/** The key counts earlier rows of the same name, so a repeated name still gets a key of its own. */
function toRows(skills: readonly Skill[], deps: SkillsMenuDeps): SkillRow[] {
  const seen = new Map<string, number>()
  return skills.map(skill => {
    const occurrence = seen.get(skill.name) ?? 0
    seen.set(skill.name, occurrence + 1)
    return { key: `${occurrence}:${skill.name}`, label: skillLabel(skill.name), detail: rowDetail(skill, deps) }
  })
}

// localeCompare with no locale or options, so `Bravo` sorts between `alpha` and `charlie`.
function byName(a: Skill, b: Skill): number {
  return a.name.localeCompare(b.name)
}

/** The groups that hold at least one skill, in display order, with their rows sorted by name. */
export function groupSkills(commands: readonly Command[], deps: SkillsMenuDeps): SkillGroup[] {
  const skills = commands.filter(isSkill)
  return GROUPS.flatMap(group => {
    const members = skills.filter(skill => skill.source === group.source).toSorted(byName)
    if (members.length === 0) return []
    const subtitle = group.subtitle(members, deps)
    return [{ source: group.source, title: group.title, subtitle, rows: toRows(members, deps) }]
  })
}

/** The dialog's subtitle. It counts rows, so a skill no group shows is not counted either. */
export function skillCountText(groups: readonly SkillGroup[]): string {
  const count = groups.reduce((total, group) => total + group.rows.length, 0)
  return count === 1 ? '1 skill' : `${count} skills`
}

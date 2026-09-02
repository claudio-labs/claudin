/**
 * The pieces an adapter composes.
 *
 * Each collector reads one surface of a foreign agent and returns a partial
 * `ImportPlan`. Adapters are then table-shaped: they say which directories and
 * files to point these at, and which translator to use, and hold no logic of
 * their own. Statuses are all `'new'` here — `diff.ts` is what compares a plan
 * against what is already on disk.
 */
import { join } from 'path'

import type { McpTranslation } from 'src/platform/import/translate/mcpServers.js'
import {
  type AgentDialect,
  translateMarkdownAgent,
  translateYamlAgent,
} from 'src/platform/import/translate/agents.js'
import {
  type CommandDialect,
  translateMarkdownCommand,
  translateTomlCommand,
} from 'src/platform/import/translate/commands.js'
import {
  readTextFile,
  readTomlFile,
  readYamlFile,
} from 'src/platform/import/translate/readConfig.js'
import { translateCursorRule } from 'src/platform/import/translate/rules.js'
import { asTable, type JsonTable } from 'src/platform/import/translate/values.js'
import {
  agentsDir,
  commandsDir,
  globalConfigPath,
  instructionsPath,
  rulesDir,
  settingsPath,
  skillsDir,
} from 'src/platform/import/destinations.js'
import {
  emptyPlan,
  type CollectContext,
  type ForeignAgentId,
  type ImportArtifact,
  type ImportPlan,
  type ImportScope,
} from 'src/platform/import/types.js'
import type { ProviderProfileInput } from 'src/providers/presets/providerProfiles.js'
import { agentNameFromFileName } from 'src/platform/import/translate/agents.js'
import { commandNameFromRelativePath } from 'src/platform/import/translate/commands.js'
import {
  listFilesRecursive,
  countTopLevelEntries,
} from 'src/platform/import/writers/files.js'
import { existsSync, readdirSync, statSync } from 'fs'

export type CollectorTarget = {
  ctx: CollectContext
  agent: ForeignAgentId
  scope: ImportScope
}

function base(
  target: CollectorTarget,
  source: string,
  destination: string,
): Pick<
  ImportArtifact,
  'agent' | 'scope' | 'source' | 'destination' | 'status'
> {
  return {
    agent: target.agent,
    scope: target.scope,
    source,
    destination,
    status: 'new',
  }
}

function noteWarning(
  plan: ImportPlan,
  source: string,
  name: string,
  detail: string,
): void {
  plan.warnings.push(`${name} (${source}): ${detail}`)
}

export function collectMcpServers(
  target: CollectorTarget,
  sourcePath: string,
  servers: JsonTable,
  translate: (raw: unknown) => McpTranslation,
): ImportPlan {
  const plan = emptyPlan()
  for (const [name, raw] of Object.entries(servers)) {
    const translated = translate(raw)
    if (!translated.ok) {
      noteWarning(plan, sourcePath, `MCP server "${name}"`, translated.reason)
      continue
    }
    if (translated.note) {
      noteWarning(plan, sourcePath, `MCP server "${name}"`, translated.note)
    }
    plan.artifacts.push({
      ...base(target, sourcePath, mcpDestinationLabel(target)),
      kind: 'mcpServer',
      name,
      config: translated.config,
    })
  }
  return plan
}

/**
 * A user-scope server goes into `~/.claudin/config.json`; a project-scope one
 * goes into this project's private config, NOT the shared `.mcp.json` — an
 * import should not put a new entry into a file the user is likely to commit.
 */
function mcpDestinationLabel(target: CollectorTarget): string {
  return target.scope === 'user'
    ? 'user MCP config'
    : 'project MCP config (private)'
}

export function collectMarkdownCommands(
  target: CollectorTarget,
  sourceDir: string,
  dialect: CommandDialect,
): ImportPlan {
  const plan = emptyPlan()
  const destDir = commandsDir(target.ctx, target.scope)
  for (const relative of listFilesRecursive(sourceDir, ['.md'])) {
    const sourcePath = join(sourceDir, relative)
    const read = readTextFile(sourcePath)
    if (!read.ok) {
      noteWarning(plan, sourcePath, 'command', read.message)
      continue
    }
    const translated = translateMarkdownCommand(relative, read.value, dialect)
    if (!translated.ok) {
      noteWarning(plan, sourcePath, 'command', translated.reason)
      continue
    }
    for (const note of translated.command.notes) {
      noteWarning(plan, sourcePath, `command "${translated.command.name}"`, note)
    }
    plan.artifacts.push({
      ...base(
        target,
        sourcePath,
        join(destDir, translated.command.relativePath),
      ),
      kind: 'command',
      name: translated.command.name,
      markdown: translated.command.markdown,
    })
  }
  return plan
}

/**
 * Gemini's commands are TOML; Qwen's are markdown now and TOML historically,
 * with both formats living in the same directory during the migration. Reading
 * both is what keeps a half-migrated Qwen install from importing as half a set.
 */
export function collectTomlCommands(
  target: CollectorTarget,
  sourceDir: string,
): ImportPlan {
  const plan = emptyPlan()
  const destDir = commandsDir(target.ctx, target.scope)
  for (const relative of listFilesRecursive(sourceDir, ['.toml'])) {
    const sourcePath = join(sourceDir, relative)
    const read = readTomlFile(sourcePath)
    if (!read.ok) {
      noteWarning(plan, sourcePath, 'command', read.message)
      continue
    }
    const translated = translateTomlCommand(relative, read.value)
    if (!translated.ok) {
      noteWarning(plan, sourcePath, 'command', translated.reason)
      continue
    }
    for (const note of translated.command.notes) {
      noteWarning(plan, sourcePath, `command "${translated.command.name}"`, note)
    }
    plan.artifacts.push({
      ...base(
        target,
        sourcePath,
        join(destDir, translated.command.relativePath),
      ),
      kind: 'command',
      name: translated.command.name,
      markdown: translated.command.markdown,
    })
  }
  return plan
}

export function collectAgents(
  target: CollectorTarget,
  sourceDir: string,
  dialect: AgentDialect,
): ImportPlan {
  const plan = emptyPlan()
  const destDir = agentsDir(target.ctx, target.scope)
  for (const relative of listFilesRecursive(sourceDir, [
    '.md',
    '.yaml',
    '.yml',
  ])) {
    const sourcePath = join(sourceDir, relative)
    const isYaml = relative.endsWith('.yaml') || relative.endsWith('.yml')
    let translated: ReturnType<typeof translateMarkdownAgent>
    if (isYaml) {
      const read = readYamlFile(sourcePath)
      if (!read.ok) {
        noteWarning(plan, sourcePath, 'agent', read.message)
        continue
      }
      translated = translateYamlAgent(relative, read.value, dialect)
    } else {
      const read = readTextFile(sourcePath)
      if (!read.ok) {
        noteWarning(plan, sourcePath, 'agent', read.message)
        continue
      }
      translated = translateMarkdownAgent(relative, read.value, dialect)
    }
    if (!translated.ok) {
      noteWarning(plan, sourcePath, 'agent', translated.reason)
      continue
    }
    for (const note of translated.agent.notes) {
      noteWarning(plan, sourcePath, `agent "${translated.agent.name}"`, note)
    }
    plan.artifacts.push({
      ...base(target, sourcePath, join(destDir, translated.agent.relativePath)),
      kind: 'agent',
      name: translated.agent.name,
      markdown: translated.agent.markdown,
    })
  }
  return plan
}

export function collectCursorRules(
  target: CollectorTarget,
  sourceDir: string,
): ImportPlan {
  const plan = emptyPlan()
  const destDir = rulesDir(target.ctx, target.scope)
  // `.md` in .cursor/rules is ignored by Cursor itself, so only `.mdc` counts.
  for (const relative of listFilesRecursive(sourceDir, ['.mdc'])) {
    const sourcePath = join(sourceDir, relative)
    const read = readTextFile(sourcePath)
    if (!read.ok) {
      noteWarning(plan, sourcePath, 'rule', read.message)
      continue
    }
    const translated = translateCursorRule(relative, read.value)
    if (!translated.ok) {
      noteWarning(plan, sourcePath, 'rule', translated.reason)
      continue
    }
    for (const note of translated.rule.notes) {
      noteWarning(plan, sourcePath, `rule "${translated.rule.name}"`, note)
    }
    plan.artifacts.push({
      ...base(target, sourcePath, join(destDir, translated.rule.relativePath)),
      kind: 'rule',
      name: translated.rule.name,
      markdown: translated.rule.markdown,
    })
  }
  return plan
}

export function collectInstructions(
  target: CollectorTarget,
  sourcePath: string,
): ImportPlan {
  const plan = emptyPlan()
  const read = readTextFile(sourcePath)
  if (!read.ok) {
    if (read.reason !== 'missing') {
      noteWarning(plan, sourcePath, 'instructions', read.message)
    }
    return plan
  }
  if (read.value.trim().length === 0) return plan
  plan.artifacts.push({
    ...base(target, sourcePath, instructionsPath(target.ctx, target.scope)),
    kind: 'instructions',
    text: read.value,
  })
  return plan
}

/**
 * A skill is a directory with a `SKILL.md` in it, so this lists the immediate
 * children of `sourceDir` that qualify rather than walking the whole tree.
 */
export function collectSkillDirs(
  target: CollectorTarget,
  sourceDir: string,
): ImportPlan {
  const plan = emptyPlan()
  if (!existsSync(sourceDir)) return plan
  const destDir = skillsDir(target.ctx, target.scope)
  let entries: string[]
  try {
    entries = readdirSync(sourceDir).sort()
  } catch {
    return plan
  }
  for (const entry of entries) {
    const dir = join(sourceDir, entry)
    try {
      if (!statSync(dir).isDirectory()) continue
    } catch {
      continue
    }
    if (!existsSync(join(dir, 'SKILL.md'))) continue
    plan.artifacts.push({
      ...base(target, dir, join(destDir, entry)),
      kind: 'skillDir',
      name: entry,
      sourceDir: dir,
    })
  }
  return plan
}

/**
 * Counts a permission list without importing it. Only Claude Code and
 * openclaude use our exact rule syntax; for everyone else a translation would
 * be a guess, and a wrong guess in a `deny` list is a permission granted.
 */
export function reportUnimportablePermissions(
  agent: ForeignAgentId,
  sourcePath: string,
  allow: unknown,
  deny: unknown,
): ImportPlan {
  const plan = emptyPlan()
  const allowCount = Array.isArray(allow) ? allow.length : 0
  const denyCount = Array.isArray(deny) ? deny.length : 0
  if (allowCount + denyCount === 0) return plan
  plan.notImportable.push({
    agent,
    label: 'permissions',
    detail: `${allowCount} allow, ${denyCount} deny in ${sourcePath} — rule syntax differs, see /permissions`,
  })
  return plan
}

export function directoryHasEntries(dir: string): boolean {
  return countTopLevelEntries(dir) > 0
}

/**
 * Claude Code and openclaude write our own file formats, so their commands and
 * agents cross over byte for byte. Doing this as per-file artifacts rather than
 * a directory copy is what gives the preview a real count and per-file conflict
 * detection.
 */
export function collectVerbatimMarkdown(
  target: CollectorTarget,
  sourceDir: string,
  kind: 'command' | 'agent',
): ImportPlan {
  const plan = emptyPlan()
  const destDir =
    kind === 'command'
      ? commandsDir(target.ctx, target.scope)
      : agentsDir(target.ctx, target.scope)
  for (const relative of listFilesRecursive(sourceDir, ['.md'])) {
    const sourcePath = join(sourceDir, relative)
    const read = readTextFile(sourcePath)
    if (!read.ok) {
      noteWarning(plan, sourcePath, kind, read.message)
      continue
    }
    if (read.value.trim().length === 0) continue
    const name =
      kind === 'command'
        ? commandNameFromRelativePath(relative)
        : agentNameFromFileName(relative)
    if (!name) continue
    plan.artifacts.push({
      ...base(
        target,
        sourcePath,
        join(destDir, kind === 'command' ? relative : `${name}.md`),
      ),
      kind,
      name,
      markdown: read.value,
    })
  }
  return plan
}

export function collectSettingsKeys(
  target: CollectorTarget,
  sourcePath: string,
  table: JsonTable,
  keys: readonly string[],
): ImportPlan {
  const plan = emptyPlan()
  const destination = settingsPath(target.ctx, target.scope)
  for (const key of keys) {
    const value = table[key]
    if (value === undefined || value === null) continue
    plan.artifacts.push({
      ...base(target, sourcePath, destination),
      kind: 'settingsKey',
      key,
      value,
    })
  }
  return plan
}

/**
 * A provider hint carries the shape of the foreign setup — base URL, model, and
 * the NAME of the env var holding the key — so `/provider` has somewhere to
 * start. No token is ever read, let alone copied.
 */
export function collectProviderHint(
  target: CollectorTarget,
  sourcePath: string,
  hint: {
    name: string
    provider: NonNullable<ProviderProfileInput['provider']>
    baseUrl: string
    model: string
    envKey?: string
  },
): ImportPlan {
  const plan = emptyPlan()
  if (!hint.baseUrl && !hint.model) return plan
  plan.artifacts.push({
    ...base(target, sourcePath, globalConfigPath(target.ctx)),
    kind: 'providerHint',
    ...hint,
  })
  return plan
}

export function firstExistingPath(candidates: string[]): string | null {
  for (const candidate of candidates) {
    if (existsSync(candidate)) return candidate
  }
  return null
}

export function tableAt(root: JsonTable, key: string): JsonTable | null {
  return asTable(root[key])
}

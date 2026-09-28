/**
 * Frontmatter to fields: what each key of a SKILL.md or a legacy command
 * means, and the default it falls back to. Pure, apart from a debug line for
 * each value it drops.
 */
import { parseArgumentNames } from 'src/commands/argumentSubstitution.js'
import {
  extractDescriptionFromMarkdown,
  parseSlashCommandToolsFromFrontmatter,
} from 'src/memory/instructions/markdownConfigLoader.js'
import { type EffortValue, parseEffortValue } from 'src/providers/effort/effort.js'
import { parseUserSpecifiedModel } from 'src/providers/model/model.js'
import { logForDebugging } from 'src/shared/debug.js'
import {
  coerceDescriptionToString,
  type FrontmatterData,
  type FrontmatterShell,
  parseBooleanFrontmatter,
  parseShellFrontmatter,
} from 'src/shared/frontmatterParser.js'
import { type HooksSettings, HooksSchema } from 'src/shared/schemas/hooks.js'
import type { CommandBase, PromptCommand } from 'src/shared/types/command.js'

/**
 * What a skill's frontmatter says, with every default applied. A field that
 * the Command takes as it is, and may leave undefined, has the Command's type.
 */
export type SkillFrontmatterFields = {
  displayName: string | undefined
  /** The frontmatter's, else the first line of the body, else a fallback label. */
  description: string
  hasUserSpecifiedDescription: boolean
  allowedTools: string[]
  argumentHint: CommandBase['argumentHint']
  argumentNames: string[]
  whenToUse: CommandBase['whenToUse']
  version: CommandBase['version']
  model: PromptCommand['model']
  disableModelInvocation: boolean
  userInvocable: boolean
  hooks: PromptCommand['hooks']
  /** Narrower than the Command's `context`: the frontmatter keeps only `fork`. */
  executionContext: 'fork' | undefined
  agent: PromptCommand['agent']
  effort: PromptCommand['effort']
  /** Not on the Command: it picks the shell for the embedded commands. */
  shell: FrontmatterShell | undefined
}

/** What the description falls back to when neither frontmatter nor body has one. */
type DescriptionFallbackLabel = 'Skill' | 'Custom command'

const INHERIT_MODEL = 'inherit'
const FORK_CONTEXT = 'fork'

export function parseSkillFrontmatterFields(
  // As YAML parsed it: a number or a list may sit where a string is declared.
  frontmatter: FrontmatterData,
  markdownContent: string,
  resolvedName: string,
  descriptionFallbackLabel: DescriptionFallbackLabel = 'Skill',
): SkillFrontmatterFields {
  const description = coerceDescriptionToString(
    frontmatter.description,
    resolvedName,
  )
  return {
    displayName: optionalString(frontmatter.name),
    description:
      description ??
      extractDescriptionFromMarkdown(markdownContent, descriptionFallbackLabel),
    hasUserSpecifiedDescription: description !== null,
    allowedTools: parseSlashCommandToolsFromFrontmatter(frontmatter['allowed-tools']),
    argumentHint: optionalString(frontmatter['argument-hint']),
    argumentNames: argumentNamesOf(frontmatter.arguments),
    whenToUse: frontmatter.when_to_use ?? undefined,
    version: frontmatter.version ?? undefined,
    model: modelOverride(frontmatter.model),
    disableModelInvocation: parseBooleanFrontmatter(frontmatter['disable-model-invocation']),
    userInvocable:
      frontmatter['user-invocable'] == null ||
      parseBooleanFrontmatter(frontmatter['user-invocable']),
    hooks: validHooks(frontmatter.hooks, resolvedName),
    executionContext:
      frontmatter.context === FORK_CONTEXT ? FORK_CONTEXT : undefined,
    agent: frontmatter.agent ?? undefined,
    effort: effortOf(frontmatter.effort, resolvedName),
    shell: parseShellFrontmatter(frontmatter.shell, resolvedName),
  }
}

/** Any value YAML produced, as a string; absent and null stay undefined. */
function optionalString(value: unknown): string | undefined {
  return value == null ? undefined : String(value)
}

function argumentNamesOf(value: unknown): string[] {
  if (typeof value === 'string') return parseArgumentNames(value)
  if (Array.isArray(value)) {
    return parseArgumentNames(
      value.filter((name): name is string => typeof name === 'string'),
    )
  }
  return []
}

/** `inherit`, like an empty value, keeps the model of the conversation. */
function modelOverride(value: unknown): string | undefined {
  const model = optionalString(value)
  if (!model || model === INHERIT_MODEL) return undefined
  return parseUserSpecifiedModel(model)
}

/** Kept only when they validate, the same as hooks in settings. */
function validHooks(
  value: unknown,
  skillName: string,
): HooksSettings | undefined {
  if (value == null) return undefined
  const parsed = HooksSchema().safeParse(value)
  if (parsed.success) return parsed.data
  logForDebugging(
    `[skills] ${skillName}: hooks do not validate and are ignored: ${parsed.error.message}`,
    { level: 'warn' },
  )
  return undefined
}

function effortOf(value: unknown, skillName: string): EffortValue | undefined {
  const effort = parseEffortValue(value)
  if (effort === undefined && value != null && value !== '') {
    logForDebugging(
      `[skills] ${skillName}: effort '${String(value)}' is neither a level nor an integer and is ignored`,
      { level: 'warn' },
    )
  }
  return effort
}

/**
 * The rule each tool dialog's "don't ask again" saves, as plain data. A
 * function returns `null` when the input does not name a rule it can stand
 * behind; the dialog then saves nothing (and, for skills and fetches, does not
 * offer the option at all).
 */
import type { PermissionRuleValue, PermissionUpdate } from 'src/shared/types/permissions.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { SKILL_TOOL_NAME } from 'src/tools/SkillTool/constants.js'

/** The one update every allow-always answer reports: an allow rule kept in the project's local settings. */
export function addAllowRule(rule: PermissionRuleValue): PermissionUpdate {
  return { type: 'addRules', rules: [rule], behavior: 'allow', destination: 'localSettings' }
}

/** Tool-wide dialog: the whole tool, by the name rules match on (never the name shown). */
export function wholeToolRule(toolName: string): PermissionRuleValue {
  return { toolName }
}

/** The contents of the Skill rules a skill name can be saved under. */
export type SkillRuleContents = {
  exact: string
  /** Only for a name with a space after its first character: the text before that space, as `<first>:*`. */
  prefix: string | null
}

/**
 * Skill dialog. An empty name has no rule to save: an empty content would be
 * written as the bare `Skill` rule, which allows every skill.
 */
export function skillRuleContents(skill: string): SkillRuleContents | null {
  if (skill === '') return null
  const space = skill.indexOf(' ')
  return { exact: skill, prefix: space > 0 ? `${skill.slice(0, space)}:*` : null }
}

export function skillRule(content: string): PermissionRuleValue {
  return { toolName: SKILL_TOOL_NAME, ruleContent: content }
}

/** The host a fetch rule is keyed on, as the WHATWG parser reads it; `null` when there is none. */
export function fetchHost(url: unknown): string | null {
  if (typeof url !== 'string' || !URL.canParse(url)) return null
  const { hostname } = new URL(url)
  return hostname === '' ? null : hostname
}

/** Fetch dialog: the exact host, nothing of scheme, port, path or credentials. */
export function fetchRule(toolName: string, host: string): PermissionRuleValue {
  return { toolName, ruleContent: `domain:${host}` }
}

const WORDS_IN_PREFIX = 2

/**
 * Shell-delegate dialog: a Bash prefix rule on the command's first two words.
 * It is a Bash rule, wider than the option's label (spec Finding 2, kept).
 */
export function shellDelegateRule(command: unknown): PermissionRuleValue | null {
  if (typeof command !== 'string') return null
  const words = command.split(/\s+/).filter(word => word !== '')
  if (words.length === 0) return null
  return { toolName: BASH_TOOL_NAME, ruleContent: `${words.slice(0, WORDS_IN_PREFIX).join(' ')}:*` }
}

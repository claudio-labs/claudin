/**
 * Which allow rules would let the model execute arbitrary code before the
 * auto-mode classifier ever sees the command.
 *
 * Pure predicates plus the scan that applies them to the rules loaded from
 * disk and to `--allowed-tools`. Nothing here mutates a context — the stash
 * (dangerousRuleStash.ts) is what acts on the result.
 */
import { relative } from 'path'
import { getCwd } from 'src/shared/fs/cwd.js'
import type { SettingSource } from 'src/platform/settings/constants.js'
import { SETTING_SOURCES } from 'src/platform/settings/constants.js'
import { getSettingsFilePathForSource } from 'src/platform/settings/settings.js'
import { AGENT_TOOL_NAME } from 'src/tools/AgentTool/constants.js'
import { BASH_TOOL_NAME } from 'src/tools/BashTool/toolName.js'
import { POWERSHELL_TOOL_NAME } from 'src/tools/PowerShellTool/toolName.js'
import {
  CROSS_PLATFORM_CODE_EXEC,
  DANGEROUS_BASH_PATTERNS,
} from 'src/permissions/dangerousPatterns.js'
import type {
  PermissionRule,
  PermissionRuleSource,
  PermissionRuleValue,
} from 'src/permissions/PermissionRule.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
} from 'src/permissions/permissionRuleParser.js'

/** PowerShell-only ways to start a process, evaluate a string, or reach another session. */
const POWERSHELL_ONLY_LAUNCHERS = [
  'pwsh',
  'powershell',
  'cmd',
  'wsl',
  'iex',
  'invoke-expression',
  'icm',
  'invoke-command',
  'start-process',
  'saps',
  'start',
  'start-job',
  'sajb',
  'start-threadjob',
  'register-objectevent',
  'register-engineevent',
  'register-wmievent',
  'register-scheduledjob',
  'new-pssession',
  'nsn',
  'enter-pssession',
  'etsn',
  'add-type',
  'new-object',
] as const

/** `npm run` is invoked as `npm.exe run` on Windows: the suffix belongs to the executable word. */
function withExeSuffix(name: string): string {
  const [executable, ...args] = name.split(' ')
  return [`${executable}.exe`, ...args].join(' ')
}

/** Each way a rule body can name a command so that any invocation of it is allowed. */
const ALLOWING_SHAPES: ReadonlyArray<(body: string, name: string) => boolean> = [
  (body, name) => body === name,
  (body, name) => body === `${name}:*`,
  (body, name) => body === `${name}*`,
  (body, name) => body === `${name} *`,
  (body, name) => body.startsWith(`${name} -`) && body.endsWith('*'),
]

type ShellDanger = { toolName: string; names: readonly string[] }

const BASH_DANGER: ShellDanger = {
  toolName: BASH_TOOL_NAME,
  names: DANGEROUS_BASH_PATTERNS,
}

const POWERSHELL_DANGER: ShellDanger = {
  toolName: POWERSHELL_TOOL_NAME,
  names: [...CROSS_PLATFORM_CODE_EXEC, ...POWERSHELL_ONLY_LAUNCHERS].flatMap(name => [
    name,
    withExeSuffix(name),
  ]),
}

function allowsWholeTool(ruleContent: string | undefined): boolean {
  return ruleContent === undefined || ruleContent === '' || ruleContent.trim() === '*'
}

function isDangerousShellRule(
  shell: ShellDanger,
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== shell.toolName) return false
  if (allowsWholeTool(ruleContent)) return true
  // Lowercased even for Bash, which is case-sensitive: over-flagging here
  // only strips a rule in auto mode (kept for parity, spec finding 7).
  const body = ruleContent!.trim().toLowerCase()
  return shell.names.some(name => ALLOWING_SHAPES.some(shape => shape(body, name)))
}

export function isDangerousBashPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  return isDangerousShellRule(BASH_DANGER, toolName, ruleContent)
}

export function isDangerousPowerShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  return isDangerousShellRule(POWERSHELL_DANGER, toolName, ruleContent)
}

/** A sub-agent runs whatever it decides to, so any Agent allow rule skips the classifier. */
export function isDangerousTaskPermission(
  toolName: string,
  _ruleContent: string | undefined,
): boolean {
  return normalizeLegacyToolName(toolName) === AGENT_TOOL_NAME
}

const DANGER_PREDICATES = [
  isDangerousBashPermission,
  isDangerousPowerShellPermission,
  isDangerousTaskPermission,
] as const

function isDangerousRuleValue({ toolName, ruleContent }: PermissionRuleValue): boolean {
  return DANGER_PREDICATES.some(isDangerous => isDangerous(toolName, ruleContent))
}

export type DangerousPermissionInfo = {
  ruleValue: PermissionRuleValue
  source: PermissionRuleSource
  ruleDisplay: string
  sourceDisplay: string
}

const isSettingSource = (source: PermissionRuleSource): source is SettingSource =>
  (SETTING_SOURCES as readonly string[]).includes(source)

/** A settings file is shown by path, whichever of relative or absolute is shorter. */
function displayRuleSource(source: PermissionRuleSource): string {
  const file = isSettingSource(source) ? getSettingsFilePathForSource(source) : undefined
  if (!file) return source
  const fromCwd = relative(getCwd(), file)
  return fromCwd.length < file.length ? fromCwd : file
}

const wholeToolDisplay = (toolName: string): string => `${toolName}(*)`

function loadedRuleFinding(rule: PermissionRule): DangerousPermissionInfo {
  const { toolName, ruleContent } = rule.ruleValue
  return {
    ruleValue: rule.ruleValue,
    source: rule.source,
    ruleDisplay: ruleContent ? `${toolName}(${ruleContent})` : wholeToolDisplay(toolName),
    sourceDisplay: displayRuleSource(rule.source),
  }
}

const CLI_ALLOWED_TOOLS_DISPLAY = '--allowed-tools'

/** `Name` or `Name(body)` with no `)` inside the body. Name and body are trimmed. */
const SIMPLE_CLI_ENTRY = /^([^(]+)(?:\(([^)]*)\))?$/

/**
 * Reads an entry the simple way when it has that shape. Anything else goes
 * through the rule parser the permission check uses, so an entry such as
 * `Agent(a(b))` is judged as the rule it becomes (spec finding 6).
 */
function readCliEntry(entry: string): PermissionRuleValue {
  const simple = SIMPLE_CLI_ENTRY.exec(entry)
  if (!simple) return permissionRuleValueFromString(entry.trim())
  const [, name, body] = simple
  return { toolName: name!.trim(), ruleContent: body?.trim() }
}

function cliEntryFinding(entry: string): DangerousPermissionInfo | null {
  const ruleValue = readCliEntry(entry)
  if (!isDangerousRuleValue(ruleValue)) return null
  return {
    ruleValue,
    source: 'cliArg',
    ruleDisplay: ruleValue.ruleContent ? entry : wholeToolDisplay(ruleValue.toolName),
    sourceDisplay: CLI_ALLOWED_TOOLS_DISPLAY,
  }
}

export function findDangerousClassifierPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const fromLoaded = rules
    .filter(rule => rule.ruleBehavior === 'allow' && isDangerousRuleValue(rule.ruleValue))
    .map(loadedRuleFinding)
  const fromCli = cliAllowedTools
    .map(cliEntryFinding)
    .filter((found): found is DangerousPermissionInfo => found !== null)
  return [...fromLoaded, ...fromCli]
}

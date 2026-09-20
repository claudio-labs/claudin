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
import { normalizeLegacyToolName } from 'src/permissions/permissionRuleParser.js'

/**
 * Checks if a Bash permission rule is dangerous for auto mode.
 * A rule is dangerous if it would auto-allow commands that execute arbitrary code,
 * bypassing the classifier's safety evaluation.
 *
 * Dangerous patterns:
 * 1. Tool-level allow (Bash with no ruleContent) - allows ALL commands
 * 2. Prefix rules for script interpreters (python:*, node:*, etc.)
 * 3. Wildcard rules matching interpreters (python*, node*, etc.)
 */
export function isDangerousBashPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  // Only check Bash rules
  if (toolName !== BASH_TOOL_NAME) {
    return false
  }

  // Tool-level allow (Bash with no content, or Bash(*)) - allows ALL commands
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  const content = ruleContent.trim().toLowerCase()

  // Standalone wildcard (*) matches everything
  if (content === '*') {
    return true
  }

  // Check for dangerous patterns with prefix syntax (e.g., "python:*")
  // or wildcard syntax (e.g., "python*")
  for (const pattern of DANGEROUS_BASH_PATTERNS) {
    const lowerPattern = pattern.toLowerCase()

    // Exact match to the pattern itself (e.g., "python" as a rule)
    if (content === lowerPattern) {
      return true
    }

    // Prefix syntax: "python:*" allows any python command
    if (content === `${lowerPattern}:*`) {
      return true
    }

    // Wildcard at end: "python*" matches python, python3, etc.
    if (content === `${lowerPattern}*`) {
      return true
    }

    // Wildcard with space: "python *" would match "python script.py"
    if (content === `${lowerPattern} *`) {
      return true
    }

    // Check for patterns like "python -*" which would match "python -c 'code'"
    if (content.startsWith(`${lowerPattern} -`) && content.endsWith('*')) {
      return true
    }
  }

  return false
}

/**
 * Checks if a PowerShell permission rule is dangerous for auto mode.
 * A rule is dangerous if it would auto-allow commands that execute arbitrary
 * code (nested shells, Invoke-Expression, Start-Process, etc.), bypassing the
 * classifier's safety evaluation.
 *
 * PowerShell is case-insensitive, so rule content is lowercased before matching.
 */
export function isDangerousPowerShellPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  if (toolName !== POWERSHELL_TOOL_NAME) {
    return false
  }

  // Tool-level allow (PowerShell with no content, or PowerShell(*)) - allows ALL commands
  if (ruleContent === undefined || ruleContent === '') {
    return true
  }

  const content = ruleContent.trim().toLowerCase()

  // Standalone wildcard (*) matches everything
  if (content === '*') {
    return true
  }

  // PS-specific cmdlet names. CROSS_PLATFORM_CODE_EXEC is shared with bash.
  const patterns: readonly string[] = [
    ...CROSS_PLATFORM_CODE_EXEC,
    // Nested PS + shells launchable from PS
    'pwsh',
    'powershell',
    'cmd',
    'wsl',
    // String/scriptblock evaluators
    'iex',
    'invoke-expression',
    'icm',
    'invoke-command',
    // Process spawners
    'start-process',
    'saps',
    'start',
    'start-job',
    'sajb',
    'start-threadjob', // bundled PS 6.1+; takes -ScriptBlock like Start-Job
    // Event/session code exec
    'register-objectevent',
    'register-engineevent',
    'register-wmievent',
    'register-scheduledjob',
    'new-pssession',
    'nsn', // alias
    'enter-pssession',
    'etsn', // alias
    // .NET escape hatches
    'add-type', // Add-Type -TypeDefinition '<C#>' → P/Invoke
    'new-object', // New-Object -ComObject WScript.Shell → .Run()
  ]

  for (const pattern of patterns) {
    // patterns stored lowercase; content lowercased above
    if (content === pattern) return true
    if (content === `${pattern}:*`) return true
    if (content === `${pattern}*`) return true
    if (content === `${pattern} *`) return true
    if (content.startsWith(`${pattern} -`) && content.endsWith('*')) return true
    // .exe — goes on the FIRST word. `python` → `python.exe`.
    // `npm run` → `npm.exe run` (npm.exe is the real Windows binary name).
    // A rule like `PowerShell(npm.exe run:*)` needs to match `npm run`.
    const sp = pattern.indexOf(' ')
    const exe =
      sp === -1
        ? `${pattern}.exe`
        : `${pattern.slice(0, sp)}.exe${pattern.slice(sp)}`
    if (content === exe) return true
    if (content === `${exe}:*`) return true
    if (content === `${exe}*`) return true
    if (content === `${exe} *`) return true
    if (content.startsWith(`${exe} -`) && content.endsWith('*')) return true
  }
  return false
}

/**
 * Checks if an Agent (sub-agent) permission rule is dangerous for auto mode.
 * Any Agent allow rule would auto-approve sub-agent spawns before the auto mode classifier
 * can evaluate the sub-agent's prompt, defeating delegation attack prevention.
 */
export function isDangerousTaskPermission(
  toolName: string,
  _ruleContent: string | undefined,
): boolean {
  return normalizeLegacyToolName(toolName) === AGENT_TOOL_NAME
}

function formatPermissionSource(source: PermissionRuleSource): string {
  if ((SETTING_SOURCES as readonly string[]).includes(source)) {
    const filePath = getSettingsFilePathForSource(source as SettingSource)
    if (filePath) {
      const relativePath = relative(getCwd(), filePath)
      return relativePath.length < filePath.length ? relativePath : filePath
    }
  }
  return source
}

export type DangerousPermissionInfo = {
  ruleValue: PermissionRuleValue
  source: PermissionRuleSource
  /** The permission rule formatted for display, e.g. "Bash(*)" or "Bash(python:*)" */
  ruleDisplay: string
  /** The source formatted for display, e.g. a file path or "--allowed-tools" */
  sourceDisplay: string
}

/**
 * Checks if a permission rule is dangerous for auto mode.
 * A rule is dangerous if it would auto-allow actions before the auto mode classifier
 * can evaluate them, bypassing safety checks.
 */
function isDangerousClassifierPermission(
  toolName: string,
  ruleContent: string | undefined,
): boolean {
  return (
    isDangerousBashPermission(toolName, ruleContent) ||
    isDangerousPowerShellPermission(toolName, ruleContent) ||
    isDangerousTaskPermission(toolName, ruleContent)
  )
}

/**
 * Finds all dangerous permissions from rules loaded from disk and CLI arguments.
 * Returns structured info about each dangerous permission found.
 *
 * Checks Bash permissions (wildcard/interpreter patterns), PowerShell permissions
 * (wildcard/iex/Start-Process patterns), and Agent permissions (any allow rule
 * bypasses the classifier's sub-agent evaluation).
 */
export function findDangerousClassifierPermissions(
  rules: PermissionRule[],
  cliAllowedTools: string[],
): DangerousPermissionInfo[] {
  const dangerous: DangerousPermissionInfo[] = []

  // Check rules loaded from settings
  for (const rule of rules) {
    if (
      rule.ruleBehavior === 'allow' &&
      isDangerousClassifierPermission(
        rule.ruleValue.toolName,
        rule.ruleValue.ruleContent,
      )
    ) {
      const ruleString = rule.ruleValue.ruleContent
        ? `${rule.ruleValue.toolName}(${rule.ruleValue.ruleContent})`
        : `${rule.ruleValue.toolName}(*)`
      dangerous.push({
        ruleValue: rule.ruleValue,
        source: rule.source,
        ruleDisplay: ruleString,
        sourceDisplay: formatPermissionSource(rule.source),
      })
    }
  }

  // Check CLI --allowed-tools arguments
  for (const toolSpec of cliAllowedTools) {
    // Parse tool spec: "Bash" or "Bash(pattern)" or "Agent" or "Agent(subagent_type)"
    const match = toolSpec.match(/^([^(]+)(?:\(([^)]*)\))?$/)
    if (match) {
      const toolName = match[1]!.trim()
      const ruleContent = match[2]?.trim()

      if (isDangerousClassifierPermission(toolName, ruleContent)) {
        dangerous.push({
          ruleValue: { toolName, ruleContent },
          source: 'cliArg',
          ruleDisplay: ruleContent ? toolSpec : `${toolName}(*)`,
          sourceDisplay: '--allowed-tools',
        })
      }
    }
  }

  return dangerous
}

/**
 * Session startup: turning CLI flags and settings into a permission mode, and
 * building the initial ToolPermissionContext.
 *
 * This file is the shell: it reads the ambient inputs (merged settings, the
 * environment, the filesystem) and hands them to the pure pieces in
 * `startup/`.
 */
import { resolve } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { getInitialSettings } from 'src/platform/settings/settings.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { logForDebugging } from 'src/shared/debug.js'
import {
  getFsImplementation,
  safeResolvePath,
} from 'src/shared/fs/fsOperations.js'
import {
  addDirHelpMessage,
  validateDirectoryForWorkspace,
} from 'src/commands/add-dir/validation.js'
import { getToolsForDefaultPreset } from 'src/tools/tools.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'
import type { PermissionMode } from 'src/permissions/PermissionMode.js'
import { loadAllPermissionRulesFromDisk } from 'src/permissions/permissionsLoader.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from 'src/permissions/permissionRuleParser.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
import { isAutoModeGateEnabled } from 'src/permissions/permissionSetup/autoModeAvailability.js'
import { isBypassPermissionsModeDisabled } from 'src/permissions/permissionSetup/bypassPermissions.js'
import {
  type DangerousPermissionInfo,
  findDangerousClassifierPermissions,
} from 'src/permissions/permissionSetup/dangerousRuleDetection.js'
import {
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
} from 'src/permissions/permissionSetup/cliToolParsing.js'
import { pickStartMode } from 'src/permissions/permissionSetup/startup/startMode.js'
import { buildStartContext } from 'src/permissions/permissionSetup/startup/startContext.js'
import { anyTrustedLayer } from 'src/permissions/permissionSetup/trustedSettings.js'

const BYPASS_REFUSED_NOTICE = 'Bypass permissions mode was disabled by settings'

/**
 * `PWD` when it differs from the start directory but is a symlink leading to
 * it: the shell's view of the same place, which file paths may arrive under.
 */
function pwdLinkedToStartDirectory(): string | undefined {
  const pwd = process.env.PWD
  const start = getOriginalCwd()
  if (!pwd || resolve(pwd) === start) return undefined
  const { resolvedPath } = safeResolvePath(getFsImplementation(), pwd)
  return resolvedPath === start ? pwd : undefined
}

/**
 * The default-preset tools `--base-tools` leaves out, denied. An absent or
 * empty list denies nothing; legacy names count under their new name.
 */
function denialsForBaseTools(baseToolsCli: string[] | undefined): string[] {
  if (!baseToolsCli || baseToolsCli.length === 0) return []
  const kept = new Set(parseBaseToolsFromCLI(baseToolsCli).map(normalizeLegacyToolName))
  return getToolsForDefaultPreset().filter(tool => !kept.has(tool))
}

/** Maps legacy tool names and escapes parentheses inside the rule content. */
function normalizeCliAllowRule(rule: string): string {
  return permissionRuleValueToString(permissionRuleValueFromString(rule))
}

function bypassIsOffered(mode: PermissionMode, allowSkipFlag: boolean): boolean {
  if (isBypassPermissionsModeDisabled()) return false
  if (mode === 'bypassPermissions' || allowSkipFlag) return true
  return anyTrustedLayer(settings => settings.permissions?.allowBypassPermissionsMode === true)
}

export function initialPermissionModeFromCLI({
  permissionModeCli,
  dangerouslySkipPermissions,
}: {
  permissionModeCli: string | undefined
  dangerouslySkipPermissions: boolean | undefined
}): { mode: PermissionMode; notification?: string } {
  const { mode, bypassRefused } = pickStartMode({
    skipPermissions: dangerouslySkipPermissions === true,
    modeFlag: permissionModeCli,
    settingsDefaultMode: getInitialSettings().permissions?.defaultMode,
    remote: isEnvTruthy(process.env.CLAUDE_CODE_REMOTE),
    bypassKilled: isBypassPermissionsModeDisabled(),
  })
  // Auto goes on even through a closed gate; the startup check moves the
  // session out moments later, with a notice.
  if (mode === 'auto') autoModeStateModule?.setAutoModeActive(true)
  if (!bypassRefused) return { mode }
  logForDebugging(`[permissions] bypass refused by settings; starting in ${mode}`)
  return { mode, notification: BYPASS_REFUSED_NOTICE }
}

export async function initializeToolPermissionContext({
  allowedToolsCli,
  disallowedToolsCli,
  baseToolsCli,
  permissionMode,
  allowDangerouslySkipPermissions,
  addDirs,
}: {
  allowedToolsCli: string[]
  disallowedToolsCli: string[]
  baseToolsCli?: string[]
  permissionMode: PermissionMode
  allowDangerouslySkipPermissions: boolean
  addDirs: string[]
}): Promise<{
  toolPermissionContext: ToolPermissionContext
  warnings: string[]
  dangerousPermissions: DangerousPermissionInfo[]
}> {
  const allowEntries = parseToolListFromCLI(allowedToolsCli)
  const rulesFromDisk = loadAllPermissionRulesFromDisk()
  const settingsDirectories = getInitialSettings().permissions?.additionalDirectories ?? []

  const { context, warnings } = await buildStartContext(
    {
      mode: permissionMode,
      cliAllowRules: allowEntries.map(normalizeCliAllowRule),
      cliDenyRules: [...parseToolListFromCLI(disallowedToolsCli), ...denialsForBaseTools(baseToolsCli)],
      rulesFromDisk,
      bypassOffered: bypassIsOffered(permissionMode, allowDangerouslySkipPermissions),
      autoOffered: autoModeStateModule ? isAutoModeGateEnabled() : undefined,
      extraDirectories: [...settingsDirectories, ...addDirs],
      symlinkedPwd: pwdLinkedToStartDirectory(),
    },
    { validateDirectory: validateDirectoryForWorkspace, explainRejection: addDirHelpMessage },
  )

  // Reported, not removed: the caller decides what to do with them.
  const dangerousPermissions =
    permissionMode === 'auto' ? findDangerousClassifierPermissions(rulesFromDisk, allowEntries) : []
  return { toolPermissionContext: context, warnings, dangerousPermissions }
}

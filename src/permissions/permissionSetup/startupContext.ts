/**
 * Session startup: turning CLI flags and settings into a permission mode, and
 * building the initial ToolPermissionContext.
 *
 * Everything here reads ambient state — the merged settings files, the
 * GrowthBook cache, process.env.PWD and the filesystem — which is why it is
 * covered by a surface pin rather than by behavioural tests.
 */
import { feature } from 'bun:bundle'
import { resolve } from 'path'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { checkStatsigFeatureGate_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import {
  getInitialSettings,
  hasAllowBypassPermissionsMode,
} from 'src/platform/settings/settings.js'
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
import {
  type PermissionMode,
  permissionModeFromString,
} from 'src/permissions/PermissionMode.js'
import { applyPermissionRulesToPermissionContext } from 'src/permissions/permissions.js'
import { loadAllPermissionRulesFromDisk } from 'src/permissions/permissionsLoader.js'
import {
  type AdditionalWorkingDirectory,
  applyPermissionUpdate,
} from 'src/permissions/PermissionUpdate.js'
import {
  normalizeLegacyToolName,
  permissionRuleValueFromString,
  permissionRuleValueToString,
} from 'src/permissions/permissionRuleParser.js'
import { autoModeStateModule } from 'src/permissions/permissionSetup/autoModeStateBridge.js'
import {
  getAutoModeEnabledStateIfCached,
  isAutoModeGateEnabled,
} from 'src/permissions/permissionSetup/autoModeAvailability.js'
import {
  type DangerousPermissionInfo,
  findDangerousClassifierPermissions,
} from 'src/permissions/permissionSetup/dangerousRuleDetection.js'
import {
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
} from 'src/permissions/permissionSetup/cliToolParsing.js'

/**
 * Check if processPwd is a symlink that resolves to originalCwd
 */
function isSymlinkTo({
  processPwd,
  originalCwd,
}: {
  processPwd: string
  originalCwd: string
}): boolean {
  // Use safeResolvePath to check if processPwd is a symlink and get its resolved path
  const { resolvedPath: resolvedProcessPwd, isSymlink: isProcessPwdSymlink } =
    safeResolvePath(getFsImplementation(), processPwd)

  return isProcessPwdSymlink
    ? resolvedProcessPwd === resolve(originalCwd)
    : false
}

/**
 * Safely convert CLI flags to a PermissionMode
 */
export function initialPermissionModeFromCLI({
  permissionModeCli,
  dangerouslySkipPermissions,
}: {
  permissionModeCli: string | undefined
  dangerouslySkipPermissions: boolean | undefined
}): { mode: PermissionMode; notification?: string } {
  const settings = getInitialSettings() || {}

  // Check GrowthBook gate first - highest precedence
  const growthBookDisableBypassPermissionsMode =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
      'tengu_disable_bypass_permissions_mode',
    )

  // Then check settings - lower precedence
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'

  // Statsig gate takes precedence over settings
  const disableBypassPermissionsMode =
    growthBookDisableBypassPermissionsMode ||
    settingsDisableBypassPermissionsMode

  // Sync circuit-breaker check (cached GB read). Prevents the
  // AutoModeOptInDialog from showing in showSetupScreens() when auto can't
  // actually be entered. autoModeFlagCli still carries intent through to
  // verifyAutoModeGateAccess, which notifies the user why.
  const autoModeCircuitBrokenSync = feature('TRANSCRIPT_CLASSIFIER')
    ? getAutoModeEnabledStateIfCached() === 'disabled'
    : false

  // Modes in order of priority
  const orderedModes: PermissionMode[] = []
  let notification: string | undefined

  if (dangerouslySkipPermissions) {
    orderedModes.push('bypassPermissions')
  }
  if (permissionModeCli) {
    const parsedMode = permissionModeFromString(permissionModeCli)
    if (feature('TRANSCRIPT_CLASSIFIER') && parsedMode === 'auto') {
      if (autoModeCircuitBrokenSync) {
        logForDebugging(
          'auto mode circuit breaker active (cached) — falling back to default',
          { level: 'warn' },
        )
      } else {
        orderedModes.push('auto')
      }
    } else {
      orderedModes.push(parsedMode)
    }
  }
  if (settings.permissions?.defaultMode) {
    const settingsMode = settings.permissions.defaultMode as PermissionMode
    // CCR only supports acceptEdits and plan — ignore other defaultModes from
    // settings (e.g. bypassPermissions would otherwise silently grant full
    // access in a remote environment).
    if (
      isEnvTruthy(process.env.CLAUDE_CODE_REMOTE) &&
      !['acceptEdits', 'plan', 'default'].includes(settingsMode)
    ) {
      logForDebugging(
        `settings defaultMode "${settingsMode}" is not supported in CLAUDE_CODE_REMOTE — only acceptEdits and plan are allowed`,
        { level: 'warn' },
      )
    }
    // auto from settings requires the same gate check as from CLI
    else if (feature('TRANSCRIPT_CLASSIFIER') && settingsMode === 'auto') {
      if (autoModeCircuitBrokenSync) {
        logForDebugging(
          'auto mode circuit breaker active (cached) — falling back to default',
          { level: 'warn' },
        )
      } else {
        orderedModes.push('auto')
      }
    } else {
      orderedModes.push(settingsMode)
    }
  }

  let result: { mode: PermissionMode; notification?: string } | undefined

  for (const mode of orderedModes) {
    if (mode === 'bypassPermissions' && disableBypassPermissionsMode) {
      if (growthBookDisableBypassPermissionsMode) {
        logForDebugging('bypassPermissions mode is disabled by Statsig gate', {
          level: 'warn',
        })
        notification =
          'Bypass permissions mode was disabled by your organization policy'
      } else {
        logForDebugging('bypassPermissions mode is disabled by settings', {
          level: 'warn',
        })
        notification = 'Bypass permissions mode was disabled by settings'
      }
      continue // Skip this mode if it's disabled
    }

    result = { mode, notification } // Use the first valid mode
    break
  }

  if (!result) {
    result = { mode: 'default', notification }
  }

  if (!result) {
    result = { mode: 'default', notification }
  }

  if (feature('TRANSCRIPT_CLASSIFIER') && result.mode === 'auto') {
    autoModeStateModule?.setAutoModeActive(true)
  }

  return result
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
  // Parse comma-separated allowed and disallowed tools if provided
  // Normalize legacy tool names (e.g., 'Task' → 'Agent') so that in-memory
  // rule removal in stripDangerousPermissionsForAutoMode matches correctly.
  const parsedAllowedToolsCli = parseToolListFromCLI(allowedToolsCli).map(
    rule => permissionRuleValueToString(permissionRuleValueFromString(rule)),
  )
  let parsedDisallowedToolsCli = parseToolListFromCLI(disallowedToolsCli)

  // If base tools are specified, automatically deny all tools NOT in the base set
  // We need to check if base tools were explicitly provided (not just empty default)
  if (baseToolsCli && baseToolsCli.length > 0) {
    const baseToolsResult = parseBaseToolsFromCLI(baseToolsCli)
    // Normalize legacy tool names (e.g., 'Task' → 'Agent') so user-provided
    // base tool lists using old names still match canonical names.
    const baseToolsSet = new Set(baseToolsResult.map(normalizeLegacyToolName))
    const allToolNames = getToolsForDefaultPreset()
    const toolsToDisallow = allToolNames.filter(tool => !baseToolsSet.has(tool))
    parsedDisallowedToolsCli = [...parsedDisallowedToolsCli, ...toolsToDisallow]
  }

  const warnings: string[] = []
  const additionalWorkingDirectories = new Map<
    string,
    AdditionalWorkingDirectory
  >()
  // process.env.PWD may be a symlink, while getOriginalCwd() uses the real path
  const processPwd = process.env.PWD
  if (
    processPwd &&
    processPwd !== getOriginalCwd() &&
    isSymlinkTo({ originalCwd: getOriginalCwd(), processPwd })
  ) {
    additionalWorkingDirectories.set(processPwd, {
      path: processPwd,
      source: 'session',
    })
  }

  // Check if bypassPermissions mode is available (not disabled by Statsig gate or settings)
  // Use cached values to avoid blocking on startup
  const growthBookDisableBypassPermissionsMode =
    checkStatsigFeatureGate_CACHED_MAY_BE_STALE(
      'tengu_disable_bypass_permissions_mode',
    )
  const settings = getInitialSettings() || {}
  const settingsDisableBypassPermissionsMode =
    settings.permissions?.disableBypassPermissionsMode === 'disable'
  const settingsAllowBypassPermissionsMode = hasAllowBypassPermissionsMode()
  const isBypassPermissionsModeAvailable =
    (permissionMode === 'bypassPermissions' ||
      allowDangerouslySkipPermissions ||
      settingsAllowBypassPermissionsMode) &&
    !growthBookDisableBypassPermissionsMode &&
    !settingsDisableBypassPermissionsMode

  // Load all permission rules from disk
  const rulesFromDisk = loadAllPermissionRulesFromDisk()

  // Ant-only: Detect dangerous shell permissions for auto mode
  // Dangerous permissions (like Bash(*), Bash(python:*), PowerShell(iex:*)) would auto-allow
  // before the classifier can evaluate them, defeating the purpose of safer YOLO mode
  let dangerousPermissions: DangerousPermissionInfo[] = []
  if (feature('TRANSCRIPT_CLASSIFIER') && permissionMode === 'auto') {
    dangerousPermissions = findDangerousClassifierPermissions(
      rulesFromDisk,
      parsedAllowedToolsCli,
    )
  }

  let toolPermissionContext = applyPermissionRulesToPermissionContext(
    {
      mode: permissionMode,
      additionalWorkingDirectories,
      alwaysAllowRules: { cliArg: parsedAllowedToolsCli },
      alwaysDenyRules: { cliArg: parsedDisallowedToolsCli },
      alwaysAskRules: {},
      isBypassPermissionsModeAvailable,
      ...(feature('TRANSCRIPT_CLASSIFIER')
        ? { isAutoModeAvailable: isAutoModeGateEnabled() }
        : {}),
    },
    rulesFromDisk,
  )

  // Add directories from settings and --add-dir
  const allAdditionalDirectories = [
    ...(settings.permissions?.additionalDirectories || []),
    ...addDirs,
  ]
  // Parallelize fs validation; apply updates serially (cumulative context).
  // validateDirectoryForWorkspace only reads permissionContext to check if the
  // dir is already covered — behavioral difference from parallelizing is benign
  // (two overlapping --add-dirs both succeed instead of one being flagged
  // alreadyInWorkingDirectory, which was silently skipped anyway).
  const validationResults = await Promise.all(
    allAdditionalDirectories.map(dir =>
      validateDirectoryForWorkspace(dir, toolPermissionContext),
    ),
  )
  for (const result of validationResults) {
    if (result.resultType === 'success') {
      toolPermissionContext = applyPermissionUpdate(toolPermissionContext, {
        type: 'addDirectories',
        directories: [result.absolutePath],
        destination: 'cliArg',
      })
    } else if (
      result.resultType !== 'alreadyInWorkingDirectory' &&
      result.resultType !== 'pathNotFound'
    ) {
      // Warn for actual config mistakes (e.g. specifying a file instead of a
      // directory). But if the directory doesn't exist anymore (e.g. someone
      // was working under /tmp and it got cleared), silently skip. They'll get
      // prompted again if they try to access it later.
      warnings.push(addDirHelpMessage(result))
    }
  }

  return {
    toolPermissionContext,
    warnings,
    dangerousPermissions,
  }
}

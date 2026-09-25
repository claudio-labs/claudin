/**
 * Permission setup: the startup context, the mode transitions, the auto-mode
 * gate, and the dangerous-rule stash that keeps auto mode from auto-allowing
 * arbitrary code execution before the classifier sees it.
 *
 * This file is a BARREL — the implementation lives in permissionSetup/:
 * autoModeStateBridge (the single feature()-gated handle on autoModeState),
 * dangerousRuleDetection, dangerousRuleStash, cliToolParsing, startupContext,
 * modeTransition, autoModeGate, autoModeAvailability, bypassPermissions and
 * planAutoMode. Edit the sibling, not this file.
 */

export {
  __autoModeAllowedForModelForTests,
  getAutoModeUnavailableReason,
  isAutoModeGateEnabled,
} from 'src/permissions/permissionSetup/autoModeAvailability.js'
export {
  type AutoModeGateCheckResult,
  type AutoModeUnavailableReason,
  getAutoModeUnavailableNotification,
  verifyAutoModeGateAccess,
} from 'src/permissions/permissionSetup/autoModeGate.js'
export {
  createDisabledBypassPermissionsContext,
  isBypassPermissionsModeDisabled,
} from 'src/permissions/permissionSetup/bypassPermissions.js'
export {
  parseBaseToolsFromCLI,
  parseToolListFromCLI,
} from 'src/permissions/permissionSetup/cliToolParsing.js'
export {
  type DangerousPermissionInfo,
  findDangerousClassifierPermissions,
  isDangerousBashPermission,
  isDangerousPowerShellPermission,
  isDangerousTaskPermission,
} from 'src/permissions/permissionSetup/dangerousRuleDetection.js'
export {
  removeDangerousPermissions,
  restoreDangerousPermissions,
  stripDangerousPermissionsForAutoMode,
} from 'src/permissions/permissionSetup/dangerousRuleStash.js'
export { transitionPermissionMode } from 'src/permissions/permissionSetup/modeTransition.js'
export {
  isDefaultPermissionModeAuto,
  prepareContextForPlanMode,
  shouldPlanUseAutoMode,
  transitionPlanAutoMode,
} from 'src/permissions/permissionSetup/planAutoMode.js'
export {
  initialPermissionModeFromCLI,
  initializeToolPermissionContext,
} from 'src/permissions/permissionSetup/startupContext.js'

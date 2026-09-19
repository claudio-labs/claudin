/**
 * The exported surface of src/permissions/permissionSetup.js.
 *
 * permissionSetup is a barrel over permissionSetup/. A barrel that loses a
 * re-export still builds and still type-checks for every consumer that does
 * not import the dropped name, so this is the only thing that catches it —
 * and the consumers here are the permission mode carousel, the SDK control
 * channel and the plan-mode tools, where a missing symbol surfaces as a
 * runtime TypeError in the middle of a session.
 *
 * It is also where the two groups that CANNOT be tested behaviourally are
 * recorded, rather than being left to look covered:
 *
 *   - `initialPermissionModeFromCLI` / `initializeToolPermissionContext`
 *     (the startup context) read the merged settings files, the GrowthBook
 *     cache and the filesystem. Under `bun test` they answer from whatever
 *     ~/.claudin/settings.json happens to say.
 *   - `verifyAutoModeGateAccess` awaits the dynamic config and can fire a
 *     live classifier probe against the active provider.
 *
 * Both are pinned by name and arity only. Nothing below claims they behave.
 */
import { describe, expect, test } from 'bun:test'
import * as permissionSetup from 'src/permissions/permissionSetup.js'
import type {
  AutoModeEnabledState,
  AutoModeGateCheckResult,
  AutoModeUnavailableReason,
  DangerousPermissionInfo,
} from 'src/permissions/permissionSetup.js'
import type { ToolPermissionContext } from 'src/tools/Tool.js'

/** Every value export, exactly. Adding one here is a deliberate act. */
const EXPECTED_EXPORTS = [
  '__autoModeAllowedForModelForTests',
  'checkAndDisableBypassPermissions',
  'createDisabledBypassPermissionsContext',
  'findDangerousClassifierPermissions',
  'getAutoModeEnabledState',
  'getAutoModeEnabledStateIfCached',
  'getAutoModeUnavailableNotification',
  'getAutoModeUnavailableReason',
  'hasAutoModeOptInAnySource',
  'initialPermissionModeFromCLI',
  'initializeToolPermissionContext',
  'isAutoModeGateEnabled',
  'isBypassPermissionsModeDisabled',
  'isDangerousBashPermission',
  'isDangerousPowerShellPermission',
  'isDangerousTaskPermission',
  'isDefaultPermissionModeAuto',
  'parseBaseToolsFromCLI',
  'parseToolListFromCLI',
  'prepareContextForPlanMode',
  'removeDangerousPermissions',
  'restoreDangerousPermissions',
  'shouldDisableBypassPermissions',
  'shouldPlanUseAutoMode',
  'stripDangerousPermissionsForAutoMode',
  'transitionPermissionMode',
  'transitionPlanAutoMode',
  'verifyAutoModeGateAccess',
] as const

describe('permissionSetup surface', () => {
  test('exports exactly the expected set of names', () => {
    expect(Object.keys(permissionSetup).sort()).toEqual([...EXPECTED_EXPORTS])
  })

  test('every exported name is callable', () => {
    for (const name of EXPECTED_EXPORTS) {
      expect(typeof permissionSetup[name]).toBe('function')
    }
  })

  test('the four exported types survive the barrel', () => {
    // Compile-time pin: a type dropped from the barrel is a tsc error on the
    // annotations below, which is what `typecheck` reports as new.
    const state: AutoModeEnabledState = 'opt-in'
    const reason: AutoModeUnavailableReason = 'circuit-breaker'
    const info: DangerousPermissionInfo = {
      ruleValue: { toolName: 'Bash', ruleContent: 'python:*' },
      source: 'localSettings',
      ruleDisplay: 'Bash(python:*)',
      sourceDisplay: '.claudin/settings.local.json',
    }
    const gate: AutoModeGateCheckResult = {
      updateContext: (c: ToolPermissionContext) => c,
    }
    expect([state, reason, info.ruleDisplay, typeof gate.updateContext]).toEqual(
      ['opt-in', 'circuit-breaker', 'Bash(python:*)', 'function'],
    )
  })
})

describe('permissionSetup signatures', () => {
  // Arity is the cheap half of a signature. It is what catches a parameter
  // silently gaining a default, or an options object being flattened, during
  // a relocation that otherwise type-checks at every call site.
  test.each([
    ['isDangerousBashPermission', 2],
    ['isDangerousPowerShellPermission', 2],
    ['isDangerousTaskPermission', 2],
    ['findDangerousClassifierPermissions', 2],
    ['removeDangerousPermissions', 2],
    ['stripDangerousPermissionsForAutoMode', 1],
    ['restoreDangerousPermissions', 1],
    ['transitionPermissionMode', 3],
    ['parseBaseToolsFromCLI', 1],
    ['parseToolListFromCLI', 1],
    ['initialPermissionModeFromCLI', 1],
    ['initializeToolPermissionContext', 1],
    ['getAutoModeUnavailableNotification', 1],
    // `fastMode?: boolean` is still a declared parameter — giving it a default
    // would drop the count, which is the shape this pin is here to catch.
    ['verifyAutoModeGateAccess', 2],
    ['shouldDisableBypassPermissions', 0],
    ['isAutoModeGateEnabled', 0],
    ['getAutoModeUnavailableReason', 0],
    ['getAutoModeEnabledState', 0],
    ['getAutoModeEnabledStateIfCached', 0],
    ['hasAutoModeOptInAnySource', 0],
    ['isBypassPermissionsModeDisabled', 0],
    ['createDisabledBypassPermissionsContext', 1],
    ['checkAndDisableBypassPermissions', 1],
    ['isDefaultPermissionModeAuto', 0],
    ['shouldPlanUseAutoMode', 0],
    ['prepareContextForPlanMode', 1],
    ['transitionPlanAutoMode', 1],
    ['__autoModeAllowedForModelForTests', 1],
  ] as const)('%s takes %d required parameter(s)', (name, arity) => {
    expect(permissionSetup[name].length).toBe(arity)
  })
})

describe('permissionSetup gate-off contract', () => {
  // TRANSCRIPT_CLASSIFIER folds to false under `bun test` and in the open
  // build. These two are the whole body of their functions in that build.
  test('the default permission mode is never auto without the classifier', () => {
    expect(permissionSetup.isDefaultPermissionModeAuto()).toBe(false)
  })

  test('plan mode never borrows auto semantics without the classifier', () => {
    expect(permissionSetup.shouldPlanUseAutoMode()).toBe(false)
  })
})

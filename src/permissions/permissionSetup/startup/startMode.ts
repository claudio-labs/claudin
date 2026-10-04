/**
 * The start mode as a pure function of the flags, the merged settings and the
 * environment. The shell in `startupContext.ts` gathers those and applies the
 * one side effect (switching auto on).
 */
import {
  type PermissionMode,
  permissionModeFromString,
} from 'src/permissions/PermissionMode.js'

export type StartModeInputs = {
  /** `--dangerously-skip-permissions`. */
  skipPermissions: boolean
  /** `--permission-mode`, as typed; empty counts as absent. */
  modeFlag: string | undefined
  /** `permissions.defaultMode` from the merged settings. */
  settingsDefaultMode: string | undefined
  /** `CLAUDE_CODE_REMOTE` is set. */
  remote: boolean
  /** `permissions.disableBypassPermissionsMode: "disable"` in the merged settings. */
  bypassKilled: boolean
}

export type StartModeChoice = {
  mode: PermissionMode
  /** A bypass candidate was skipped because of the kill switch. */
  bypassRefused: boolean
}

/** What a remote session still honours from a settings `defaultMode`. */
const REMOTE_SETTINGS_MODES: ReadonlySet<string> = new Set(['default', 'acceptEdits', 'plan'])

/** Every requested mode, highest priority first. */
function requestedModes(inputs: StartModeInputs): PermissionMode[] {
  const requested: PermissionMode[] = []
  if (inputs.skipPermissions) requested.push('bypassPermissions')
  if (inputs.modeFlag) requested.push(permissionModeFromString(inputs.modeFlag))
  const fromSettings = inputs.settingsDefaultMode
  if (fromSettings && (!inputs.remote || REMOTE_SETTINGS_MODES.has(fromSettings))) {
    requested.push(permissionModeFromString(fromSettings))
  }
  return requested
}

export function pickStartMode(inputs: StartModeInputs): StartModeChoice {
  let bypassRefused = false
  for (const mode of requestedModes(inputs)) {
    if (mode === 'bypassPermissions' && inputs.bypassKilled) {
      bypassRefused = true
      continue
    }
    return { mode, bypassRefused }
  }
  return { mode: 'default', bypassRefused }
}

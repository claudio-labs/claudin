import { setMainLoopModelOverride } from '../bootstrap/state.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
} from '../utils/auth.js'
import {
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from '../utils/config.js'
import { toError } from '../utils/errors.js'
import { logError } from '../utils/log.js'
import { applyConfigEnvironmentVariables } from '../utils/managedEnv.js'
import {
  clearActiveProviderProfileModel,
  getProjectActiveProviderProfileId,
  persistActiveProviderProfileModel,
} from '../utils/providerProfiles.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from '../utils/permissions/PermissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from '../utils/sessionState.js'
import { updateSettingsForSource } from '../utils/settings/settings.js'
import type { AppState } from './AppStateStore.js'

// One-shot flag: when set, the next `mainLoopModel` diff handled by
// `onChangeAppState` updates the bootstrap override sentinel but skips the
// persistence side-effects (`saveCurrentProjectConfig`,
// `updateSettingsForSource`, `persistActiveProviderProfileModel`). Used by
// flows that change `mainLoopModel` as a *consequence* of switching providers
// — clearing a project override, activating a different global profile while
// an override is active, or deleting the profile currently in use — where
// reusing the /model persistence path would clobber the user's prior /model
// choice or leak a model into the wrong-shape profile.
let mainLoopModelPersistSuppressed = false

export function suppressNextMainLoopModelPersist(): void {
  mainLoopModelPersistSuppressed = true
}

function consumeMainLoopModelPersistSuppression(): boolean {
  if (!mainLoopModelPersistSuppressed) return false
  mainLoopModelPersistSuppressed = false
  return true
}

// Inverse of the push below — restore on worker restart.
export function externalMetadataToAppState(
  metadata: SessionExternalMetadata,
): (prev: AppState) => AppState {
  return prev => ({
    ...prev,
    ...(typeof metadata.permission_mode === 'string'
      ? {
          toolPermissionContext: {
            ...prev.toolPermissionContext,
            mode: permissionModeFromString(metadata.permission_mode),
          },
        }
      : {}),
    ...(typeof metadata.is_ultraplan_mode === 'boolean'
      ? { isUltraplanMode: metadata.is_ultraplan_mode }
      : {}),
  })
}

export function onChangeAppState({
  newState,
  oldState,
}: {
  newState: AppState
  oldState: AppState
}) {
  // Consume the suppression flag at the very top — before any listener
  // notification that could throw. Consuming later (inside the diff branches
  // or after notifySessionMetadataChanged/notifyPermissionModeChanged) risks
  // leaving the flag armed if a listener errors, which would silently drop
  // the next legitimate /model persistence.
  const skipPersist = consumeMainLoopModelPersistSuppression()

  // toolPermissionContext.mode — single choke point for CCR/SDK mode sync.
  //
  // Prior to this block, mode changes were relayed to CCR by only 2 of 8+
  // mutation paths: a bespoke setAppState wrapper in print.ts (headless/SDK
  // mode only) and a manual notify in the set_permission_mode handler.
  // Every other path — Shift+Tab cycling, ExitPlanModePermissionRequest
  // dialog options, the /plan slash command, rewind, the REPL bridge's
  // onSetPermissionMode — mutated AppState without telling
  // CCR, leaving external_metadata.permission_mode stale and the web UI out
  // of sync with the CLI's actual mode.
  //
  // Hooking the diff here means ANY setAppState call that changes the mode
  // notifies CCR (via notifySessionMetadataChanged → ccrClient.reportMetadata)
  // and the SDK status stream (via notifyPermissionModeChanged → registered
  // in print.ts). The scattered callsites above need zero changes.
  const prevMode = oldState.toolPermissionContext.mode
  const newMode = newState.toolPermissionContext.mode
  if (prevMode !== newMode) {
    // CCR external_metadata must not receive internal-only mode names
    // (bubble, ungated auto). Externalize first — and skip
    // the CCR notify if the EXTERNAL mode didn't change (e.g.,
    // default→bubble→default is noise from CCR's POV since both
    // externalize to 'default'). The SDK channel (notifyPermissionModeChanged)
    // passes raw mode; its listener in print.ts applies its own filter.
    const prevExternal = toExternalPermissionMode(prevMode)
    const newExternal = toExternalPermissionMode(newMode)
    if (prevExternal !== newExternal) {
      // Ultraplan = first plan cycle only. The initial control_request
      // sets mode and isUltraplanMode atomically, so the flag's
      // transition gates it. null per RFC 7396 (removes the key).
      const isUltraplan =
        newExternal === 'plan' &&
        newState.isUltraplanMode &&
        !oldState.isUltraplanMode
          ? true
          : null
      notifySessionMetadataChanged({
        permission_mode: newExternal,
        is_ultraplan_mode: isUltraplan,
      })
    }
    notifyPermissionModeChanged(newMode)
  }

  // mainLoopModel: remove it from settings?
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel === null
  ) {
    setMainLoopModelOverride(null)
    if (!skipPersist) {
      // Gate on the *validated* project profile id (not the raw override) so
      // a dangling `activeProviderProfileId` falls through to the global
      // branch — matching `getUserSpecifiedModelSetting`, which only reads
      // `activeModelForProject` when the override profile actually exists.
      if (getProjectActiveProviderProfileId() !== undefined) {
        // Scoped clear — leave the global settings/profile untouched so other
        // projects don't lose their `/model` choice.
        saveCurrentProjectConfig(current => ({
          ...current,
          activeModelForProject: undefined,
        }))
      } else {
        // Remove from settings
        updateSettingsForSource('userSettings', { model: undefined })
        // Also clear the active provider profile model so the subscription-aware
        // system default (e.g. Opus for Max users) is used on next startup.
        clearActiveProviderProfileModel()
      }
    }
  }

  // mainLoopModel: add it to settings?
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel !== null
  ) {
    setMainLoopModelOverride(newState.mainLoopModel)
    if (!skipPersist) {
      // See comment above: only the validated id qualifies for project-scoped
      // persistence; dangling overrides fall through to the global path.
      if (getProjectActiveProviderProfileId() !== undefined) {
        // Project-scoped persistence: never touch global `settings.model` or
        // the (possibly shared) profile's `model` field — both leak across
        // projects when the same profile is used as an override elsewhere.
        saveCurrentProjectConfig(current => ({
          ...current,
          activeModelForProject: newState.mainLoopModel ?? undefined,
        }))
      } else {
        // Save to settings
        updateSettingsForSource('userSettings', { model: newState.mainLoopModel })
        // Keep active provider profiles in sync with /model choices so restarts
        // keep using the last selected model instead of the profile's old default.
        persistActiveProviderProfileModel(newState.mainLoopModel)
      }
    }
  }

  // expandedView → persist as showExpandedTodos + showSpinnerTree for backwards compat
  if (newState.expandedView !== oldState.expandedView) {
    const showExpandedTodos = newState.expandedView === 'tasks'
    const showSpinnerTree = newState.expandedView === 'teammates'
    if (
      getGlobalConfig().showExpandedTodos !== showExpandedTodos ||
      getGlobalConfig().showSpinnerTree !== showSpinnerTree
    ) {
      saveGlobalConfig(current => ({
        ...current,
        showExpandedTodos,
        showSpinnerTree,
      }))
    }
  }

  // verbose
  if (
    newState.verbose !== oldState.verbose &&
    getGlobalConfig().verbose !== newState.verbose
  ) {
    const verbose = newState.verbose
    saveGlobalConfig(current => ({
      ...current,
      verbose,
    }))
  }

  // collapseSubagentProgress
  if (
    newState.collapseSubagentProgress !== oldState.collapseSubagentProgress &&
    getGlobalConfig().collapseSubagentProgress !==
      newState.collapseSubagentProgress
  ) {
    const collapseSubagentProgress = newState.collapseSubagentProgress
    saveGlobalConfig(current => ({
      ...current,
      collapseSubagentProgress,
    }))
  }

  // settings: clear auth-related caches when settings change
  // This ensures apiKeyHelper and AWS/GCP credential changes take effect immediately
  if (newState.settings !== oldState.settings) {
    try {
      clearApiKeyHelperCache()
      clearAwsCredentialsCache()
      clearGcpCredentialsCache()

      // Re-apply environment variables when settings.env changes
      // This is additive-only: new vars are added, existing may be overwritten, nothing is deleted
      if (newState.settings.env !== oldState.settings.env) {
        applyConfigEnvironmentVariables()
      }
    } catch (error) {
      logError(toError(error))
    }
  }
}

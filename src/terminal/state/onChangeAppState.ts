import { setMainLoopModelOverride } from 'src/platform/bootstrap/state.js'
import {
  clearApiKeyHelperCache,
  clearAwsCredentialsCache,
  clearGcpCredentialsCache,
} from 'src/providers/auth/auth.js'
import {
  getGlobalConfig,
  saveCurrentProjectConfig,
  saveGlobalConfig,
} from 'src/platform/config/config.js'
import { toError } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import { applyConfigEnvironmentVariables } from 'src/platform/config/managedEnv.js'
import { getActiveProviderProfile } from 'src/providers/presets/providerProfiles.js'
import {
  permissionModeFromString,
  toExternalPermissionMode,
} from 'src/permissions/PermissionMode.js'
import {
  notifyPermissionModeChanged,
  notifySessionMetadataChanged,
  type SessionExternalMetadata,
} from 'src/sessions/sessionState.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'

// One-shot flag: when set, the next `mainLoopModel` diff handled by
// `onChangeAppState` updates the bootstrap override sentinel but skips the
// persistence side-effect (`saveCurrentProjectConfig`). Used by flows that
// change `mainLoopModel` as a *consequence* of switching providers — clearing
// a project override, activating a different global profile while an override
// is active, or deleting the profile currently in use — where reusing the
// /model persistence path would clobber the user's prior /model choice or leak
// a model into the wrong-shape profile.
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
      // "Default (recommended)": clear the per-project pin only. The global
      // `settings.model` / profile model stay put as the inherited default that
      // this (and every un-pinned) project falls back to. `/model` is always
      // project-scoped, so we never touch global state here.
      saveCurrentProjectConfig(current => ({
        ...current,
        activeModelForProject: undefined,
        activeModelForProjectProfileId: undefined,
      }))
    }
  }

  // mainLoopModel: add it to settings?
  if (
    newState.mainLoopModel !== oldState.mainLoopModel &&
    newState.mainLoopModel !== null
  ) {
    setMainLoopModelOverride(newState.mainLoopModel)
    if (!skipPersist) {
      // Project-scoped persistence: never touch global `settings.model` or the
      // (possibly shared) profile's `model` field — both leak across projects
      // when the same profile is used elsewhere. Pin the effective provider
      // profile id alongside the model so `getUserSpecifiedModelSetting` can
      // reject the model if the project's provider later changes shape.
      const effectiveProfileId = getActiveProviderProfile()?.id
      saveCurrentProjectConfig(current => ({
        ...current,
        activeModelForProject: newState.mainLoopModel ?? undefined,
        activeModelForProjectProfileId: effectiveProfileId,
      }))
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

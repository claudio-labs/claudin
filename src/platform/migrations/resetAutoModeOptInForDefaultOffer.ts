import { feature } from 'bun:bundle'
import { getGlobalConfig, saveGlobalConfig } from 'src/platform/config/config.js'
import { logError } from 'src/shared/log.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from 'src/platform/settings/settings.js'

/**
 * One-shot migration: clear skipAutoPermissionPrompt for users who accepted
 * the old 2-option AutoModeOptInDialog but don't have auto as their default.
 * Re-surfaces the dialog so they see the new "make it my default mode" option.
 * Guard lives in GlobalConfig (~/.claudin/config.json), not settings.json, so it
 * survives settings resets and doesn't re-arm itself.
 *
 * Clearing skipAutoPermissionPrompt does not take auto out of the carousel —
 * the carousel needs no opt-in — so the dialog stays reachable.
 */
export function resetAutoModeOptInForDefaultOffer(): void {
  if (feature('TRANSCRIPT_CLASSIFIER')) {
    const config = getGlobalConfig()
    if (config.hasResetAutoModeOptInForDefaultOffer) return

    try {
      const user = getSettingsForSource('userSettings')
      if (
        user?.skipAutoPermissionPrompt &&
        user?.permissions?.defaultMode !== 'auto'
      ) {
        updateSettingsForSource('userSettings', {
          skipAutoPermissionPrompt: undefined,
        })
      }

      saveGlobalConfig(c => {
        if (c.hasResetAutoModeOptInForDefaultOffer) return c
        return { ...c, hasResetAutoModeOptInForDefaultOffer: true }
      })
    } catch (error) {
      logError(new Error(`Failed to reset auto mode opt-in: ${error}`))
    }
  }
}

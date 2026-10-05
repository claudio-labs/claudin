/**
 * The two mode consents are remembered in the user's own settings file and
 * nowhere else: a checkout must never be able to record a consent for the user.
 * Each consent has one function, so the destination is stated once.
 */
import { updateSettingsForSource } from 'src/platform/settings/settings.js'

const CONSENT_LAYER = 'userSettings'

/**
 * Remembers that the bypass warning was accepted. A write that fails (an
 * unreadable settings file, say) is not reported: the warning simply comes
 * back next start, which is the safe side.
 */
export function recordBypassAccepted(): void {
  updateSettingsForSource(CONSENT_LAYER, { skipDangerousModePermissionPrompt: true })
}

/** Remembers the auto-mode consent; with `asDefault`, auto also becomes the default mode. */
export function recordAutoConsent({ asDefault }: { asDefault: boolean }): void {
  updateSettingsForSource(
    CONSENT_LAYER,
    asDefault ? { skipAutoPermissionPrompt: true, permissions: { defaultMode: 'auto' } } : { skipAutoPermissionPrompt: true },
  )
}

/**
 * The settings layers trusted to widen what runs without asking: offering
 * bypass in the mode list, and letting plan mode borrow auto.
 *
 * The checked-in project settings are the one layer left out, so that cloning
 * a repository cannot grant either. `settings.local.json` is kept in, for
 * parity, although it also sits in the checkout (it is gitignored by
 * convention only).
 */
import type { SettingSource } from 'src/platform/settings/constants.js'
import { getSettingsForSource } from 'src/platform/settings/settings.js'
import type { SettingsJson } from 'src/platform/settings/types.js'

const TRUSTED_SETTING_LAYERS = [
  'userSettings',
  'localSettings',
  'flagSettings',
  'policySettings',
] as const satisfies readonly SettingSource[]

/** True when at least one trusted layer exists and satisfies `holds`. */
export function anyTrustedLayer(holds: (settings: SettingsJson) => boolean): boolean {
  return TRUSTED_SETTING_LAYERS.some(layer => {
    const settings = getSettingsForSource(layer)
    return settings !== null && holds(settings)
  })
}

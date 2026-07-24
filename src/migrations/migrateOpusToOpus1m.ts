import { logEvent } from '../services/analytics/index.js'
import {
  getDefaultMainLoopModelSetting,
  getDefaultOpusModel,
  isNative1mModel,
  isOpus1mMergeEnabled,
  parseUserSpecifiedModel,
} from '../utils/model/model.js'
import {
  getSettingsForSource,
  updateSettingsForSource,
} from '../utils/settings/settings.js'

/**
 * Migrate users with 'opus' pinned in their settings to 'opus[1m]' when they
 * are eligible for the merged Opus 1M experience (Max/Team Premium on 1P).
 *
 * CLI invocations with --model opus are unaffected: that flag is a runtime
 * override and does not touch userSettings, so it continues to use plain Opus.
 *
 * Pro subscribers are skipped — they retain separate Opus and Opus 1M options.
 * 3P users are skipped — their model strings are full model IDs, not aliases.
 *
 * Idempotent: only writes if userSettings.model is exactly 'opus'.
 */
export function migrateOpusToOpus1m(): void {
  if (!isOpus1mMergeEnabled()) {
    return
  }

  const model = getSettingsForSource('userSettings')?.model
  if (model !== 'opus') {
    return
  }

  // Nothing to merge when the default Opus is already native-1M (Opus 5): there
  // is no 200k variant, so 'opus[1m]' would only persist a phantom
  // 'claude-opus-5[1m]' into settings.json. The "already equals the default"
  // check below can't catch it either, since the [1m] string never matches.
  if (isNative1mModel(getDefaultOpusModel())) {
    return
  }

  const migrated = 'opus[1m]'
  const modelToSet =
    parseUserSpecifiedModel(migrated) ===
    parseUserSpecifiedModel(getDefaultMainLoopModelSetting())
      ? undefined
      : migrated
  updateSettingsForSource('userSettings', { model: modelToSet })

  logEvent('tengu_opus_to_opus1m_migration', {})
}

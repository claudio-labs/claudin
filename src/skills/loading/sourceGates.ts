/**
 * The switches that decide which skill sources load. They are read at call
 * time, because settings, policy and the environment change between calls.
 */
import { isSettingSourceEnabled } from 'src/platform/settings/constants.js'
import { isRestrictedToPluginOnly } from 'src/platform/settings/pluginOnlyPolicy.js'
import { isBareMode, isEnvTruthy } from 'src/shared/envUtils.js'

export type SourceGates = {
  /** `--bare` or CLAUDIN_SIMPLE: only the `--add-dir` skills load. */
  bare: boolean
  /** A managed `strictPluginOnlyCustomization` that covers skills. */
  lockedToPlugins: boolean
  userSettings: boolean
  projectSettings: boolean
  /** Off when CLAUDIN_DISABLE_POLICY_SKILLS is set. */
  managedSkills: boolean
}

export function readSourceGates(): SourceGates {
  return {
    bare: isBareMode(),
    lockedToPlugins: isRestrictedToPluginOnly('skills'),
    userSettings: isSettingSourceEnabled('userSettings'),
    projectSettings: isSettingSourceEnabled('projectSettings'),
    managedSkills: !isEnvTruthy(process.env.CLAUDIN_DISABLE_POLICY_SKILLS),
  }
}

/**
 * Every project skills directory: the ones up the tree, the `--add-dir` ones
 * and the ones found under touched files. The plugin-only lock covers them
 * all, in bare mode too.
 */
export function allowsProjectSkills(gates: SourceGates): boolean {
  return gates.projectSettings && !gates.lockedToPlugins
}

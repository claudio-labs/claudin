/**
 * The write step of /auto-mode-setup: diff the proposal against what is in
 * effect, then persist it.
 *
 * The target is always `userSettings`. `getAutoModeConfig` only trusts
 * user/flag/policy settings — a `.claudin/settings.json` or
 * `.claudin/settings.local.json` lives in the repository, so writing there
 * would produce a file that looks configured and does nothing.
 */

import { updateSettingsForSource } from 'src/platform/settings/settings.js'
import type { EditableSettingSource } from 'src/platform/settings/constants.js'
import type { AutoModeRules } from 'src/permissions/yoloClassifier.js'
import type { ProposedRules } from 'src/commands/auto-mode-setup/analyzeRules.js'

/** Where a generated config may be written. Deliberately not a choice. */
export const AUTO_MODE_WRITE_TARGET: EditableSettingSource = 'userSettings'

export type SectionDiff = {
  section: 'allow' | 'soft_deny' | 'environment'
  added: string[]
  removed: string[]
  kept: string[]
}

export function diffRules(
  current: AutoModeRules | null,
  proposed: Pick<ProposedRules, 'allow' | 'soft_deny' | 'environment'>,
): SectionDiff[] {
  return (['allow', 'soft_deny', 'environment'] as const).map(section => {
    const before = new Set(current?.[section] ?? [])
    const after = proposed[section]
    return {
      section,
      added: after.filter(entry => !before.has(entry)),
      kept: after.filter(entry => before.has(entry)),
      removed: [...before].filter(entry => !after.includes(entry)),
    }
  })
}

/** True when the proposal changes nothing that is already in effect. */
export function isNoOpDiff(diff: readonly SectionDiff[]): boolean {
  return diff.every(
    section => section.added.length === 0 && section.removed.length === 0,
  )
}

export type ApplyRulesDeps = {
  writeSettings: typeof updateSettingsForSource
}

export function defaultApplyRulesDeps(): ApplyRulesDeps {
  return { writeSettings: updateSettingsForSource }
}

/**
 * Persist the proposal. Only the three rule sections are written; notes stay
 * in the UI, since the classifier would read them as rules.
 */
export function applyRules(
  rules: Pick<ProposedRules, 'allow' | 'soft_deny' | 'environment'>,
  deps: ApplyRulesDeps = defaultApplyRulesDeps(),
): { error: Error | null } {
  return deps.writeSettings(AUTO_MODE_WRITE_TARGET, {
    autoMode: {
      allow: rules.allow,
      soft_deny: rules.soft_deny,
      environment: rules.environment,
    },
  })
}

/** Turn auto mode on, and optionally make it the default mode. */
export function enableAutoMode(
  makeDefault: boolean,
  deps: ApplyRulesDeps = defaultApplyRulesDeps(),
): { error: Error | null } {
  return deps.writeSettings(AUTO_MODE_WRITE_TARGET, {
    skipAutoPermissionPrompt: true,
    ...(makeDefault ? { permissions: { defaultMode: 'auto' as const } } : {}),
  })
}

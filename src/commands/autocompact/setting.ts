// /autocompact's settings logic, as in Claude Code 2.1.323: parse a window,
// save it for the current model in the user's settings.json
// (`modelSettings[<model>].autoCompactWindow`), and describe what is in effect.
// autoCompactWindow.ts is where the saved value is read back.

import { isAutoCompactEnabled } from 'src/agent/compact/autoCompact.js'
import {
  AUTO_COMPACT_WINDOW_ENV,
  type ConfiguredAutoCompactWindow,
  configuredAutoCompactWindow,
  parseTokenCount,
} from 'src/agent/compact/autoCompactWindow.js'
import { getContextWindowForModel } from 'src/agent/context/context.js'
import { getSdkBetas } from 'src/platform/bootstrap/state.js'
import { getSettingsForSource, updateSettingsForSource } from 'src/platform/settings/settings.js'
import type { SettingsJson } from 'src/platform/settings/types.js'
import { renderModelName } from 'src/providers/model/model.js'
import { formatTokens } from 'src/shared/text/format.js'

const MIN_AUTO_COMPACT_WINDOW = 100_000
const MAX_AUTO_COMPACT_WINDOW = 1_000_000
const AUTO_COMPACT_WINDOW_STEP = 100_000

/** What the user picks: a window in tokens, or auto. */
export type AutoCompactChoice = number | 'auto'

export const AUTO_COMPACT_EXPLANATION =
  "Auto-compact summarizes the conversation when context usage approaches this limit. The actual threshold is the minimum of this setting and your model's maximum context window."
export const AUTO_COMPACT_DISABLED_NOTE = 'Auto-compact is currently disabled (see /config)'
export const ENV_PRECEDENCE = `${AUTO_COMPACT_WINDOW_ENV} is set and takes precedence. Unset it to change this setting.`

/**
 * `auto` (or `reset`, `unset`, `default`), or a token count from 100k to 1M:
 * `500k`, `1m`, `200000`, or a bare `100`–`1000` read as thousands.
 */
export function parseAutoCompactWindow(raw: string): AutoCompactChoice | undefined {
  const text = raw.trim().toLowerCase()
  if (text === 'auto' || text === 'reset' || text === 'unset' || text === 'default') return 'auto'
  const parsed = parseTokenCount(text)
  if (!parsed) return undefined
  const bareThousands = !parsed.suffixed && parsed.tokens >= 100 && parsed.tokens <= 1_000
  const tokens = bareThousands ? parsed.tokens * 1_000 : parsed.tokens
  return tokens >= MIN_AUTO_COMPACT_WINDOW && tokens <= MAX_AUTO_COMPACT_WINDOW ? tokens : undefined
}

const SOURCE_LABEL = { env: `from ${AUTO_COMPACT_WINDOW_ENV}`, settings: 'from settings' } as const

function modelContextWindow(model: string): number {
  return getContextWindowForModel(model, getSdkBetas())
}

/** `auto`, or `200k tokens (from settings)`, with the model's cap when it applies. */
export function describeConfiguredWindow(model: string): string {
  const configured = configuredAutoCompactWindow(model)
  if (configured.source === 'auto') return 'auto'
  const limit = modelContextWindow(model)
  const capped = configured.window > limit ? ` · capped to ${formatTokens(limit)} by model` : ''
  return `${formatTokens(configured.window)} tokens (${SOURCE_LABEL[configured.source]})${capped}`
}

/** The setting, auto-compact being off, then what the window means. */
export function autoCompactStatusText(model: string, enabled: boolean = isAutoCompactEnabled()): string {
  return [
    `Auto-compact window for ${renderModelName(model)}: ${describeConfiguredWindow(model)}`,
    ...(enabled ? [] : [AUTO_COMPACT_DISABLED_NOTE]),
    AUTO_COMPACT_EXPLANATION,
  ].join('\n')
}

/** The user's settings.json: what is saved there now, and the merge that writes it. */
export type UserSettingsStore = {
  read: () => SettingsJson | null
  save: typeof updateSettingsForSource
}

type ModelSettings = NonNullable<SettingsJson['modelSettings']>

const USER_SETTINGS: UserSettingsStore = {
  read: () => getSettingsForSource('userSettings'),
  save: updateSettingsForSource,
}

/** `/autocompact <arg>`: parse it, then save it. */
export function applyAutoCompactWindow(
  raw: string,
  model: string,
  store: UserSettingsStore = USER_SETTINGS,
): string {
  if (configuredAutoCompactWindow(model).source === 'env') return ENV_PRECEDENCE
  const choice = parseAutoCompactWindow(raw)
  if (choice === undefined) {
    return `Couldn't parse '${raw.trim()}'. Expected 'auto' or 100k–1M tokens (e.g. 500k, 200000, or 200 as shorthand)`
  }
  return saveAutoCompactWindow(choice, model, store)
}

/** Saves the choice for the model and says what took effect. */
export function saveAutoCompactWindow(
  choice: AutoCompactChoice,
  model: string,
  store: UserSettingsStore = USER_SETTINGS,
): string {
  if (configuredAutoCompactWindow(model).source === 'env') return ENV_PRECEDENCE
  const userSaved = store.read()?.modelSettings
  const override = overridingWindow(model, userSaved)
  const { error } = store.save('userSettings', {
    modelSettings: modelSettingsUpdate(userSaved, model, choice),
  })
  if (error) return `Couldn't save setting: ${error.message}`

  const prefix = `Auto-compact window for ${renderModelName(model)}`
  const limit = modelContextWindow(model)
  if (override !== undefined) {
    const set = choice === 'auto' ? 'auto in settings' : `${formatTokens(choice)} tokens`
    return `${prefix} set to ${set}, but a higher-priority override is active (${formatTokens(Math.min(override, limit))} tokens)`
  }
  if (choice === 'auto') return `${prefix} set to auto`
  const capped = limit < choice ? ` (capped to model limit of ${formatTokens(limit)})` : ''
  return `${prefix} set to ${formatTokens(choice)} tokens${capped}`
}

/**
 * The window a project, local, flag or policy setting gives the model, which
 * the user's own settings.json — the lowest source, and the one written
 * here — cannot override.
 */
function overridingWindow(model: string, userSaved: ModelSettings | undefined): number | undefined {
  const inEffect = configuredAutoCompactWindow(model)
  if (inEffect.source !== 'settings') return undefined
  return inEffect.window !== userSaved?.[model]?.autoCompactWindow ? inEffect.window : undefined
}

/**
 * What to merge into `modelSettings`. `undefined` deletes
 * (updateSettingsForSource), so `auto` drops the window, the model's entry
 * when the window was all it held, and `modelSettings` itself when that entry
 * was all there was — no `{}` left behind.
 */
function modelSettingsUpdate(
  saved: ModelSettings | undefined,
  model: string,
  choice: AutoCompactChoice,
): ModelSettings | undefined {
  if (choice !== 'auto') return { [model]: { autoCompactWindow: choice } }
  const otherKeys = Object.keys(saved?.[model] ?? {}).filter(key => key !== 'autoCompactWindow')
  if (otherKeys.length > 0) return { [model]: { autoCompactWindow: undefined } }
  const otherModels = Object.keys(saved ?? {}).filter(key => key !== model)
  if (otherModels.length === 0) return undefined
  // Partial<Record<K, V>> widens the value to admit the deleting `undefined`.
  const dropEntry: Partial<ModelSettings> = { [model]: undefined }
  return dropEntry as ModelSettings
}

/** Where the dialog starts: auto, or the configured window on the 100k grid. */
export function initialDialogValue(configured: ConfiguredAutoCompactWindow): AutoCompactChoice {
  if (configured.source === 'auto') return 'auto'
  const snapped = Math.round(configured.window / AUTO_COMPACT_WINDOW_STEP) * AUTO_COMPACT_WINDOW_STEP
  return Math.min(MAX_AUTO_COMPACT_WINDOW, Math.max(MIN_AUTO_COMPACT_WINDOW, snapped))
}

/** One ←/→ step: auto sits past both ends of 100k–1M. */
export function stepAutoCompactWindow(choice: AutoCompactChoice, direction: 1 | -1): AutoCompactChoice {
  if (choice === 'auto') return direction > 0 ? MIN_AUTO_COMPACT_WINDOW : MAX_AUTO_COMPACT_WINDOW
  const next = choice + direction * AUTO_COMPACT_WINDOW_STEP
  return next < MIN_AUTO_COMPACT_WINDOW || next > MAX_AUTO_COMPACT_WINDOW ? 'auto' : next
}

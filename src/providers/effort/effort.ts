// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { isUltrathinkEnabled } from 'src/agent/context/thinking.js'
import { getInitialSettings, getSettingsForSource } from 'src/platform/settings/settings.js'
import { isProSubscriber, isMaxSubscriber, isTeamSubscriber } from 'src/providers/auth/auth.js'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import { getAPIProvider } from 'src/providers/model/providers.js'
import { get3PModelCapabilityOverride } from 'src/providers/model/modelSupportOverrides.js'
import { supportsCodexReasoningEffort } from 'src/providers/presets/providerConfig.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import type { EffortLevel } from 'src/platform/entrypoints/sdk/runtimeTypes.js'
import { getCurrentProjectConfig, saveCurrentProjectConfig } from 'src/platform/config/config.js'
import { logError } from 'src/shared/log.js'

export type { EffortLevel }

export const EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
  'max',
] as const satisfies readonly EffortLevel[]

export const OPENAI_EFFORT_LEVELS = [
  'low',
  'medium',
  'high',
  'xhigh',
] as const

export type OpenAIEffortLevel = typeof OPENAI_EFFORT_LEVELS[number]

export const KIMI_EFFORT_LEVELS = [
  'low',
  'high',
  'max',
] as const

export type KimiEffortLevel = typeof KIMI_EFFORT_LEVELS[number]

/**
 * Sentinel effort value meaning "don't pin an effort level — let the server
 * scale per request". Resolves to no `effort` field on the API request
 * (configureEffortParams omits it), so the model picks its own effort.
 * Distinct from `undefined` (which falls through to the model default,
 * e.g. medium on Opus 4.8 Pro).
 */
export const ADAPTIVE_EFFORT = 'adaptive' as const
export type AdaptiveEffort = typeof ADAPTIVE_EFFORT
export type EffortValue = EffortLevel | number | AdaptiveEffort

export function isAdaptiveEffort(value: unknown): value is AdaptiveEffort {
  return value === ADAPTIVE_EFFORT
}

/**
 * Kimi Code "K3" supports three discrete thinking-effort levels on its
 * OpenAI-compatible `/coding/v1/chat/completions` endpoint:
 * `thinking: { type: 'enabled', effort: 'low' | 'high' | 'max', keep: 'all' }`.
 * Other Kimi models (kimi-for-coding, etc.) expose thinking as on/off only.
 */
function isKimiEffortModel(model: string): boolean {
  const m = model.toLowerCase()
  // Provider-qualified aliases from /model discovery or manual input.
  return m === 'k3' || m.endsWith('/k3')
}

export function modelUsesKimiEffort(model: string): boolean {
  return isKimiEffortModel(model)
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports the effort parameter.
export function modelSupportsEffort(model: string): boolean {
  const m = model.toLowerCase()
  if (isEnvTruthy(process.env.CLAUDIN_ALWAYS_ENABLE_EFFORT)) {
    return true
  }
  const supported3P = get3PModelCapabilityOverride(model, 'effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  // Kimi Code K3 has three native thinking-effort levels (Low/High/Max).
  if (isKimiEffortModel(model)) {
    return true
  }
  if (modelUsesOpenAIEffort(model) && supportsCodexReasoningEffort(model)) {
    return true
  }
  // Supported by a subset of Claude 4 models
  if (m.includes('fable-5') || m.includes('sonnet-5') || m.includes('opus-5') || m.includes('opus-4-8') || m.includes('opus-4-7') || m.includes('opus-4-6') || m.includes('sonnet-4-6')) {
    return true
  }
  // Exclude any other known legacy models (haiku, older opus/sonnet variants)
  if (m.includes('haiku') || m.includes('sonnet') || m.includes('opus')) {
    return false
  }

  // IMPORTANT: Do not change the default effort support without notifying
  // the model launch DRI and research. This is a sensitive setting that can
  // greatly affect model quality and bashing.

  // Default to true for unknown model strings on 1P.
  // Do not default to true for 3P as they have different formats for their
  // model strings (ex. anthropics/claude-code#30795)
  return getAPIProvider() === 'firstParty'
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'max' effort.
// Per API docs, 'max' is available on Opus 4.6/4.7/4.8, Opus 5, Fable 5, and
// Sonnet 5 for public models — other models return an error.
export function modelSupportsMaxEffort(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'max_effort')
  if (supported3P !== undefined) {
    return supported3P
  }
  const m = model.toLowerCase()
  if (m.includes('fable-5') || m.includes('sonnet-5') || m.includes('opus-5') || m.includes('opus-4-8') || m.includes('opus-4-7') || m.includes('opus-4-6')) {
    return true
  }
  // Kimi Code K3 exposes Low/High/Max thinking effort.
  if (isKimiEffortModel(model)) {
    return true
  }
  return false
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports 'xhigh' effort.
// Per API docs, 'xhigh' is available on Opus 4.7/4.8, Opus 5, Fable 5, and
// Sonnet 5 only.
export function modelSupportsXhighEffort(model: string): boolean {
  const m = model.toLowerCase()
  return m.includes('fable-5') || m.includes('sonnet-5') || m.includes('opus-5') || m.includes('opus-4-8') || m.includes('opus-4-7')
}

export function isEffortLevel(value: string): value is EffortLevel {
  return (EFFORT_LEVELS as readonly string[]).includes(value)
}

export function isOpenAIEffortLevel(value: string): value is OpenAIEffortLevel {
  return (OPENAI_EFFORT_LEVELS as readonly string[]).includes(value)
}

export function modelUsesOpenAIEffort(model: string): boolean {
  const provider = getAPIProvider()
  return provider === 'openai' || provider === 'codex'
}

export function getAvailableEffortLevels(model: string): EffortLevel[] | OpenAIEffortLevel[] | KimiEffortLevel[] {
  if (!modelSupportsEffort(model)) {
    return []
  }
  if (modelUsesKimiEffort(model)) {
    return [...KIMI_EFFORT_LEVELS] as KimiEffortLevel[]
  }
  if (modelUsesOpenAIEffort(model)) {
    return [...OPENAI_EFFORT_LEVELS] as OpenAIEffortLevel[]
  }
  const levels: EffortLevel[] = ['low', 'medium', 'high']
  if (modelSupportsXhighEffort(model)) {
    levels.push('xhigh')
  }
  if (modelSupportsMaxEffort(model)) {
    levels.push('max')
  }
  return levels
}

/**
 * Step the effort one notch up ('right') or down ('left') within the levels
 * available for `model`, wrapping at the ends. Backs the Shift+←/→ prompt
 * hotkey. Returns the next level, or `undefined` when the model has no effort
 * levels (caller should no-op). An undefined / adaptive / out-of-range
 * `current` starts from the model's default level (so the first press leaves
 * adaptive for a concrete level).
 */
export function cycleEffortForModel(
  current: EffortValue | undefined,
  model: string,
  direction: 'left' | 'right',
): EffortLevel | OpenAIEffortLevel | undefined {
  const levels = getAvailableEffortLevels(model)
  if (levels.length === 0) {
    return undefined
  }
  // Bucket a numeric session effort (e.g. CLAUDIN_EFFORT_LEVEL=30, CLI,
  // remote config) into its named level so cycling steps from where the user
  // actually is, not the model default. Strings ('adaptive', out-of-range
  // levels) fall through to the default start so adaptive leaves for a concrete
  // level on the first press.
  const currentLevel =
    typeof current === 'number' ? convertEffortValueToLevel(current) : current
  const startLevel =
    typeof currentLevel === 'string' && (levels as string[]).includes(currentLevel)
      ? currentLevel
      : defaultStartLevel(model, levels)
  let idx = (levels as string[]).indexOf(startLevel)
  if (idx === -1) {
    idx = 0
  }
  const step = direction === 'right' ? 1 : -1
  const nextIdx = (idx + step + levels.length) % levels.length
  return levels[nextIdx]
}

function defaultStartLevel(
  model: string,
  levels: EffortLevel[] | OpenAIEffortLevel[],
): string {
  const level = getModelDefaultEffortLevel(model)
  return (levels as string[]).includes(level) ? level : levels[0]!
}

/**
 * The model's default effort as a concrete level — model-only, ignoring the
 * session value and env override — with the same 'high' fallback the API uses
 * when no effort param is sent. Canonical resolver for "what level does this
 * model default to" (distinct from getDisplayedEffortLevel, which folds in the
 * session value and CLAUDIN_EFFORT_LEVEL).
 */
export function getModelDefaultEffortLevel(model: string): EffortLevel {
  const def = getDefaultEffortForModel(model)
  return def !== undefined ? convertEffortValueToLevel(def) : 'high'
}

export function getEffortLevelLabel(level: EffortLevel | OpenAIEffortLevel): string {
  // Anthropic ("xhigh") and Codex ("xhigh") share the same wire value; label by provider.
  // On firstParty/Bedrock/Vertex/Foundry we render "Extra" (matches claude.ai UI for Opus 4.7/4.8).
  // On OpenAI/Codex we keep "Extra High" to avoid breaking the existing label.
  if (level === 'xhigh') {
    const provider = getAPIProvider()
    return provider === 'openai' || provider === 'codex' ? 'Extra High' : 'Extra'
  }
  if (level === 'max') return 'Max'
  return capitalize(level)
}

export function openAIEffortToStandard(level: OpenAIEffortLevel): EffortLevel {
  if (level === 'xhigh') return 'max'
  return level
}

export function standardEffortToOpenAI(level: EffortLevel): OpenAIEffortLevel {
  if (level === 'max') return 'xhigh'
  return level as OpenAIEffortLevel
}

function capitalize(s: string): string {
  return s.charAt(0).toUpperCase() + s.slice(1)
}

export function parseEffortValue(value: unknown): EffortValue | undefined {
  if (value === undefined || value === null || value === '') {
    return undefined
  }
  if (typeof value === 'number' && isValidNumericEffort(value)) {
    return value
  }
  const str = String(value).toLowerCase()
  if (isEffortLevel(str)) {
    return str
  }
  const numericValue = parseInt(str, 10)
  if (!isNaN(numericValue) && isValidNumericEffort(numericValue)) {
    return numericValue
  }
  return undefined
}

/**
 * Numeric values are model-default only and not persisted.
 * 'max' can now be persisted by all users.
 * Write sites call this before saving to settings so the Zod schema
 * (which only accepts string levels) never rejects a write.
 */
export function toPersistableEffort(
  value: EffortValue | undefined,
): EffortLevel | AdaptiveEffort | undefined {
  if (value === 'low' || value === 'medium' || value === 'high') {
    return value
  }
  if (value === 'xhigh' || value === 'max') {
    return value
  }
  if (isAdaptiveEffort(value)) {
    return value
  }
  return undefined
}

export function getInitialEffortSetting(): EffortLevel | AdaptiveEffort | undefined {
  // Project pin wins over the global setting, mirroring how `/model` resolves
  // (`getUserSpecifiedModelSetting`). An explicit 'auto' pin means "no effort
  // here" and deliberately shadows a globally pinned level.
  const pin = getProjectEffortPin()
  if (pin === PROJECT_EFFORT_AUTO) {
    return undefined
  }
  if (pin !== undefined) {
    return pin
  }
  // toPersistableEffort validates 'max' on read, so a manually
  // edited settings.json with an invalid level doesn't leak into a fresh session.
  return toPersistableEffort(getInitialSettings().effortLevel)
}

/**
 * Sentinel stored in `ProjectConfig.activeEffortForProject` meaning "this
 * project runs on the model default" — distinct from an absent pin, which
 * means "inherit the global `settings.effortLevel`".
 */
export const PROJECT_EFFORT_AUTO = 'auto' as const

export type ProjectEffortPin =
  | EffortLevel
  | AdaptiveEffort
  | typeof PROJECT_EFFORT_AUTO

/**
 * The effort pinned for the current project, or undefined when the project
 * inherits the global setting. A hand-edited config with an unknown level is
 * treated as "no pin" rather than leaking into the session.
 */
export function getProjectEffortPin(): ProjectEffortPin | undefined {
  const raw = getCurrentProjectConfig().activeEffortForProject
  if (raw === PROJECT_EFFORT_AUTO) {
    return PROJECT_EFFORT_AUTO
  }
  return toPersistableEffort(raw)
}

function writeProjectEffortPin(pin: ProjectEffortPin | undefined): {
  error?: Error
} {
  try {
    saveCurrentProjectConfig(current =>
      current.activeEffortForProject === pin
        ? current
        : { ...current, activeEffortForProject: pin },
    )
    return {}
  } catch (e) {
    const error = e instanceof Error ? e : new Error(String(e))
    logError(error)
    return { error }
  }
}

/**
 * Persist an effort choice for the current project. Numeric values stay
 * session-only (the pin schema only accepts named levels), so they are a no-op
 * here — same as the old settings write, which skipped them too.
 */
export function persistEffortForProject(value: EffortValue): {
  error?: Error
} {
  const persistable = toPersistableEffort(value)
  if (persistable === undefined) {
    return {}
  }
  return writeProjectEffortPin(persistable)
}

/** Pin "no effort for this project" (`/effort auto`). Overrides the global. */
export function pinProjectEffortAuto(): { error?: Error } {
  return writeProjectEffortPin(PROJECT_EFFORT_AUTO)
}

/** Drop the project pin so the global setting applies again (`/effort inherit`). */
export function clearProjectEffortPin(): { error?: Error } {
  return writeProjectEffortPin(undefined)
}

/**
 * The last effort the user explicitly persisted, for
 * `resolvePickerEffortPersistence`. Reads the project pin first, then the
 * user's own settings.json — never the merged settings, since project/policy
 * layers must not be mistaken for an explicit choice.
 */
export function getPriorPersistedEffort():
  | EffortLevel
  | AdaptiveEffort
  | undefined {
  const pin = getProjectEffortPin()
  if (pin === PROJECT_EFFORT_AUTO) {
    return undefined
  }
  if (pin !== undefined) {
    return pin
  }
  return toPersistableEffort(getSettingsForSource('userSettings')?.effortLevel)
}

/** Where the session's effort came from — backs the `/effort current` message. */
export function getProjectEffortOrigin():
  | 'project'
  | 'project-auto'
  | 'global'
  | 'none' {
  const pin = getProjectEffortPin()
  if (pin === PROJECT_EFFORT_AUTO) {
    return 'project-auto'
  }
  if (pin !== undefined) {
    return 'project'
  }
  return toPersistableEffort(getInitialSettings().effortLevel) !== undefined
    ? 'global'
    : 'none'
}

/**
 * Decide what effort level (if any) to persist when the user selects a model
 * in ModelPicker. Keeps an explicit prior /effort choice sticky even when it
 * matches the picked model's default, while letting purely-default and
 * session-ephemeral effort (CLI --effort, EffortCallout default) fall through
 * to undefined so it follows future model-default changes.
 *
 * priorPersisted must come from userSettings on disk
 * (getSettingsForSource('userSettings')?.effortLevel), NOT merged settings
 * (project/policy layers would leak into the user's global settings.json)
 * and NOT AppState.effortValue (includes session-scoped sources that
 * deliberately do not write to settings.json).
 */
export function resolvePickerEffortPersistence(
  picked: EffortLevel | undefined,
  modelDefault: EffortLevel,
  priorPersisted: EffortLevel | AdaptiveEffort | undefined,
  toggledInPicker: boolean,
): EffortLevel | undefined {
  const hadExplicit = priorPersisted !== undefined || toggledInPicker
  return hadExplicit || picked !== modelDefault ? picked : undefined
}

export function getEffortEnvOverride(): EffortValue | null | undefined {
  const envOverride = process.env.CLAUDIN_EFFORT_LEVEL
  return envOverride?.toLowerCase() === 'unset' ||
    envOverride?.toLowerCase() === 'auto'
    ? null
    : parseEffortValue(envOverride)
}

/**
 * True when CLAUDIN_EFFORT_LEVEL will keep overriding `next` this session.
 * Backs the "won't apply" warning on the prompt effort hotkey / /effort.
 *   - unset (undefined): no conflict.
 *   - 'auto'/'unset' (null): forces adaptive at resolve time, overriding any
 *     concrete `next` → conflict.
 *   - pinned value: conflict only when it resolves to a different level bucket,
 *     so a numeric override (e.g. =30) landing in the same bucket as `next`
 *     isn't flagged (the footer would show the same level either way).
 */
export function effortEnvOverrideConflictsWith(next: EffortValue): boolean {
  const envOverride = getEffortEnvOverride()
  if (envOverride === undefined) {
    return false
  }
  if (envOverride === null) {
    return true
  }
  return convertEffortValueToLevel(envOverride) !== convertEffortValueToLevel(next)
}

/**
 * Resolve the effort value that will actually be sent to the API for a given
 * model, following the full precedence chain:
 *   env CLAUDIN_EFFORT_LEVEL → appState.effortValue → model default
 *
 * Returns undefined when no effort parameter should be sent (env set to
 * 'unset', or no default exists for the model).
 */
export function resolveAppliedEffort(
  model: string,
  appStateEffortValue: EffortValue | undefined,
): EffortValue | undefined {
  const envOverride = getEffortEnvOverride()
  if (envOverride === null) {
    return undefined
  }
  const resolved =
    envOverride ?? appStateEffortValue ?? getDefaultEffortForModel(model)
  // 'adaptive' means "send no effort field" so the server scales per request.
  if (isAdaptiveEffort(resolved)) {
    return undefined
  }
  // Kimi Code K3 only accepts low/high/max thinking effort. Normalize before
  // the generic xhigh/max downgrade rules so xhigh maps up to max, not down.
  if (isKimiEffortModel(model) && typeof resolved === 'string') {
    if (resolved === 'xhigh') {
      return 'max'
    }
    if (resolved === 'medium') {
      return 'low'
    }
  }
  // API rejects 'max' on non-Opus-4.6 models — downgrade to 'high'.
  if (resolved === 'max' && !modelSupportsMaxEffort(model)) {
    return 'high'
  }
  // API rejects 'xhigh' on models that don't support it — downgrade to 'high'.
  if (resolved === 'xhigh' && !modelSupportsXhighEffort(model) && !modelUsesOpenAIEffort(model)) {
    return 'high'
  }
  return resolved
}

/**
 * Resolve the effort level to show the user. Wraps resolveAppliedEffort
 * with the 'high' fallback (what the API uses when no effort param is sent).
 * Single source of truth for the status bar and /effort output (CC-1088).
 */
export function getDisplayedEffortLevel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel {
  const resolved = resolveAppliedEffort(model, appStateEffort) ?? 'high'
  return convertEffortValueToLevel(resolved)
}

/**
 * Display string for the effort surfaces (status bar, /effort output,
 * startup screen). Returns the literal 'adaptive' when the user picked the
 * adaptive mode (which has no fixed level), otherwise the resolved level.
 */
export function getDisplayedEffortLabel(
  model: string,
  appStateEffort: EffortValue | undefined,
): EffortLevel | AdaptiveEffort {
  if (isAdaptiveEffort(appStateEffort)) return ADAPTIVE_EFFORT
  return getDisplayedEffortLevel(model, appStateEffort)
}

/**
 * Build the ` with {level} effort` suffix shown in Logo/Spinner.
 * Returns empty string if the user hasn't explicitly set an effort value.
 * Delegates to resolveAppliedEffort() so the displayed level matches what
 * the API actually receives (including max→high clamp for non-Opus models).
 */
export function getEffortSuffix(
  model: string,
  effortValue: EffortValue | undefined,
): string {
  if (effortValue === undefined) return ''
  if (isAdaptiveEffort(effortValue)) return formatEffortSuffix(ADAPTIVE_EFFORT)
  const resolved = resolveAppliedEffort(model, effortValue)
  if (resolved === undefined) return ''
  return formatEffortSuffix(convertEffortValueToLevel(resolved))
}

/**
 * Wording of the effort suffix, for callers that already hold a resolved
 * label (the startup banner) rather than the raw setting. Keeps the Logo,
 * the Spinner and the banner phrasing it the same way.
 */
export function formatEffortSuffix(label: EffortLevel | AdaptiveEffort): string {
  return ` with ${label} effort`
}

export function isValidNumericEffort(value: number): boolean {
  return Number.isInteger(value)
}

/**
 * Map the user-selected /effort to a thinking-token budget. The default
 * (`upperLimit - 1` ≈ 32k on Opus) made sense only under adaptive thinking
 * where the server ignored the number; under fixed-budget thinking it
 * dominates first-token latency. Tying budget to effort makes /effort a
 * real latency knob: low → fast, max → deep reasoning.
 *
 * Undefined (user never set /effort) and the legacy adaptive sentinel both
 * resolve to medium — sane default that matches the "auto" UX bucket.
 */
export function getThinkingBudgetForEffort(
  effortValue: EffortValue | undefined,
): number {
  if (effortValue === undefined || isAdaptiveEffort(effortValue)) {
    return 4096
  }
  switch (convertEffortValueToLevel(effortValue)) {
    case 'low': return 1024
    case 'medium': return 4096
    case 'high': return 8192
    case 'xhigh': return 16384
    case 'max': return 32768
  }
}

export function convertEffortValueToLevel(value: EffortValue): EffortLevel {
  if (typeof value === 'string') {
    // Runtime guard: value may come from remote config (GrowthBook) where
    // TypeScript types can't help us. Coerce unknown strings to 'high'
    // rather than passing them through unchecked.
    return isEffortLevel(value) ? value : 'high'
  }
  // Numeric inputs come from env overrides (CLAUDIN_EFFORT_LEVEL=30) or
  // remote config. Bucket into named levels so downstream code paths that
  // only know about the discrete EffortLevel enum behave sensibly.
  if (value <= 50) return 'low'
  if (value <= 85) return 'medium'
  if (value <= 100) return 'high'
  return 'max'
}

/**
 * Get user-facing description for effort levels
 *
 * @param level The effort level to describe
 * @returns Human-readable description
 */
export function getEffortLevelDescription(level: EffortLevel | OpenAIEffortLevel): string {
  switch (level) {
    case 'low':
      return 'Quick, straightforward implementation with minimal overhead'
    case 'medium':
      return 'Balanced approach with standard implementation and testing'
    case 'high':
      return 'Comprehensive implementation with extensive testing and documentation'
    case 'max':
      return 'Maximum capability with deepest reasoning (Opus 4.6/4.7/4.8, Opus 5, Fable 5, Sonnet 5)'
    case 'xhigh':
      return 'Extended capability for long-horizon work (Opus 4.7/4.8, Opus 5, Fable 5, Sonnet 5, OpenAI/Codex)'
  }
}

/**
 * Get user-facing description for effort values (both string and numeric)
 *
 * @param value The effort value to describe
 * @returns Human-readable description
 */
export function getEffortValueDescription(value: EffortValue): string {
  if (isAdaptiveEffort(value)) {
    return 'Model picks effort per request (low–xhigh, never max)'
  }
  if (typeof value === 'string') {
    return getEffortLevelDescription(value)
  }
  return getEffortLevelDescription(convertEffortValueToLevel(value))
}

export type OpusDefaultEffortConfig = {
  enabled: boolean
  dialogTitle: string
  dialogDescription: string
}

const OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT: OpusDefaultEffortConfig = {
  enabled: true,
  dialogTitle: 'We recommend medium effort for Opus',
  dialogDescription:
    'Effort determines how long Claude thinks for when completing your task. We recommend medium effort for most tasks to balance speed and intelligence and maximize rate limits. Use ultrathink to trigger high effort when needed.',
}

export function getOpusDefaultEffortConfig(): OpusDefaultEffortConfig {
  const config = getFeatureValue_CACHED_MAY_BE_STALE(
    'tengu_grey_step2',
    OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
  )
  return {
    ...OPUS_DEFAULT_EFFORT_CONFIG_DEFAULT,
    ...config,
  }
}

export function getDefaultEffortForModel(
  model: string,
): EffortValue | undefined {
  // IMPORTANT: Do not change the default effort level without notifying
  // the model launch DRI and research. Default effort is a sensitive setting
  // that can greatly affect model quality and bashing.

  // Default effort on Opus 4.6/4.7 to medium for Pro.
  // Max/Team also get medium when the tengu_grey_step2 config is enabled.
  const lowerModel = model.toLowerCase()

  // Kimi Code K3 defaults to Max thinking effort (matches the official CLI).
  if (isKimiEffortModel(model)) {
    return 'max'
  }

  // Opt-in: coding/high-autonomy loops on Opus 4.8 default to xhigh. The 4.8
  // `high` was recalibrated to think less than 4.7's, so without this the agent
  // under-plans (e.g. reads files one-by-one instead of batching). Wins over the
  // medium defaults below (Pro/Max/Team) and ultrathink. Opus 4.8 only.
  if (
    lowerModel.includes('opus-4-8') &&
    getInitialSettings().codingLoopXhighDefault === true
  ) {
    return 'xhigh'
  }

  // Claudin default: Opus 4.8, Opus 5 and Fable 5 on the first-party Anthropic
  // provider default to high effort, overriding the upstream Pro/Max/Team
  // medium defaults and the ultrathink medium fallback below. The xhigh
  // opt-in above still wins for Opus 4.8.
  if (
    (lowerModel.includes('opus-4-8') ||
      lowerModel.includes('opus-5') ||
      lowerModel.includes('fable-5')) &&
    getAPIProvider() === 'firstParty'
  ) {
    return 'high'
  }

  // @[MODEL LAUNCH]: add a new non-flagship 1P effort model here to give it the
  // medium default (flagships get 'high' in the branch above instead).
  // Claudin default: on the first-party Anthropic provider, the named
  // non-flagship effort models (Opus 4.6/4.7, Sonnet 4.6/5) default to medium,
  // regardless of subscription tier. Opus 4.8 and Fable 5 keep high above.
  // Match by explicit name (not modelSupportsEffort, which is true for unknown
  // 1P strings) so a future/unrecognized first-party model keeps the upstream
  // undefined→high default instead of silently regressing to medium — see the
  // DRI warning at the top of this function.
  if (
    getAPIProvider() === 'firstParty' &&
    (lowerModel.includes('opus-4-7') ||
      lowerModel.includes('opus-4-6') ||
      lowerModel.includes('sonnet-4-6') ||
      lowerModel.includes('sonnet-5'))
  ) {
    return 'medium'
  }

  if (lowerModel.includes('opus-4-8') || lowerModel.includes('opus-4-7') || lowerModel.includes('opus-4-6')) {
    if (isProSubscriber()) {
      return 'medium'
    }
    if (
      getOpusDefaultEffortConfig().enabled &&
      (isMaxSubscriber() || isTeamSubscriber())
    ) {
      return 'medium'
    }
  }

  // When ultrathink feature is on, default effort to medium (ultrathink bumps to high)
  if (isUltrathinkEnabled() && modelSupportsEffort(model)) {
    return 'medium'
  }

  // Fallback to undefined, which means we don't set an effort level. This
  // should resolve to high effort level in the API.
  return undefined
}

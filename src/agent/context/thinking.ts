// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import type { Theme } from 'src/terminal/theme/theme.js'
import { feature } from 'bun:bundle'
import { getFeatureValue_CACHED_MAY_BE_STALE } from 'src/platform/analytics/growthbook.js'
import { getCanonicalName } from 'src/providers/model/model.js'
import { get3PModelCapabilityOverride } from 'src/providers/model/modelSupportOverrides.js'
import { getAPIProvider } from 'src/providers/model/providers.js'
import { getSettingsWithErrors } from 'src/platform/settings/settings.js'
import { isEnvDefinedFalsy, isEnvTruthy } from 'src/shared/envUtils.js'

export type ThinkingConfig =
  | { type: 'adaptive' }
  | { type: 'enabled'; budgetTokens: number }
  | { type: 'disabled' }

/**
 * Build-time gate (feature) + runtime gate (GrowthBook). The build flag
 * controls code inclusion in external builds; the GB flag controls rollout.
 */
export function isUltrathinkEnabled(): boolean {
  if (!feature('ULTRATHINK')) {
    return false
  }
  return getFeatureValue_CACHED_MAY_BE_STALE('tengu_turtle_carbon', true)
}

/**
 * Check if text contains the "ultrathink" keyword.
 */
export function hasUltrathinkKeyword(text: string): boolean {
  return /\bultrathink\b/i.test(text)
}

/**
 * Find positions of "ultrathink" keyword in text (for UI highlighting/notification)
 */
export function findThinkingTriggerPositions(text: string): Array<{
  word: string
  start: number
  end: number
}> {
  const positions: Array<{ word: string; start: number; end: number }> = []
  // Fresh /g literal each call — String.prototype.matchAll copies lastIndex
  // from the source regex, so a shared instance would leak state from
  // hasUltrathinkKeyword's .test() into this call on the next render.
  const matches = text.matchAll(/\bultrathink\b/gi)

  for (const match of matches) {
    if (match.index !== undefined) {
      positions.push({
        word: match[0],
        start: match.index,
        end: match.index + match[0].length,
      })
    }
  }

  return positions
}

const RAINBOW_COLORS: Array<keyof Theme> = [
  'rainbow_red',
  'rainbow_orange',
  'rainbow_yellow',
  'rainbow_green',
  'rainbow_blue',
  'rainbow_indigo',
  'rainbow_violet',
]

const RAINBOW_SHIMMER_COLORS: Array<keyof Theme> = [
  'rainbow_red_shimmer',
  'rainbow_orange_shimmer',
  'rainbow_yellow_shimmer',
  'rainbow_green_shimmer',
  'rainbow_blue_shimmer',
  'rainbow_indigo_shimmer',
  'rainbow_violet_shimmer',
]

export function getRainbowColor(
  charIndex: number,
  shimmer: boolean = false,
): keyof Theme {
  const colors = shimmer ? RAINBOW_SHIMMER_COLORS : RAINBOW_COLORS
  return colors[charIndex % colors.length]!
}

// TODO(inigo): add support for probing unknown models via API error detection
// Provider-aware thinking support detection (aligns with modelSupportsISP in betas.ts)
export function modelSupportsThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  // IMPORTANT: Do not change thinking support without notifying the model
  // launch DRI and research. This can greatly affect model quality and bashing.
  const canonical = getCanonicalName(model)
  const provider = getAPIProvider()
  // 1P and Foundry: all Claude 4+ models (including Haiku 4.5)
  if (provider === 'foundry' || provider === 'firstParty') {
    return !canonical.includes('claude-3-')
  }
  if (
    canonical.startsWith('deepseek-v4-') ||
    canonical === 'deepseek-reasoner'
  ) {
    return true
  }
  // 3P (Bedrock/Vertex): only Opus 4+ and Sonnet 4+/5. Sonnet 5 must be listed
  // here too — it's offered on 3P and is added to the 3P interleaved-thinking /
  // context-management gates in betas.ts, so omitting it would push those betas
  // while sending no thinking block. modelRequiresAdaptiveThinking forces
  // {type:'adaptive'} (never budget_tokens), which Bedrock/Vertex accept, so
  // enabling it here does not 400.
  return (
    canonical.includes('sonnet-4') ||
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-4') ||
    canonical.includes('opus-5')
  )
}

// @[MODEL LAUNCH]: Add the new model to the allowlist if it supports adaptive thinking.
export function modelSupportsAdaptiveThinking(model: string): boolean {
  const supported3P = get3PModelCapabilityOverride(model, 'adaptive_thinking')
  if (supported3P !== undefined) {
    return supported3P
  }
  const canonical = getCanonicalName(model)
  // Supported by a subset of Claude 4 models
  if (
    canonical.includes('fable-5') ||
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-5') ||
    canonical.includes('opus-4-8') ||
    canonical.includes('opus-4-7') ||
    canonical.includes('opus-4-6') ||
    canonical.includes('sonnet-4-6')
  ) {
    return true
  }
  // Exclude any other known legacy models (allowlist above catches 4-6 variants first)
  if (
    canonical.includes('opus') ||
    canonical.includes('sonnet') ||
    canonical.includes('haiku')
  ) {
    return false
  }
  // IMPORTANT: Do not change adaptive thinking support without notifying the
  // model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Newer models (4.6+) are all trained on adaptive thinking and MUST have it
  // enabled for model testing. DO NOT default to false for first party, otherwise
  // we may silently degrade model quality.

  // Default to true for unknown model strings on 1P and Foundry (because Foundry
  // is a proxy). Do not default to true for other 3P as they have different formats
  // for their model strings.
  const provider = getAPIProvider()
  return provider === 'firstParty' || provider === 'foundry'
}

// @[MODEL LAUNCH]: Add the new model here if budget-mode thinking is rejected
// by the API (thinking: {type: 'enabled', budget_tokens} → 400).
/**
 * Models where thinking is always on server-side and adaptive is the ONLY
 * accepted thinking-ON configuration. Sending budget_tokens — claudin's
 * /effort budget thinking mode — returns a 400 on these models, so streaming.ts
 * must force adaptive regardless of the CLAUDE_CODE_ENABLE_ADAPTIVE_THINKING
 * opt-out. It also
 * suppresses the temperature param (rejected as a non-default sampling param).
 *
 * - Fable 5: also rejects an explicit {type: 'disabled'} (400).
 * - Sonnet 5: budget_tokens 400s (so it belongs here), but {type: 'disabled'} is
 *   actually accepted. The streaming path omits the thinking param entirely when
 *   thinking is off (it never sends {type: 'disabled'}), so treating Sonnet 5 the
 *   same as Fable here loses no functionality.
 * - Opus 5: native-1M flagship, thinking always on server-side — same profile as
 *   Fable/Sonnet 5 (budget_tokens 400s, non-default sampling params rejected).
 */
export function modelRequiresAdaptiveThinking(model: string): boolean {
  const canonical = getCanonicalName(model)
  return (
    canonical.includes('fable-5') ||
    canonical.includes('sonnet-5') ||
    canonical.includes('opus-5')
  )
}

/**
 * Whether this model *would* use adaptive thinking (`thinking: { type:
 * 'adaptive' }`) when thinking is on. Mirrors the model/env side of the gate in
 * src/providers/shims/claude/streaming.ts (do not change that selection here —
 * this is a display-only helper). It deliberately does NOT decide whether
 * thinking is enabled at all (config/`thinkingConfig.type`); callers must
 * already know thinking is on (e.g. the spinner only shows the verb while
 * `thinkingStatus === 'thinking'`). The name says "would", not "is active",
 * precisely because the enabled-decision lives with the caller.
 */
export function modelWouldUseAdaptiveThinking(model: string): boolean {
  if (isEnvTruthy(process.env.CLAUDE_CODE_DISABLE_THINKING)) return false
  // Fable-class models only accept adaptive — forced on regardless of the opt-out.
  if (modelRequiresAdaptiveThinking(model)) return true
  if (!isAdaptiveThinkingEnabled()) return false
  return modelSupportsThinking(model) && modelSupportsAdaptiveThinking(model)
}

/**
 * Adaptive thinking is claudin's default for models that support it: it lets
 * the model scale thinking to task difficulty instead of burning a fixed
 * /effort-derived budget on trivial turns (which otherwise delays the first
 * visible answer token by ~2s). Opt out — falling back to budget mode — by
 * setting CLAUDE_CODE_ENABLE_ADAPTIVE_THINKING to a falsy value (0/false/no/off).
 * Both the display helper here and the real request selection in
 * src/providers/shims/claude/streaming.ts read this, so they stay in sync.
 */
export function isAdaptiveThinkingEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDE_CODE_ENABLE_ADAPTIVE_THINKING)
}

export function shouldEnableThinkingByDefault(): boolean {
  if (process.env.MAX_THINKING_TOKENS) {
    return parseInt(process.env.MAX_THINKING_TOKENS, 10) > 0
  }

  const { settings } = getSettingsWithErrors()
  if (settings.alwaysThinkingEnabled === false) {
    return false
  }

  // IMPORTANT: Do not change default thinking enabled value without notifying
  // the model launch DRI and research. This can greatly affect model quality and
  // bashing.

  // Enable thinking by default unless explicitly disabled.
  return true
}

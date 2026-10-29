/**
 * `generationConfig.thinkingConfig` for the native Gemini transport, by model
 * family the way gemini-cli picks it (packages/core/src/config/
 * defaultModelConfigs.ts): Gemini 3 and later take a `thinkingLevel`, 2.5
 * takes a `thinkingBudget`, and both are asked for their thought summaries
 * (`includeThoughts`), which come back as thinking blocks. Older models do not
 * think and get nothing.
 *
 * The level is the session effort, clamped onto what the model accepts (the
 * same resolver the picker reads); without one, gemini-cli's defaults: HIGH on
 * 3.x, 8192 tokens on 2.5. A request with thinking disabled gets the least the
 * model allows, without summaries.
 */
import {
  clampEffortToValues,
  GEMINI_FALLBACK_LEVELS,
  resolveShimEffortValues,
} from 'src/providers/model/reasoningCatalog.js'
import { geminiVersion } from 'src/providers/shims/gemini/endpoints.js'

export type GeminiThinkingConfig = {
  thinkingLevel?: string
  thinkingBudget?: number
  includeThoughts: boolean
}

/** 2.5 budgets per level; gemini-cli's default (8192) is `medium`. */
const BUDGET_BY_LEVEL: Readonly<Record<string, number>> = {
  low: 1024,
  medium: 8192,
  high: 24576,
}
const DEFAULT_BUDGET = BUDGET_BY_LEVEL.medium!
// 2.5 Pro cannot turn thinking off; its floor is 128 tokens.
const PRO_MIN_BUDGET = 128
const PRO_RE = /-pro\b/i

export function geminiThinkingConfig(options: {
  model: string
  baseUrl: string | undefined
  effort: string | undefined
  thinkingDisabled: boolean
}): GeminiThinkingConfig | undefined {
  const version = geminiVersion(options.model)
  if (version === undefined || version < 2.5) return undefined

  if (version >= 3) {
    const values = resolveShimEffortValues(options.baseUrl, options.model) ?? GEMINI_FALLBACK_LEVELS
    const level = options.thinkingDisabled
      ? clampEffortToValues('minimal', values)
      : clampEffortToValues(options.effort ?? 'high', values)
    return {
      ...(level && { thinkingLevel: level.toUpperCase() }),
      includeThoughts: !options.thinkingDisabled,
    }
  }

  if (options.thinkingDisabled) {
    return {
      thinkingBudget: PRO_RE.test(options.model) ? PRO_MIN_BUDGET : 0,
      includeThoughts: false,
    }
  }
  const level = options.effort
    ? clampEffortToValues(options.effort, ['low', 'medium', 'high'])
    : undefined
  return {
    thinkingBudget: (level && BUDGET_BY_LEVEL[level]) ?? DEFAULT_BUDGET,
    includeThoughts: true,
  }
}

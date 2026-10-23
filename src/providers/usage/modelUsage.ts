import type { CostStateModelUsage } from 'src/shared/types/logs.js'

/** Below this a cost left over by float subtraction is noise, not spend. */
const COST_EPSILON_USD = 1e-9

export function emptyModelUsage(): CostStateModelUsage {
  return {
    inputTokens: 0,
    outputTokens: 0,
    cacheReadInputTokens: 0,
    cacheCreationInputTokens: 0,
    webSearchRequests: 0,
    costUSD: 0,
  }
}

/** Adds `usage` into `into` field by field, and returns `into`. */
export function addModelUsage(
  into: CostStateModelUsage,
  usage: CostStateModelUsage,
): CostStateModelUsage {
  into.inputTokens += usage.inputTokens
  into.outputTokens += usage.outputTokens
  into.cacheReadInputTokens += usage.cacheReadInputTokens
  into.cacheCreationInputTokens += usage.cacheCreationInputTokens
  into.webSearchRequests += usage.webSearchRequests
  into.costUSD += usage.costUSD
  return into
}

/** Adds `usage` to the entry for `model`, creating it on first sight. */
export function addModelUsageTo(
  map: Record<string, CostStateModelUsage>,
  model: string,
  usage: CostStateModelUsage,
): void {
  addModelUsage((map[model] ??= emptyModelUsage()), usage)
}

/**
 * What `total` has beyond `claimed`, clamped at zero per field — or
 * undefined when nothing is left.
 */
export function remainingModelUsage(
  total: CostStateModelUsage,
  claimed: CostStateModelUsage,
): CostStateModelUsage | undefined {
  const rest: CostStateModelUsage = {
    inputTokens: Math.max(0, total.inputTokens - claimed.inputTokens),
    outputTokens: Math.max(0, total.outputTokens - claimed.outputTokens),
    cacheReadInputTokens: Math.max(
      0,
      total.cacheReadInputTokens - claimed.cacheReadInputTokens,
    ),
    cacheCreationInputTokens: Math.max(
      0,
      total.cacheCreationInputTokens - claimed.cacheCreationInputTokens,
    ),
    webSearchRequests: Math.max(
      0,
      total.webSearchRequests - claimed.webSearchRequests,
    ),
    costUSD: Math.max(0, total.costUSD - claimed.costUSD),
  }
  const hasTokens =
    rest.inputTokens > 0 ||
    rest.outputTokens > 0 ||
    rest.cacheReadInputTokens > 0 ||
    rest.cacheCreationInputTokens > 0 ||
    rest.webSearchRequests > 0
  if (!hasTokens && rest.costUSD < COST_EPSILON_USD) return undefined
  return rest
}

import type { BetaUsage as Usage } from '@anthropic-ai/sdk/resources/beta/messages/messages.mjs'

/**
 * Calculate total context window tokens from an API response's usage data.
 * Includes input_tokens + cache tokens + output_tokens.
 *
 * This represents the full context size at the time of that API call.
 * Use tokenCountWithEstimation() when you need context size from messages.
 *
 * output_tokens includes thinking. A model that drops earlier turns' thinking
 * from the next request reads less than this back, so there the count is high
 * by the last response's thinking.
 *
 * A module of its own so context.ts can share the sum without importing
 * tokens.ts and the message helpers behind it.
 */
export function getTokenCountFromUsage(
  usage: Pick<
    Usage,
    | 'input_tokens'
    | 'cache_creation_input_tokens'
    | 'cache_read_input_tokens'
    | 'output_tokens'
  >,
): number {
  return (
    usage.input_tokens +
    (usage.cache_creation_input_tokens ?? 0) +
    (usage.cache_read_input_tokens ?? 0) +
    usage.output_tokens
  )
}

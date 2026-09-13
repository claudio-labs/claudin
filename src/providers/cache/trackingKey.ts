import type { AgentId } from 'src/shared/types/ids.js'
import type { QuerySource } from 'src/agent/prompts/querySource.js'

const TRACKED_SOURCE_PREFIXES = [
  'repl_main_thread',
  'sdk',
  'agent:custom',
  'agent:default',
  'agent:builtin',
]

/**
 * Returns the cache tracking key for a querySource, or null if untracked.
 * Shared by the break detector (`promptCacheBreakDetection.ts`) and the
 * lagging marker (`shims/claude/lagCacheMarker.ts`) so both agree on which
 * requests share one server-side prefix.
 *
 * Compact shares the same server-side cache as repl_main_thread (same
 * cacheSafeParams), so they share tracking state.
 *
 * For subagents with a tracked querySource, uses the unique agentId to
 * isolate tracking state. This prevents false positive cache break
 * notifications when multiple instances of the same agent type run
 * concurrently.
 *
 * Untracked sources (speculation, session_memory, prompt_suggestion, etc.)
 * are short-lived forked agents where cache break detection provides no
 * value — they run 1-3 turns with a fresh agentId each time, so there's
 * nothing meaningful to compare against. Their cache metrics are still
 * logged via tengu_api_success for analytics.
 */
export function getCacheTrackingKey(
  querySource: QuerySource,
  agentId?: AgentId,
): string | null {
  if (querySource === 'compact') return 'repl_main_thread'
  for (const prefix of TRACKED_SOURCE_PREFIXES) {
    if (querySource.startsWith(prefix)) return agentId || querySource
  }
  return null
}

import { useSyncExternalStore } from 'react'

import {
  getProviderRateLimit,
  type ProviderRateLimit,
  subscribeToProviderRateLimit,
} from 'src/providers/rateLimitState.js'

/**
 * The rate limit currently in force, or null. The store hands back the same
 * object reference until something publishes, which is what
 * `useSyncExternalStore` needs to avoid re-rendering on every check.
 */
export function useProviderRateLimit(): ProviderRateLimit | null {
  return useSyncExternalStore(
    subscribeToProviderRateLimit,
    getProviderRateLimit,
    getProviderRateLimit,
  )
}

import { useEffect, useReducer } from 'react'

import { getAPIProvider, type APIProvider } from 'src/providers/model/providers.js'
import { getActiveProviderLabel } from 'src/providers/providerLabel.js'
import {
  getLiveLimits,
  type LiveLimitsReading,
} from 'src/providers/usage/providerLimits.js'

/** The reading, and whose it is: a warning is announced once per provider. */
export type ActiveLiveLimits = LiveLimitsReading & { provider: APIProvider }

/**
 * What the active provider's own responses say about its limits, re-read
 * whenever they change. A provider that reports none reads as nothing; a
 * /provider switch re-subscribes to the new one's source.
 */
export function useLiveLimits(): ActiveLiveLimits {
  const provider = getAPIProvider()
  const live = getLiveLimits(provider)
  const [, rerender] = useReducer((x: number) => x + 1, 0)
  useEffect(() => {
    if (!live) return
    const unsubscribe = live.subscribe(rerender)
    // A change between the render and this subscription has no listener to
    // tell: read once more now that there is one.
    rerender()
    return unsubscribe
  }, [live])
  const reading = live ? live.read(getActiveProviderLabel(), Date.now()) : {}
  return { ...reading, provider }
}

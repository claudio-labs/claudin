import * as React from 'react'
import { useEffect, useRef } from 'react'

import { useLiveLimits } from 'src/providers/liveLimitsHook.js'
import type { APIProvider } from 'src/providers/model/providers.js'
import { useNotifications } from 'src/terminal/contexts/notifications.js'
import { Text } from 'src/terminal/ink.js'

/**
 * Toasts the active provider's usage-limit warnings — `Anthropic · weekly
 * ▰▰▰▰▰▰▰▰▰▱ 92% · resets …`, once per warning — and the start of overage.
 * Only providers that report a limit on their responses have anything to say
 * (usage/providerLimits.ts). The standing reminder in the footer is
 * Notifications.tsx's, from the same reading.
 *
 * The hook it replaced skipped remote mode via getIsRemoteMode(); that flag
 * is initialized false and nothing ever sets it, so the check is gone.
 */
export function useProviderUsageWarning(): void {
  const { addNotification } = useNotifications()
  const { announcement, overage, provider } = useLiveLimits()
  // Per provider: a /provider round trip must not repeat what was said.
  const announcedRef = useRef(new Map<APIProvider, string>())
  const overageShownRef = useRef(false)

  const announcementId = announcement?.id
  const announcementText = announcement?.text
  useEffect(() => {
    if (announcementId === undefined || announcementText === undefined) return
    if (announcedRef.current.get(provider) === announcementId) return
    announcedRef.current.set(provider, announcementId)
    addNotification({
      key: 'rate-limit-warning',
      jsx: <Text color="warning">{announcementText}</Text>,
      priority: 'high',
      // A higher threshold crossed while the last one is still up replaces
      // it, rather than being dropped as a duplicate key.
      fold: (_current, next) => next,
    })
  }, [provider, announcementId, announcementText, addNotification])

  useEffect(() => {
    if (!overage) {
      overageShownRef.current = false
      return
    }
    if (overageShownRef.current) return
    overageShownRef.current = true
    addNotification({ key: 'limit-reached', text: overage, priority: 'immediate' })
  }, [overage, addNotification])
}

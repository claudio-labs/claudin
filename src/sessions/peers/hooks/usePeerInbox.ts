import { useCallback, useEffect, useRef } from 'react'
import { enqueue } from 'src/agent/messageQueueManager.js'
import { getSettingsForSource } from 'src/platform/settings/settings.js'
import {
  updateSessionInbox,
  whenSessionRegistered,
} from 'src/sessions/concurrentSessions.js'
import { registerCleanup } from 'src/shared/cleanupRegistry.js'
import { getIdleSince, onSessionIdle } from 'src/sessions/peers/activity.js'
import { formatUdsAddress } from 'src/sessions/peers/address.js'
import {
  createInboundDelivery,
  type InboundDelivery,
} from 'src/sessions/peers/delivery.js'
import {
  crossSessionUnavailableReason,
  getOwnInbox,
  type PeerInbox,
  startPeerInbox,
} from 'src/sessions/peers/inboxServer.js'
import { resolveInboundSetting } from 'src/sessions/peers/policy.js'
import { readSessionDirectory } from 'src/sessions/peers/registry.js'
import { useSessionActivity } from 'src/sessions/peers/hooks/useSessionActivity.js'
import { logError } from 'src/shared/log.js'
import { useAppStateStore } from 'src/terminal/state/AppState.js'

/**
 * Bind this session's peer inbox once its PID record exists, then advertise
 * it there. Only the REPL mounts this: a headless run can send to other
 * sessions but is never listed as one. Returns how the held-message dialog
 * answers.
 */
export function usePeerInbox({ isLoading }: { isLoading: boolean }): {
  settleHeld: (id: string, decision: 'deliver' | 'deny') => void
} {
  const store = useAppStateStore()
  const deliveryRef = useRef<InboundDelivery | undefined>(undefined)
  const enabled = crossSessionUnavailableReason() === undefined
  useSessionActivity(isLoading, enabled)

  useEffect(() => {
    if (!enabled) return
    let inbox: PeerInbox | undefined
    let unsubscribeIdle: (() => void) | undefined
    let unregisterExit: (() => void) | undefined
    let unmounted = false
    void (async () => {
      if (!(await whenSessionRegistered()) || unmounted) return
      const delivery = createInboundDelivery({
        enqueue,
        readDirectory: () => readSessionDirectory(),
        // Read when each message arrives: the mode can change mid-session.
        permissionMode: () => store.getState().toolPermissionContext.mode,
        inboundSetting: () =>
          resolveInboundSetting(
            source => getSettingsForSource(source)?.crossSessionInbound,
          ),
        ownAddress: () => {
          const own = getOwnInbox()
          return own ? formatUdsAddress(own.socketPath) : undefined
        },
        idleSince: getIdleSince,
      })
      deliveryRef.current = delivery
      unsubscribeIdle = onSessionIdle(idleSince => {
        void delivery.notifyIdle(idleSince).catch(logError)
      })
      unregisterExit = registerCleanup(() => delivery.notifyExit())
      inbox = await startPeerInbox({ handler: delivery.handler })
      if (unmounted) {
        await inbox.close()
        return
      }
      await updateSessionInbox({
        messagingSocketPath: inbox.socketPath,
        messagingToken: inbox.token,
      })
    })().catch(logError)
    return () => {
      unmounted = true
      unsubscribeIdle?.()
      unregisterExit?.()
      if (!inbox) return
      void updateSessionInbox({ messagingSocketPath: null, messagingToken: null })
      void inbox.close()
    }
  }, [store, enabled])

  const settleHeld = useCallback((id: string, decision: 'deliver' | 'deny') => {
    void deliveryRef.current?.settleHeld(id, decision).catch(logError)
  }, [])
  return { settleHeld }
}

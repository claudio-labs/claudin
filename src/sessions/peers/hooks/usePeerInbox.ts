import { useEffect } from 'react'
import { enqueue } from 'src/agent/messageQueueManager.js'
import {
  updateSessionInbox,
  whenSessionRegistered,
} from 'src/sessions/concurrentSessions.js'
import { createInboxHandler } from 'src/sessions/peers/delivery.js'
import {
  crossSessionUnavailableReason,
  type PeerInbox,
  startPeerInbox,
} from 'src/sessions/peers/inboxServer.js'
import { readSessionDirectory } from 'src/sessions/peers/registry.js'
import { logError } from 'src/shared/log.js'

/**
 * Bind this session's peer inbox once its PID record exists, then advertise
 * it there. Only the REPL mounts this: a headless run can send to other
 * sessions but is never listed as one.
 */
export function usePeerInbox(): void {
  useEffect(() => {
    if (crossSessionUnavailableReason()) return
    let inbox: PeerInbox | undefined
    let unmounted = false
    void (async () => {
      if (!(await whenSessionRegistered()) || unmounted) return
      inbox = await startPeerInbox({
        handler: createInboxHandler({
          enqueue,
          readDirectory: () => readSessionDirectory(),
        }),
      })
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
      if (!inbox) return
      void updateSessionInbox({ messagingSocketPath: null, messagingToken: null })
      void inbox.close()
    }
  }, [])
}

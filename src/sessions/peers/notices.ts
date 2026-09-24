/**
 * The harness notices a session gets about its own sends. They are built here
 * from structured fields — a status, a session's directory name — so no text
 * the other session wrote reaches the model through one, and a status is only
 * believed when it answers a send this session is still waiting on.
 */
import { CROSS_SESSION_NOTICE_TAG } from 'src/shared/constants/xml.js'
import { formatXmlEnvelope } from 'src/shared/data/xml.js'
import { HOLD_EXPIRY_MS } from 'src/sessions/peers/heldMessages.js'

// Past the other side's hold expiry, with room for its notice in flight.
const PENDING_HOLD_TTL_MS = HOLD_EXPIRY_MS + 60_000

export type DeliveryStatus = 'delivered' | 'denied' | 'expired'

const pendingHolds = new Map<string, { peerName: string; expiresAt: number }>()

function prune(now: number): void {
  for (const [id, pending] of pendingHolds) {
    if (pending.expiresAt <= now) pendingHolds.delete(id)
  }
}

/** Remember a send the other session held, so its outcome can be announced. */
export function awaitDeliveryStatus(
  msgId: string,
  peerName: string,
  now: number = Date.now(),
): void {
  prune(now)
  pendingHolds.set(msgId, { peerName, expiresAt: now + PENDING_HOLD_TTL_MS })
}

/**
 * The held send a status answers, consumed — undefined for a status that is
 * uncorrelated, already answered or too late.
 */
export function takePendingHold(
  msgId: string,
  now: number = Date.now(),
): { peerName: string } | undefined {
  prune(now)
  const pending = pendingHolds.get(msgId)
  if (!pending) return undefined
  pendingHolds.delete(msgId)
  return { peerName: pending.peerName }
}

const DELIVERY_NOTICES: Record<DeliveryStatus, (peer: string) => string> = {
  delivered: peer =>
    `[Cross-session delivery notice] ${peer}'s user approved your held message; it was delivered to that session's Claude.`,
  denied: peer =>
    `[Cross-session delivery notice] ${peer}'s user declined your message; it was not delivered. Do not resend it — continue, or choose another approach.`,
  expired: peer =>
    `[Cross-session delivery notice] Your message to ${peer} expired waiting for its user's approval and was not delivered.`,
}

export function formatDeliveryNotice(peerName: string, status: DeliveryStatus): string {
  return formatXmlEnvelope(
    CROSS_SESSION_NOTICE_TAG,
    { about: peerName },
    DELIVERY_NOTICES[status](peerName),
  )
}

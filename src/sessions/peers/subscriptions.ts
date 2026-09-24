/**
 * `notify_when_idle` on the receiving side: the sessions that asked to hear,
 * once, when this one next goes idle or exits. A subscription lives at most
 * 12 hours and each sender may hold only a few, so no session can make
 * another keep state for it indefinitely.
 */
export const SUBSCRIPTION_TTL_MS = 12 * 60 * 60_000
export const MAX_SUBSCRIPTIONS = 32
export const MAX_SUBSCRIPTIONS_PER_SENDER = 3

export type IdleSubscription = {
  /** The subscriber's msg_id — what its idle notice answers. */
  id: string
  /** The subscriber's socket, as a live session advertises it. */
  socketPath: string
  createdAt: number
}

let subscriptions: IdleSubscription[] = []

/**
 * Record a subscription. A sender over its share loses its oldest; past the
 * global cap the new one is refused.
 */
export function addIdleSubscription(subscription: IdleSubscription): boolean {
  const fromSender = subscriptions.filter(s => s.socketPath === subscription.socketPath)
  if (fromSender.length >= MAX_SUBSCRIPTIONS_PER_SENDER) {
    const oldest = fromSender[0]!
    subscriptions = subscriptions.filter(s => s !== oldest)
  }
  if (subscriptions.length >= MAX_SUBSCRIPTIONS) return false
  subscriptions.push(subscription)
  return true
}

/**
 * The subscriptions an idle stretch that began at `idleSince` answers,
 * removed — each fires once. One made after the session went idle waits for
 * the next stretch: the turn it asked about has not run yet.
 */
export function takeIdleSubscriptions(idleSince: number): IdleSubscription[] {
  const taken = subscriptions.filter(s => s.createdAt < idleSince)
  subscriptions = subscriptions.filter(s => s.createdAt >= idleSince)
  return taken
}

/** Every subscription, removed — the session is exiting. */
export function takeAllIdleSubscriptions(): IdleSubscription[] {
  const taken = subscriptions
  subscriptions = []
  return taken
}

/** Remove one subscription; undefined when it already fired or was dropped. */
export function takeIdleSubscription(id: string): IdleSubscription | undefined {
  const subscription = subscriptions.find(s => s.id === id)
  if (subscription) subscriptions = subscriptions.filter(s => s !== subscription)
  return subscription
}

export function resetIdleSubscriptionsForTests(): void {
  subscriptions = []
}

/**
 * The sender's side: subscriptions this session made and is waiting to hear
 * back on. An idle notice is only believed for one of these.
 */
const awaited = new Map<string, { peerName: string; expiresAt: number }>()

export function awaitIdleNotice(
  msgId: string,
  peerName: string,
  now: number = Date.now(),
): void {
  for (const [id, entry] of awaited) if (entry.expiresAt <= now) awaited.delete(id)
  awaited.set(msgId, { peerName, expiresAt: now + SUBSCRIPTION_TTL_MS })
}

export function takeAwaitedIdleNotice(
  msgId: string,
  now: number = Date.now(),
): { peerName: string } | undefined {
  const entry = awaited.get(msgId)
  if (!entry) return undefined
  awaited.delete(msgId)
  return entry.expiresAt > now ? { peerName: entry.peerName } : undefined
}

/**
 * The `subscriptions/listen` stream of a 2026-07-28 connection, which carries
 * the change notifications a 2025 server sends unasked. The SDK dispatches
 * what arrives on it to the client's notification handlers, so the
 * `notifications/{tools,prompts,resources}/list_changed` handlers
 * useManageMCPConnections registers fire in both eras.
 *
 * The filter asks for the list_changed flags the server advertises, plus the
 * resource URIs set with setResourceSubscriptions; a new set of URIs reopens
 * the stream with the whole filter. What the server agreed to (honoredFilter)
 * is compared with what was asked, and the difference logged.
 *
 * The SDK never reopens a stream. A stream the server or the network ended
 * (`closed === 'remote'`), or a listen that failed, is reopened after 1 s,
 * then 2, 4 … up to 30 s; the delay starts over once a stream has stayed open
 * for 30 s. A stream the server ended deliberately (`'graceful'`), one closed
 * here (`'local'`) or a closed connection ends it for good.
 * Closing it posts `notifications/cancelled`, which the SDK waits on for up
 * to the 60 s request timeout; stop() gives it 1 s, so the cleanup of a
 * server that stopped answering, and the reconnect behind it, are not held.
 *
 * The resource URIs themselves are kept here per client, for both eras
 * (subscribeResourceUpdates): at most 50, the oldest dropped first. A 2025
 * connection subscribes each one with `resources/subscribe` and unsubscribes
 * the one it drops; a 2026 one reopens the stream with the whole set, since a
 * subscription cannot be amended. Nothing is unsubscribed at cleanup beyond
 * what closing the connection does, and the set goes with it; the next
 * connection to the server is handed the URIs read before it in one call
 * (resumeMcpResourceWatches in resourceWatch.ts).
 */
import type {
  Client,
  McpSubscription,
  ServerCapabilities,
  SubscriptionFilter,
} from '@modelcontextprotocol/client'
import { errorMessage } from 'src/shared/errors.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'

export type ListenClient = Pick<Client, 'listen' | 'getProtocolEra' | 'getServerCapabilities' | 'transport'>

export type SubscriptionTimings = {
  baseDelayMs: number
  maxDelayMs: number
  /** How long a stream stays open before its reopen delay starts over. */
  stableMs: number
}

export const DEFAULT_SUBSCRIPTION_TIMINGS: SubscriptionTimings = {
  baseDelayMs: 1000,
  maxDelayMs: 30_000,
  stableMs: 30_000,
}

const STOP_CLOSE_TIMEOUT_MS = 1000

export function listenFilter(
  capabilities: ServerCapabilities | undefined,
  resourceUris: readonly string[],
): SubscriptionFilter {
  return {
    ...(capabilities?.tools?.listChanged && { toolsListChanged: true }),
    ...(capabilities?.prompts?.listChanged && { promptsListChanged: true }),
    ...(capabilities?.resources?.listChanged && { resourcesListChanged: true }),
    ...(resourceUris.length > 0 && { resourceSubscriptions: [...resourceUris] }),
  }
}

export function isEmptyFilter(filter: SubscriptionFilter): boolean {
  return Object.keys(filter).length === 0
}

const FLAG_KEYS = ['toolsListChanged', 'promptsListChanged', 'resourcesListChanged'] as const

/** What was asked for and not honored: flag names, and resource URIs. */
export function unhonored(asked: SubscriptionFilter, honored: SubscriptionFilter): string[] {
  const missing: string[] = FLAG_KEYS.filter(key => asked[key] === true && honored[key] !== true)
  const honoredUris = new Set(honored.resourceSubscriptions ?? [])
  for (const uri of asked.resourceSubscriptions ?? []) {
    if (!honoredUris.has(uri)) missing.push(uri)
  }
  return missing
}

export function reopenDelayMs(attempt: number, timings: SubscriptionTimings): number {
  return Math.min(timings.maxDelayMs, timings.baseDelayMs * 2 ** attempt)
}

export type McpSubscriptions = {
  /** The URIs whose `notifications/resources/updated` the stream carries; reopens it. */
  setResourceSubscriptions(uris: readonly string[]): void
  /** Closes the stream and stops reopening it. */
  stop(): Promise<void>
}

class ListenLoop implements McpSubscriptions {
  private stopped = false
  private generation = 0
  private attempt = 0
  private current: McpSubscription | undefined
  private timer: ReturnType<typeof setTimeout> | undefined
  private resourceUris: readonly string[] = []

  constructor(
    private readonly name: string,
    private readonly client: ListenClient,
    private readonly timings: SubscriptionTimings,
    private readonly now: () => number,
  ) {}

  open(): void {
    if (this.stopped) return
    const filter = listenFilter(this.client.getServerCapabilities(), this.resourceUris)
    if (isEmptyFilter(filter)) return
    const generation = ++this.generation
    void this.run(generation, filter)
  }

  private superseded(generation: number): boolean {
    return this.stopped || generation !== this.generation
  }

  private async run(generation: number, filter: SubscriptionFilter): Promise<void> {
    let subscription: McpSubscription
    try {
      subscription = await this.client.listen(filter)
    } catch (error) {
      if (this.superseded(generation)) return
      logMCPError(this.name, `subscriptions/listen failed: ${errorMessage(error)}`)
      this.scheduleReopen(generation)
      return
    }
    if (this.superseded(generation)) {
      await this.close(subscription)
      return
    }
    this.current = subscription
    const missing = unhonored(filter, subscription.honoredFilter)
    if (missing.length > 0) {
      logMCPDebug(this.name, `subscriptions/listen: the server does not honor ${missing.join(', ')}`)
    }
    const openedAt = this.now()
    const reason = await subscription.closed
    if (this.superseded(generation)) return
    this.current = undefined
    if (reason !== 'remote') {
      logMCPDebug(this.name, `subscriptions/listen ended (${reason})`)
      return
    }
    if (this.now() - openedAt >= this.timings.stableMs) this.attempt = 0
    logMCPDebug(this.name, 'subscriptions/listen stream dropped; reopening')
    this.scheduleReopen(generation)
  }

  private scheduleReopen(generation: number): void {
    // A closed connection has no transport; listening again cannot work.
    if (this.client.transport === undefined) return
    const delay = reopenDelayMs(this.attempt++, this.timings)
    this.timer = setTimeout(() => {
      this.timer = undefined
      if (!this.superseded(generation)) this.open()
    }, delay)
    this.timer.unref?.()
  }

  setResourceSubscriptions(uris: readonly string[]): void {
    this.resourceUris = [...uris]
    const previous = this.current
    this.current = undefined
    clearTimeout(this.timer)
    this.open()
    if (previous) void this.close(previous)
  }

  async stop(): Promise<void> {
    this.stopped = true
    clearTimeout(this.timer)
    const previous = this.current
    this.current = undefined
    if (previous) await this.closeWithin(previous, STOP_CLOSE_TIMEOUT_MS)
  }

  private async closeWithin(subscription: McpSubscription, ms: number): Promise<void> {
    let timer: ReturnType<typeof setTimeout> | undefined
    const timedOut = new Promise<true>(resolve => {
      timer = setTimeout(() => resolve(true), ms)
      timer.unref?.()
    })
    const late = await Promise.race([this.close(subscription).then(() => false), timedOut])
    clearTimeout(timer)
    if (late) logMCPDebug(this.name, `The listen stream's cancel got no answer in ${ms}ms; closing without it`)
  }

  private async close(subscription: McpSubscription): Promise<void> {
    try {
      await subscription.close()
    } catch (error) {
      logMCPDebug(this.name, `Error closing the listen stream: ${errorMessage(error)}`)
    }
  }
}

const loops = new WeakMap<ListenClient, ListenLoop>()

/**
 * Opens the listen stream of a modern connection, once per client; a 2025
 * connection gets its notifications unasked, and this does nothing.
 */
export function startMcpSubscriptions(
  name: string,
  client: ListenClient,
  options: { timings?: SubscriptionTimings; now?: () => number } = {},
): McpSubscriptions | undefined {
  if (client.getProtocolEra() !== 'modern') return undefined
  const existing = loops.get(client)
  if (existing) return existing
  const loop = new ListenLoop(name, client, options.timings ?? DEFAULT_SUBSCRIPTION_TIMINGS, options.now ?? Date.now)
  loops.set(client, loop)
  loop.open()
  return loop
}

export function getMcpSubscriptions(client: ListenClient): McpSubscriptions | undefined {
  return loops.get(client)
}

export async function stopMcpSubscriptions(client: ListenClient): Promise<void> {
  resourceSubscriptions.delete(client)
  const loop = loops.get(client)
  if (!loop) return
  loops.delete(client)
  await loop.stop()
}

/** Resource URIs one connection is subscribed to; the oldest goes first past this. */
export const MAX_RESOURCE_SUBSCRIPTIONS = 50

export type ResourceUriSet = {
  uris: string[]
  added: boolean
  /** The URIs dropped to make room, oldest first. */
  evicted: string[]
}

/** The set after subscribing `uri`: unchanged when already in it, oldest dropped past `max`. */
export function addResourceUri(
  uris: readonly string[],
  uri: string,
  max: number = MAX_RESOURCE_SUBSCRIPTIONS,
): ResourceUriSet {
  if (uris.includes(uri)) return { uris: [...uris], added: false, evicted: [] }
  const next = [...uris, uri]
  const evicted = next.splice(0, Math.max(0, next.length - max))
  return { uris: next, added: true, evicted }
}

export type ResourceSubscribeClient = ListenClient &
  Pick<Client, 'subscribeResource' | 'unsubscribeResource' | 'setNotificationHandler'>

export function canSubscribeResources(client: Pick<Client, 'getServerCapabilities'>): boolean {
  return client.getServerCapabilities()?.resources?.subscribe === true
}

const resourceSubscriptions = new WeakMap<ListenClient, string[]>()

/** The URIs this connection is subscribed to, oldest first. */
export function getResourceSubscriptions(client: ListenClient): readonly string[] {
  return resourceSubscriptions.get(client) ?? []
}

/**
 * Subscribes the connection to the `notifications/resources/updated` of `uri`
 * (or of each URI, in order, with one reopened stream on 2026-07-28), which
 * reach `onUpdated`; the handler is set on the first subscription and stays
 * for the client's life. Resolves to the URIs dropped to stay under the cap,
 * or undefined when the server does not offer subscriptions or the
 * connection is closed — then nothing is sent. The set changes before the
 * first await, so concurrent reads each see the other's URI.
 */
export async function subscribeResourceUpdates(
  name: string,
  client: ResourceSubscribeClient,
  uri: string | readonly string[],
  onUpdated: (uri: string) => void,
): Promise<string[] | undefined> {
  if (!canSubscribeResources(client) || client.transport === undefined) return undefined
  const current = resourceSubscriptions.get(client)
  if (current === undefined) {
    client.setNotificationHandler('notifications/resources/updated', async notification => {
      onUpdated(notification.params.uri)
    })
  }
  let uris = current ?? []
  const added: string[] = []
  const evicted: string[] = []
  for (const each of typeof uri === 'string' ? [uri] : uri) {
    const next = addResourceUri(uris, each)
    uris = next.uris
    if (next.added) added.push(each)
    evicted.push(...next.evicted)
  }
  resourceSubscriptions.set(client, uris)
  if (added.length === 0) return []

  if (client.getProtocolEra() === 'modern') {
    const loop = getMcpSubscriptions(client) ?? startMcpSubscriptions(name, client)
    loop?.setResourceSubscriptions(uris)
    return evicted
  }

  // A URI a longer call added and then dropped again was never subscribed.
  for (const each of added.filter(u => uris.includes(u))) {
    try {
      await client.subscribeResource({ uri: each })
    } catch (error) {
      const now = resourceSubscriptions.get(client)
      if (now) resourceSubscriptions.set(client, now.filter(u => u !== each))
      logMCPError(name, `resources/subscribe ${each} failed: ${errorMessage(error)}`)
    }
  }
  for (const old of evicted.filter(u => !added.includes(u))) {
    try {
      await client.unsubscribeResource({ uri: old })
    } catch (error) {
      logMCPDebug(name, `resources/unsubscribe ${old} failed: ${errorMessage(error)}`)
    }
  }
  return evicted
}

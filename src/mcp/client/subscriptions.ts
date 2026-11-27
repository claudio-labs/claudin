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
    if (previous) await this.close(previous)
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
  const loop = loops.get(client)
  if (!loop) return
  loops.delete(client)
  await loop.stop()
}

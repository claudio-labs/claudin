// The resource half of subscriptions.ts: the per-connection URI set, capped
// at 50, and how each era subscribes to it. Against hand-made clients; the
// real servers of both eras are in src/mcp/resourceWatch.test.ts.
import { afterEach, describe, expect, test } from 'bun:test'
import type { McpSubscription, SubscriptionFilter } from '@modelcontextprotocol/client'
import {
  addResourceUri,
  canSubscribeResources,
  getMcpSubscriptions,
  getResourceSubscriptions,
  MAX_RESOURCE_SUBSCRIPTIONS,
  type ResourceSubscribeClient,
  startMcpSubscriptions,
  stopMcpSubscriptions,
  subscribeResourceUpdates,
} from 'src/mcp/client/subscriptions.js'

const uriN = (n: number) => `file:///r${n}`

describe('addResourceUri', () => {
  test('appends a new URI, and leaves the set alone for one it holds', () => {
    expect(addResourceUri([], 'a')).toEqual({ uris: ['a'], added: true, evicted: [] })
    expect(addResourceUri(['a', 'b'], 'a')).toEqual({ uris: ['a', 'b'], added: false, evicted: [] })
  })

  test('past the cap the oldest goes first', () => {
    const fifty = Array.from({ length: MAX_RESOURCE_SUBSCRIPTIONS }, (_, i) => uriN(i))
    const next = addResourceUri(fifty, uriN(50))
    expect(next.evicted).toEqual([uriN(0)])
    expect(next.uris).toHaveLength(50)
    expect(next.uris[0]).toBe(uriN(1))
    expect(next.uris.at(-1)).toBe(uriN(50))
    expect(addResourceUri(['a', 'b', 'c'], 'd', 2)).toEqual({ uris: ['c', 'd'], added: true, evicted: ['a', 'b'] })
  })
})

type Handler = (notification: { params: { uri: string } }) => Promise<void>

function fakeClient(options: {
  era?: 'modern' | 'legacy'
  subscribe?: boolean
  listChanged?: boolean
  failSubscribe?: (uri: string) => boolean
  failUnsubscribe?: boolean
} = {}) {
  const calls: string[] = []
  const handlers = new Map<string, Handler>()
  const filters: SubscriptionFilter[] = []
  let transport: object | undefined = {}
  const client = {
    getProtocolEra: () => options.era ?? 'legacy',
    getServerCapabilities: () => ({
      resources: { ...(options.subscribe !== false && { subscribe: true }) },
      ...(options.listChanged && { tools: { listChanged: true } }),
    }),
    get transport() {
      return transport
    },
    setNotificationHandler: (method: string, handler: Handler) => {
      calls.push(`handler ${method}`)
      handlers.set(method, handler)
    },
    subscribeResource: async ({ uri }: { uri: string }) => {
      calls.push(`subscribe ${uri}`)
      if (options.failSubscribe?.(uri)) throw new Error('subscribe refused')
      return {}
    },
    unsubscribeResource: async ({ uri }: { uri: string }) => {
      calls.push(`unsubscribe ${uri}`)
      if (options.failUnsubscribe) throw new Error('unsubscribe refused')
      return {}
    },
    listen: async (filter: SubscriptionFilter): Promise<McpSubscription> => {
      filters.push(filter)
      let end!: (reason: 'local') => void
      const closed = new Promise<'local'>(resolve => (end = resolve))
      return { honoredFilter: filter, closed, close: async () => end('local') }
    },
  } as unknown as ResourceSubscribeClient
  return {
    client,
    calls,
    filters,
    notify: (uri: string) => handlers.get('notifications/resources/updated')!({ params: { uri } }),
    close: () => {
      transport = undefined
    },
  }
}

const fakes: ReturnType<typeof fakeClient>[] = []
function make(options: Parameters<typeof fakeClient>[0] = {}) {
  const fake = fakeClient(options)
  fakes.push(fake)
  return fake
}

afterEach(async () => {
  for (const fake of fakes.splice(0)) await stopMcpSubscriptions(fake.client)
})

describe('canSubscribeResources', () => {
  test('only a server that offers resources.subscribe', () => {
    expect(canSubscribeResources(make().client)).toBe(true)
    expect(canSubscribeResources(make({ subscribe: false }).client)).toBe(false)
    expect(canSubscribeResources({ getServerCapabilities: () => undefined })).toBe(false)
  })
})

describe('subscribeResourceUpdates', () => {
  test('a server without resources.subscribe gets no call and no handler', async () => {
    const fake = make({ subscribe: false })
    expect(await subscribeResourceUpdates('srv', fake.client, 'file:///a', () => {})).toBeUndefined()
    expect(fake.calls).toEqual([])
    expect(getResourceSubscriptions(fake.client)).toEqual([])
  })

  test('a closed connection gets nothing either', async () => {
    const fake = make()
    fake.close()
    expect(await subscribeResourceUpdates('srv', fake.client, 'file:///a', () => {})).toBeUndefined()
    expect(fake.calls).toEqual([])
  })

  test('2025: one resources/subscribe per new URI, one handler, and the updates reach it', async () => {
    const fake = make()
    const updated: string[] = []
    expect(await subscribeResourceUpdates('srv', fake.client, 'file:///a', uri => updated.push(uri))).toEqual([])
    expect(await subscribeResourceUpdates('srv', fake.client, 'file:///b', () => {})).toEqual([])
    expect(await subscribeResourceUpdates('srv', fake.client, 'file:///a', () => {})).toEqual([])
    expect(fake.calls).toEqual([
      'handler notifications/resources/updated',
      'subscribe file:///a',
      'subscribe file:///b',
    ])
    await fake.notify('file:///b')
    expect(updated).toEqual(['file:///b'])
    expect(getResourceSubscriptions(fake.client)).toEqual(['file:///a', 'file:///b'])
  })

  test('2025: the 51st URI unsubscribes the first', async () => {
    const fake = make()
    for (let i = 0; i < 50; i++) await subscribeResourceUpdates('srv', fake.client, uriN(i), () => {})
    expect(await subscribeResourceUpdates('srv', fake.client, uriN(50), () => {})).toEqual([uriN(0)])
    expect(fake.calls.slice(-2)).toEqual([`subscribe ${uriN(50)}`, `unsubscribe ${uriN(0)}`])
    expect(getResourceSubscriptions(fake.client)).toHaveLength(50)
    expect(getResourceSubscriptions(fake.client)).not.toContain(uriN(0))
  })

  test('2025: a refused subscribe leaves the URI out, and a refused unsubscribe does not stop the rest', async () => {
    const fake = make({ failSubscribe: uri => uri === 'file:///bad', failUnsubscribe: true })
    expect(await subscribeResourceUpdates('srv', fake.client, 'file:///bad', () => {})).toEqual([])
    expect(getResourceSubscriptions(fake.client)).toEqual([])

    for (let i = 0; i < 52; i++) await subscribeResourceUpdates('srv', fake.client, uriN(i), () => {})
    expect(fake.calls.filter(c => c.startsWith('unsubscribe'))).toEqual([`unsubscribe ${uriN(0)}`, `unsubscribe ${uriN(1)}`])
    expect(getResourceSubscriptions(fake.client)[0]).toBe(uriN(2))
  })

  test('2025: concurrent reads each keep the other URI', async () => {
    const fake = make()
    await Promise.all([
      subscribeResourceUpdates('srv', fake.client, 'file:///a', () => {}),
      subscribeResourceUpdates('srv', fake.client, 'file:///b', () => {}),
    ])
    expect(getResourceSubscriptions(fake.client)).toEqual(['file:///a', 'file:///b'])
  })

  test('2026: the stream reopens with the whole set, never resources/subscribe', async () => {
    const fake = make({ era: 'modern', listChanged: true })
    startMcpSubscriptions('srv', fake.client)
    await subscribeResourceUpdates('srv', fake.client, 'file:///a', () => {})
    await subscribeResourceUpdates('srv', fake.client, 'file:///b', () => {})
    await subscribeResourceUpdates('srv', fake.client, 'file:///a', () => {})
    await Bun.sleep(0)
    expect(fake.filters).toEqual([
      { toolsListChanged: true },
      { toolsListChanged: true, resourceSubscriptions: ['file:///a'] },
      { toolsListChanged: true, resourceSubscriptions: ['file:///a', 'file:///b'] },
    ])
    expect(fake.calls).toEqual(['handler notifications/resources/updated'])
  })

  test('2026: the 51st URI leaves the first out of the next filter', async () => {
    const fake = make({ era: 'modern' })
    for (let i = 0; i < 50; i++) await subscribeResourceUpdates('srv', fake.client, uriN(i), () => {})
    expect(await subscribeResourceUpdates('srv', fake.client, uriN(50), () => {})).toEqual([uriN(0)])
    await Bun.sleep(0)
    const last = fake.filters.at(-1)!.resourceSubscriptions!
    expect(last).toHaveLength(50)
    expect(last[0]).toBe(uriN(1))
    expect(last).not.toContain(uriN(0))
  })

  test('2026: a connection whose stream was never started gets one', async () => {
    const fake = make({ era: 'modern' })
    expect(getMcpSubscriptions(fake.client)).toBeUndefined()
    await subscribeResourceUpdates('srv', fake.client, 'file:///a', () => {})
    expect(getMcpSubscriptions(fake.client)).toBeDefined()
    await Bun.sleep(0)
    expect(fake.filters).toEqual([{ resourceSubscriptions: ['file:///a'] }])
  })

  test('the set goes with the connection', async () => {
    const fake = make()
    await subscribeResourceUpdates('srv', fake.client, 'file:///a', () => {})
    await stopMcpSubscriptions(fake.client)
    expect(getResourceSubscriptions(fake.client)).toEqual([])
  })
})

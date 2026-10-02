import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import {
  _fireNowForTesting,
  _getPingsForTesting,
  _isArmedForTesting,
  _resetKeepAliveForTesting,
  armKeepAlive,
  cancelAllKeepAlives,
  cancelKeepAlive,
  noteRequestStarted,
  type KeepAliveClient,
  type KeepAliveRequest,
} from 'src/agent/cache/anthropic/keepAlive.js'

const priorFlag = process.env.CLAUDIN_CACHE_KEEPALIVE
const priorMax = process.env.CLAUDIN_CACHE_KEEPALIVE_MAX_MIN

type Sent = { body: Record<string, unknown> }

function fakeClient(opts: { fail?: boolean } = {}): { client: KeepAliveClient; sent: Sent[] } {
  const sent: Sent[] = []
  const client: KeepAliveClient = {
    beta: {
      messages: {
        async create(body: never) {
          sent.push({ body: body as Record<string, unknown> })
          if (opts.fail) throw new Error('400 max_tokens')
          return { usage: { input_tokens: 2, cache_read_input_tokens: 50_000, cache_creation_input_tokens: 0, output_tokens: 1 } }
        },
      },
    },
  }
  return { client, sent }
}

function req(key: string, client: KeepAliveClient, shortTtl = true): KeepAliveRequest {
  return {
    key,
    client,
    params: { model: 'claude-sonnet-5', messages: [{ role: 'user', content: 'hi' }], max_tokens: 4096, thinking: { type: 'adaptive' } },
    model: 'claude-sonnet-5',
    shortTtl,
  }
}

beforeEach(() => {
  process.env.CLAUDIN_CACHE_KEEPALIVE = '1'
  delete process.env.CLAUDIN_CACHE_KEEPALIVE_MAX_MIN
  _resetKeepAliveForTesting()
})

afterEach(() => {
  cancelAllKeepAlives()
  if (priorFlag === undefined) delete process.env.CLAUDIN_CACHE_KEEPALIVE
  else process.env.CLAUDIN_CACHE_KEEPALIVE = priorFlag
  if (priorMax === undefined) delete process.env.CLAUDIN_CACHE_KEEPALIVE_MAX_MIN
  else process.env.CLAUDIN_CACHE_KEEPALIVE_MAX_MIN = priorMax
})

describe('cache keep-alive', () => {
  test('a ping re-sends the same body, non-streaming, with max_tokens at the floor', async () => {
    const { client, sent } = fakeClient()
    noteRequestStarted('a')
    armKeepAlive(req('a', client))
    await _fireNowForTesting('a')
    expect(sent).toHaveLength(1)
    const body = sent[0]!.body
    expect(body.stream).toBe(false)
    expect(body.max_tokens).toBe(1)
    // Everything that keys the cache is untouched — thinking included.
    expect(body.thinking).toEqual({ type: 'adaptive' })
    expect(body.messages).toEqual([{ role: 'user', content: 'hi' }])
    expect(_getPingsForTesting()[0]?.usage?.cache_read_input_tokens).toBe(50_000)
  })

  test('a real request in between makes the armed ping stale', async () => {
    const { client, sent } = fakeClient()
    noteRequestStarted('b')
    armKeepAlive(req('b', client))
    // The next request starts: the chain is cancelled and firing does nothing.
    noteRequestStarted('b')
    await _fireNowForTesting('b')
    expect(sent).toHaveLength(0)
  })

  test('only the 5m tier is pinged, and only under the flag', async () => {
    const { client, sent } = fakeClient()
    armKeepAlive(req('c', client, false))
    await _fireNowForTesting('c')
    expect(sent).toHaveLength(0)

    delete process.env.CLAUDIN_CACHE_KEEPALIVE
    armKeepAlive(req('d', client, true))
    await _fireNowForTesting('d')
    expect(sent).toHaveLength(0)
  })

  test('a failed ping stops the chain instead of looping', async () => {
    const { client, sent } = fakeClient({ fail: true })
    noteRequestStarted('e')
    armKeepAlive(req('e', client))
    await _fireNowForTesting('e')
    expect(sent).toHaveLength(1)
    expect(_getPingsForTesting()[0]?.error).toContain('400')
    // Nothing re-armed: a second fire finds no chain.
    await _fireNowForTesting('e')
    expect(sent).toHaveLength(1)
  })

  test('a successful ping re-arms, and the chain stops past its ceiling', async () => {
    const { client, sent } = fakeClient()
    noteRequestStarted('f')
    armKeepAlive(req('f', client))
    await _fireNowForTesting('f')
    await _fireNowForTesting('f')
    expect(sent).toHaveLength(2)

    // Armed 31 minutes "ago": the ceiling (default 30) refuses the ping.
    _resetKeepAliveForTesting()
    noteRequestStarted('g')
    armKeepAlive(req('g', client), Date.now() - 31 * 60 * 1000)
    const before = sent.length
    await _fireNowForTesting('g')
    expect(sent).toHaveLength(before)
  })

  test('a cancelled key stops for good, and only that key', async () => {
    const { client, sent } = fakeClient()
    noteRequestStarted('agent-done')
    armKeepAlive(req('agent-done', client))
    noteRequestStarted('main')
    armKeepAlive(req('main', client))
    cancelKeepAlive('agent-done')
    // The chain and the body it holds are released now, not at the next tick.
    expect(_isArmedForTesting('agent-done')).toBe(false)
    expect(_isArmedForTesting('main')).toBe(true)
    await _fireNowForTesting('agent-done')
    await _fireNowForTesting('main')
    expect(sent).toHaveLength(1)
  })

  // The three call sites sit on paths a unit test cannot drive (a streamed
  // request, an agent's teardown, /clear); the wiring is pinned on the source.
  test('only agentic requests arm, and a finished agent or /clear cancels', async () => {
    const { readFileSync } = await import('fs')
    const read = (path: string) => readFileSync(`${import.meta.dir}/../../../../${path}`, 'utf8')
    expect(read('src/providers/shims/claude/streaming.ts')).toContain(
      'if (isCacheKeepAliveEnabled() && isAgenticQuery) {',
    )
    expect(read('src/tools/AgentTool/runAgent.ts')).toContain('cancelKeepAlive(agentId)')
    expect(read('src/commands/clear/caches.ts')).toContain("cancelKeepAlive('main')")
  })
})

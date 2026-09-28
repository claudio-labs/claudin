import { describe, expect, test } from 'bun:test'
import { ttlCensus, type TtlRequest } from './ttl-census.ts'

const cc = (ttl?: '1h') => ({ cache_control: { type: 'ephemeral', ...(ttl ? { ttl } : {}) } })

function loop(system: string, ttl: '1h' | undefined, usage: Record<string, unknown>): TtlRequest {
  return {
    body: {
      system: [{ type: 'text', text: system, ...cc(ttl) }],
      tools: [{ name: 'Read' }, { name: 'Bash', ...cc(ttl) }],
      max_tokens: 32_000,
      messages: [{ role: 'user', content: [{ type: 'text', text: 'go', ...cc(ttl) }] }],
    },
    usage,
  }
}

describe('ttlCensus', () => {
  const requests: TtlRequest[] = [
    loop('MAIN', '1h', { cache_read_input_tokens: 100, cache_creation: { ephemeral_1h_input_tokens: 50 } }),
    loop('AGENT', undefined, { cache_read_input_tokens: 10, cache_creation: { ephemeral_5m_input_tokens: 30 } }),
    loop('OTHER AGENT', undefined, { cache_creation: { ephemeral_5m_input_tokens: 5 } }),
    loop('MAIN', '1h', { cache_read_input_tokens: 150 }),
    { body: { system: 'summarize', tools: [], max_tokens: 500, messages: [] }, usage: null },
    { body: { ...loop('AGENT', undefined, {}).body, max_tokens: 1 }, usage: { cache_read_input_tokens: 40 } },
  ]
  const census = ttlCensus(requests)

  test('the first agent-loop system is the main thread; any other is a sub-agent', () => {
    expect(census.main).toMatchObject({ requests: 2, systems: 1, read: 250, write1h: 50, write5m: 0 })
    expect(census['sub-agent']).toMatchObject({ requests: 2, systems: 2, read: 10, write5m: 35 })
  })

  test('markers are counted where they sit, a marker without ttl being 5m', () => {
    expect(census.main.markers).toEqual({
      system: { '5m': 0, '1h': 2 },
      tools: { '5m': 0, '1h': 2 },
      messages: { '5m': 0, '1h': 2 },
    })
    expect(census['sub-agent'].markers.messages).toEqual({ '5m': 2, '1h': 0 })
  })

  test('a one-token body is a ping, a tool-less one a side query', () => {
    expect(census.ping).toMatchObject({ requests: 1, read: 40 })
    expect(census.side.requests).toBe(1)
  })
})

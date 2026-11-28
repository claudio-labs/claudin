import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  COMPAT_WIRES,
  resolveCompatWire,
  type CompatWireRow,
} from 'src/providers/presets/compatWires.js'
import {
  _resetWireFallbackForTesting,
  isWireRejected,
  noteWireSuccess,
  rejectWireOnFailure,
} from 'src/providers/presets/wireFallback.js'

const ENVS = ['CLAUDIN_OPENAI_RESPONSES', 'CLAUDIN_VENDOR_ANTHROPIC_WIRE'] as const
const saved = Object.fromEntries(ENVS.map(name => [name, process.env[name]]))

beforeEach(() => {
  for (const name of ENVS) delete process.env[name]
  _resetWireFallbackForTesting()
})

afterEach(() => {
  for (const name of ENVS) {
    if (saved[name] === undefined) delete process.env[name]
    else process.env[name] = saved[name]
  }
  _resetWireFallbackForTesting()
})

const ROWS: CompatWireRow[] = [
  { id: 'openai', wire: 'responses', host: 'api.openai.com', models: /^gpt-5/, verified: true },
  { id: 'azure', wire: 'responses', host: /\.openai\.azure\.com$/, path: '/openai/v1', models: /^gpt-5/, verified: true },
  { id: 'xai', wire: 'responses', host: 'api.x.ai', models: /^grok-4/, verified: false },
  {
    id: 'minimax',
    wire: 'anthropic',
    host: 'api.minimax.io',
    models: /^minimax-m/,
    verified: true,
    anthropicBaseUrl: 'https://api.minimax.io/anthropic',
  },
  { id: 'no-url', wire: 'anthropic', host: 'broken.example', models: /./, verified: true },
]

describe('resolveCompatWire', () => {
  test('the shipped table: unique ids, every anthropic row has its base URL, an unknown host is chat', () => {
    expect(new Set(COMPAT_WIRES.map(row => row.id)).size).toBe(COMPAT_WIRES.length)
    for (const row of COMPAT_WIRES.filter(r => r.wire === 'anthropic')) {
      expect(row.anthropicBaseUrl).toMatch(/^https:\/\//)
    }
    expect(resolveCompatWire('https://llm.example.com/v1', 'anything')).toEqual({ wire: 'chat' })
  })

  test('host and model pick the row; the model is matched lowercased', () => {
    expect(resolveCompatWire('https://api.openai.com/v1', 'GPT-5.5', ROWS).wire).toBe('responses')
    expect(resolveCompatWire('https://api.openai.com/v1', 'gpt-4.1', ROWS).wire).toBe('chat')
    expect(resolveCompatWire('https://API.OpenAI.com/v1/', 'gpt-5.5', ROWS)).toMatchObject({ wire: 'responses', row: { id: 'openai' } })
  })

  test('a lookalike host or a missing path prefix is not the row', () => {
    expect(resolveCompatWire('https://api.openai.com.evil.example/v1', 'gpt-5.5', ROWS).wire).toBe('chat')
    expect(resolveCompatWire('https://res.openai.azure.com/openai/v1', 'gpt-5.5', ROWS)).toMatchObject({ row: { id: 'azure' } })
    expect(resolveCompatWire('https://res.openai.azure.com/openai/deployments/x', 'gpt-5.5', ROWS).wire).toBe('chat')
  })

  test('an anthropic row hands over the vendor base URL; one without it is skipped', () => {
    expect(resolveCompatWire('https://api.minimax.io/v1', 'MiniMax-M3', ROWS)).toEqual({
      wire: 'anthropic',
      row: ROWS[3]!,
      baseUrl: 'https://api.minimax.io/anthropic',
    })
    expect(resolveCompatWire('https://broken.example/v1', 'm', ROWS).wire).toBe('chat')
  })

  test('an unverified row needs "all"; "0" turns its kind off, and only its kind', () => {
    expect(resolveCompatWire('https://api.x.ai/v1', 'grok-4.2', ROWS).wire).toBe('chat')
    process.env.CLAUDIN_OPENAI_RESPONSES = 'all'
    expect(resolveCompatWire('https://api.x.ai/v1', 'grok-4.2', ROWS).wire).toBe('responses')
    process.env.CLAUDIN_OPENAI_RESPONSES = '0'
    expect(resolveCompatWire('https://api.openai.com/v1', 'gpt-5.5', ROWS).wire).toBe('chat')
    expect(resolveCompatWire('https://api.minimax.io/v1', 'minimax-m3', ROWS).wire).toBe('anthropic')
    process.env.CLAUDIN_VENDOR_ANTHROPIC_WIRE = 'false'
    expect(resolveCompatWire('https://api.minimax.io/v1', 'minimax-m3', ROWS).wire).toBe('chat')
  })

  test('no base URL, or one that does not parse: chat', () => {
    expect(resolveCompatWire(undefined, 'gpt-5.5', ROWS).wire).toBe('chat')
    expect(resolveCompatWire('not a url', 'gpt-5.5', ROWS).wire).toBe('chat')
  })

  test('a pair rejected on its first request goes back to chat; the other models stay', () => {
    expect(rejectWireOnFailure('responses', 'https://api.openai.com/v1', 'gpt-5.5', { status: 404, body: '{}' })).toBe(true)
    expect(resolveCompatWire('https://api.openai.com/v1', 'gpt-5.5', ROWS).wire).toBe('chat')
    expect(resolveCompatWire('https://api.openai.com/v1', 'gpt-5.6', ROWS).wire).toBe('responses')
  })
})

describe('rejectWireOnFailure', () => {
  const url = 'https://api.openai.com/v1'

  test('400, 404 and 422 reject the pair; a request already in flight on it goes back to chat too', () => {
    for (const status of [400, 404, 422]) {
      _resetWireFallbackForTesting()
      expect(rejectWireOnFailure('responses', url, 'gpt-5.5', { status, body: 'unsupported' })).toBe(true)
      expect(isWireRejected('responses', url, 'gpt-5.5')).toBe(true)
      expect(rejectWireOnFailure('responses', url, 'gpt-5.5', { status, body: 'unsupported' })).toBe(true)
    }
  })

  test('auth, rate limits and server errors are not the wire\'s fault', () => {
    for (const status of [401, 403, 429, 500, 503]) {
      expect(rejectWireOnFailure('responses', url, 'gpt-5.5', { status, body: 'x' })).toBe(false)
    }
    expect(isWireRejected('responses', url, 'gpt-5.5')).toBe(false)
  })

  test('a context overflow is left to compaction', () => {
    const body = JSON.stringify({ error: { message: "This model's maximum context length is 400000 tokens" } })
    expect(rejectWireOnFailure('responses', url, 'gpt-5.5', { status: 400, body })).toBe(false)
  })

  test('after a success on the pair, a 400 is just a 400', () => {
    noteWireSuccess('anthropic', 'https://api.minimax.io/v1/', 'MiniMax-M3')
    expect(rejectWireOnFailure('anthropic', 'https://api.minimax.io/v1', 'minimax-m3', { status: 400, body: 'x' })).toBe(false)
  })
})

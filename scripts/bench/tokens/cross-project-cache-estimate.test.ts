import { describe, expect, test } from 'bun:test'
import { estimate, parseRequests } from './cross-project-cache-estimate.js'

const T0 = Date.parse('2026-09-20T10:00:00Z')
const MIN = 60_000
const req = (cwd: string, model: string, atMin: number, read: number, write: number) => ({
  at: T0 + atMin * MIN,
  cwd,
  model,
  input: 0,
  read,
  write1h: write,
  write5m: 0,
  output: 0,
})

describe('cross-project cache estimate', () => {
  test('one request per message id, usage at its largest', () => {
    const line = (outTokens: number) =>
      JSON.stringify({
        type: 'assistant',
        cwd: '/a',
        timestamp: '2026-09-20T10:00:00Z',
        message: { id: 'm1', model: 'claude-opus-5-5', usage: { input_tokens: 3, cache_creation_input_tokens: 900, output_tokens: outTokens } },
      })
    const reqs = parseRequests([line(1), line(40)].join('\n'))
    expect(reqs.map(r => [r.write1h, r.output])).toEqual([[900, 40]])
  })

  test('saves only a cold start that another directory on the same model could have served', () => {
    const sessions = [
      [req('/a', 'm', 0, 0, 20_000)],
      // Cold, and /a wrote the static prefix 30 minutes earlier: saved.
      [req('/b', 'm', 30, 0, 20_000)],
      // Warm: read the static prefix from /a's session.
      [req('/a', 'm', 40, 20_000, 500)],
      // Cold on another model, which no other directory ran: not saved.
      [req('/c', 'm2', 10, 0, 20_000)],
    ]
    const e = estimate(sessions, 14_000)
    expect(e.starts).toBe(4)
    expect(e.coldStarts).toBe(3)
    expect(e.savedStarts).toBe(1)
    expect(e.savedUnits).toBeCloseTo(14_000 * 1.9)
  })

  test('a request an hour after the previous one is a new start', () => {
    const e = estimate([[req('/a', 'm', 0, 0, 100), req('/a', 'm', 30, 100, 0), req('/a', 'm', 100, 0, 100)]], 14_000)
    expect(e.starts).toBe(2)
  })
})

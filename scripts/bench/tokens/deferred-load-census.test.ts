import { describe, expect, test } from 'bun:test'
import { evaluateSet, parseSession } from './deferred-load-census.js'

// One interactive session: an answer, a ToolSearch-only response that loads
// AskUserQuestion (the round trip), then the call it was loaded for. The first
// response is streamed as two entries of one message, the second carrying the
// final usage.
const assistant = (id: string, usage: Record<string, number>, content: unknown[]) =>
  JSON.stringify({ type: 'assistant', entrypoint: 'cli', message: { id, usage, content } })
const TRANSCRIPT = [
  JSON.stringify({ type: 'user', entrypoint: 'cli', message: { content: 'hi' } }),
  assistant('m1', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 0, output_tokens: 5 }, [{ type: 'text', text: 'a' }]),
  assistant('m1', { input_tokens: 10, cache_read_input_tokens: 0, cache_creation_input_tokens: 1000, output_tokens: 50 }, [{ type: 'text', text: 'b' }]),
  assistant('m2', { input_tokens: 2, cache_read_input_tokens: 1000, cache_creation_input_tokens: 0, output_tokens: 20 }, [
    { type: 'tool_use', id: 't1', name: 'ToolSearch', input: { query: 'select:AskUserQuestion' } },
  ]),
  JSON.stringify({
    type: 'user',
    message: { content: [{ type: 'tool_result', tool_use_id: 't1', content: 'loaded' }] },
    toolUseResult: { matches: ['AskUserQuestion'] },
  }),
  assistant('m3', { input_tokens: 2, cache_read_input_tokens: 1100, cache_creation_input_tokens: 0, output_tokens: 30 }, [
    { type: 'tool_use', id: 't2', name: 'AskUserQuestion', input: {} },
  ]),
].join('\n')

describe('deferred-load census', () => {
  test('one request per message, usage at its largest, the load and the call attributed', () => {
    const s = parseSession(TRANSCRIPT, 'p')!
    expect(s.entrypoint).toBe('cli')
    expect(s.requests.map(r => [r.write1h, r.output])).toEqual([
      [1000, 50],
      [0, 20],
      [0, 30],
    ])
    expect(s.requests[1].loaded).toEqual(['AskUserQuestion'])
    expect(s.requests[2].called).toEqual(['AskUserQuestion'])
  })

  test('eager saves the round trip and pays the schema up to the load', () => {
    const s = parseSession(TRANSCRIPT, 'p')!
    const r = evaluateSet([s], ['AskUserQuestion'], { AskUserQuestion: 100 })
    expect(r.savedRoundTrips).toBe(1)
    expect(r.sessionsLoading).toBe(1)
    expect(r.sessionsCalling).toBe(1)
    // The load is the second request: one 1h write of the schema before it.
    expect(r.eagerCost).toBeCloseTo(100 * 2)
    // The round trip itself (2 input + 1000 read x0.1 + 20 output x5) and the
    // schema written into the history at the load.
    expect(r.deferredCost).toBeCloseTo(2 + 100 + 100 + 100 * 2)
  })

  test('a round trip that also loads a tool left deferred is not saved', () => {
    const both = TRANSCRIPT.replace('select:AskUserQuestion', 'select:AskUserQuestion,EnterPlanMode').replace(
      '"matches":["AskUserQuestion"]',
      '"matches":["AskUserQuestion","EnterPlanMode"]',
    )
    const s = parseSession(both, 'p')!
    expect(evaluateSet([s], ['AskUserQuestion'], { AskUserQuestion: 100 }).savedRoundTrips).toBe(0)
    expect(evaluateSet([s], ['AskUserQuestion', 'EnterPlanMode'], { AskUserQuestion: 100, EnterPlanMode: 50 }).savedRoundTrips).toBe(1)
  })
})

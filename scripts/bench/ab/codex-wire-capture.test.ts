import { afterEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import {
  formatTable,
  isMainLoopRequest,
  readCaptures,
  summarizeArm,
  type CapturedRequest,
} from './codex-wire-capture'

function request(body: Record<string, unknown>, usage: CapturedRequest['usage'] = []): CapturedRequest {
  return { transport: 'http', headers: {}, body, items: [], usage }
}

// The shapes captured on 2026-10-16: Codex CLI 0.162.1 and Claudin before the replay.
const CODEX_TURN = request(
  {
    model: 'gpt-5.6-terra',
    include: ['reasoning.encrypted_content'],
    reasoning: { effort: 'medium', context: 'all_turns' },
    text: { verbosity: 'low' },
    parallel_tool_calls: false,
    tool_choice: 'auto',
    input: [
      { type: 'message', role: 'user', content: [] },
      { type: 'reasoning', id: 'rs_1', encrypted_content: 'x' },
      { type: 'message', role: 'assistant', id: 'msg_1', phase: 'commentary', content: [] },
      { type: 'custom_tool_call', id: 'ctc_1', call_id: 'call_1', name: 'exec', input: '' },
      { type: 'reasoning', id: 'rs_2', encrypted_content: 'y' },
    ],
  },
  [{ input: 100, cached: 80, output: 20, reasoning: 13 }],
)
const CLAUDIN_TURN = request(
  {
    model: 'gpt-5.6-terra',
    reasoning: { effort: 'medium' },
    parallel_tool_calls: true,
    tool_choice: 'auto',
    input: [
      { type: 'message', role: 'user', content: [] },
      { type: 'message', role: 'assistant', content: [] },
      { type: 'function_call', id: 'fc_abc', call_id: 'call_abc', name: 'Read', arguments: '{}' },
    ],
  },
  [{ input: 200, cached: 0, output: 10, reasoning: 0 }],
)

describe('which requests are the agent loop', () => {
  test("Codex's prewarm frame and a forced-tool side query are not", () => {
    expect(isMainLoopRequest(request({ generate: false }))).toBe(false)
    expect(isMainLoopRequest(request({ tool_choice: { type: 'function', name: 'classify_result' } }))).toBe(false)
    expect(isMainLoopRequest(CODEX_TURN)).toBe(true)
    expect(isMainLoopRequest(request({}))).toBe(true)
  })
})

describe('summarizeArm', () => {
  test('the Codex CLI turn: every field, two reasoning items, its own ids and phase', () => {
    const summary = summarizeArm([request({ generate: false, input: [] }), CODEX_TURN])
    expect(summary).toMatchObject({
      requests: 1,
      include: ['["reasoning.encrypted_content"]'],
      reasoning: ['{"effort":"medium","context":"all_turns"}'],
      text: ['{"verbosity":"low"}'],
      parallelToolCalls: ['false'],
      replayedReasoning: [2],
      messagesWithId: 1,
      messagesWithPhase: 1,
      messagesReplayed: 1,
      callsWithBackendId: 1,
      callsReplayed: 1,
      reasoningTokens: 13,
      cachedTokens: 80,
      inputTokens: 100,
    })
    expect(summary.fields.include).toBe(1)
    expect(summary.fields.generate).toBeUndefined()
  })

  test("Claudin before the replay: no include, no reasoning items, a synthetic call id", () => {
    expect(summarizeArm([CLAUDIN_TURN])).toMatchObject({
      include: ['(absent)'],
      text: ['(absent)'],
      replayedReasoning: [0],
      messagesWithId: 0,
      callsWithBackendId: 0,
      callsReplayed: 1,
    })
  })

  test('an arm with no requests summarizes to zeros', () => {
    expect(summarizeArm([])).toMatchObject({ requests: 0, replayedReasoning: [], reasoningTokens: 0, transports: [], framesWithPrevious: 0, inputItems: [] })
  })

  test('a WebSocket delta: the transport, the previous response it names, its few items', () => {
    const full = { ...request({ input: [{}, {}, {}] }), transport: 'websocket' as const }
    const delta = { ...request({ previous_response_id: 'resp_1', input: [{ type: 'function_call_output' }] }), transport: 'websocket' as const }
    expect(summarizeArm([full, delta])).toMatchObject({ transports: ['websocket'], framesWithPrevious: 1, inputItems: [3, 1] })
  })
})

describe('formatTable', () => {
  test('one column per arm, a dash where an arm never sent a field', () => {
    const table = formatTable({ codex: summarizeArm([CODEX_TURN]), claudin: summarizeArm([CLAUDIN_TURN]) })
    const lines = table.split('\n')
    expect(lines[0]).toMatch(/^\s+codex\s+claudin$/)
    expect(lines.find(line => line.startsWith('transport'))).toMatch(/http\s+http$/)
    expect(lines.find(line => line.startsWith('requests naming the previous response'))).toMatch(/0\/1\s+0\/1$/)
    expect(lines.find(line => line.startsWith('input items per request'))).toMatch(/5\s+3$/)
    expect(lines.find(line => line.startsWith('reasoning items replayed per request'))).toMatch(/2\s+0$/)
    expect(lines.find(line => line.startsWith('field: text'))).toMatch(/1\/1\s+—$/)
    expect(lines.find(line => line.startsWith('calls under the backend id'))).toMatch(/1\/1\s+0\/1$/)
  })
})

describe('readCaptures', () => {
  const dirs: string[] = []
  afterEach(() => {
    for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  })

  test('groups the addon output by arm, in request order', () => {
    const dir = mkdtempSync(join(tmpdir(), 'codex-wire-'))
    dirs.push(dir)
    writeFileSync(join(dir, '002-codex.json'), JSON.stringify(request({ n: 2 })))
    writeFileSync(join(dir, '001-codex.json'), JSON.stringify(request({ n: 1 })))
    writeFileSync(join(dir, '001-claudin-off.json'), JSON.stringify(request({ n: 3 })))
    writeFileSync(join(dir, 'notes.txt'), 'ignored')
    const byLabel = readCaptures(dir)
    expect(Object.keys(byLabel).sort()).toEqual(['claudin-off', 'codex'])
    expect(byLabel.codex!.map(r => r.body.n)).toEqual([1, 2])
  })
})

/**
 * Pure-function tests for the lagging cache marker: state rotation across
 * requests, retry detection by last-message uuid, the uuid lookup surviving a
 * compaction, coalescing with the main marker, and the API's position count
 * (tool_use / tool_result runs collapse to one position each).
 */
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  _resetLagMarkerStateForTesting,
  CACHE_LOOKBACK_POSITIONS,
  countPositions,
  isLagMarkerEnabled,
  resolveLagMarker,
} from 'src/providers/shims/claude/lagCacheMarker.js'
import type { AssistantMessage, UserMessage } from 'src/shared/types/message.js'

type Msg = UserMessage | AssistantMessage

let seq = 0
function user(content: unknown = [{ type: 'text', text: 'u' }]): Msg {
  seq += 1
  return {
    type: 'user',
    uuid: `u-${seq}`,
    timestamp: '',
    message: { role: 'user', content },
  } as unknown as Msg
}
function assistant(content: unknown = [{ type: 'text', text: 'a' }]): Msg {
  seq += 1
  return {
    type: 'assistant',
    uuid: `a-${seq}`,
    timestamp: '',
    message: { role: 'assistant', content },
  } as unknown as Msg
}
function toolUse(n = 1): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'tool_use',
    id: `t${i}`,
    name: 'Bash',
    input: {},
  }))
}
function toolResult(n = 1): unknown[] {
  return Array.from({ length: n }, (_, i) => ({
    type: 'tool_result',
    tool_use_id: `t${i}`,
    content: 'ok',
  }))
}

const originalEnv = process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER

beforeEach(() => {
  _resetLagMarkerStateForTesting()
  delete process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER
})
afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER
  } else {
    process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER = originalEnv
  }
})

describe('resolveLagMarker', () => {
  test('first request records the marker and places no lag', () => {
    const msgs = [user(), assistant(), user()]
    const r = resolveLagMarker('k', msgs, 2)
    expect(r.lagIndex).toBeUndefined()
    expect(r.advancedPositions).toBeUndefined()
  })

  test('second request lags on the message that carried the previous marker', () => {
    const msgs = [user(), assistant(), user()]
    resolveLagMarker('k', msgs, 1)
    const next = [...msgs, assistant(), user()]
    const r = resolveLagMarker('k', next, 4)
    expect(r.lagIndex).toBe(1)
    expect(r.advancedPositions).toBe(3)
  })

  test('coalesces when the main marker did not move', () => {
    const msgs = [user(), assistant(), user()]
    resolveLagMarker('k', msgs, 1)
    const next = [...msgs, assistant(), user()]
    const r = resolveLagMarker('k', next, 1)
    expect(r.lagIndex).toBeUndefined()
    expect(r.advancedPositions).toBe(0)
  })

  test('a retry (same last message uuid) keeps the previous lag instead of rotating', () => {
    const first = [user(), assistant(), user()]
    resolveLagMarker('k', first, 1)
    const second = [...first, assistant(), user()]
    expect(resolveLagMarker('k', second, 4).lagIndex).toBe(1)
    // Retry of the same request: lag must still point at index 1, not at 4.
    expect(resolveLagMarker('k', second, 4).lagIndex).toBe(1)
    // The request after the retry lags on 4 — the retry did not rotate.
    const third = [...second, assistant(), user()]
    expect(resolveLagMarker('k', third, 6).lagIndex).toBe(4)
  })

  test('previous marker uuid gone (compaction) → no lag, state re-seeded', () => {
    const msgs = [user(), assistant(), user()]
    resolveLagMarker('k', msgs, 1)
    const compacted = [user(), assistant(), user()]
    const r = resolveLagMarker('k', compacted, 2)
    expect(r.lagIndex).toBeUndefined()
    expect(r.advancedPositions).toBeUndefined()
    const after = [...compacted, assistant(), user()]
    expect(resolveLagMarker('k', after, 4).lagIndex).toBe(2)
  })

  test('the uuid survives a prepend: the lag follows the message, not the index', () => {
    const msgs = [user(), assistant(), user()]
    resolveLagMarker('k', msgs, 1)
    const prepended = [user(), ...msgs, assistant(), user()]
    const r = resolveLagMarker('k', prepended, 5)
    expect(r.lagIndex).toBe(2)
  })

  test('keys are isolated', () => {
    const msgs = [user(), assistant(), user()]
    resolveLagMarker('a', msgs, 1)
    const next = [...msgs, assistant(), user()]
    expect(resolveLagMarker('b', next, 4).lagIndex).toBeUndefined()
    expect(resolveLagMarker('a', next, 4).lagIndex).toBe(1)
  })

  test('out-of-range marker is a no-op', () => {
    expect(resolveLagMarker('k', [], 0).lagIndex).toBeUndefined()
    expect(resolveLagMarker('k', [user()], 3).lagIndex).toBeUndefined()
  })
})

describe('countPositions — the API lookback unit', () => {
  test('text blocks count one each', () => {
    const msgs = [user(), assistant(), user(), assistant()]
    expect(countPositions(msgs, 0, 3)).toBe(3)
  })

  test('a run of tool_use blocks is one position, same for tool_result', () => {
    const msgs = [
      user(),
      assistant([{ type: 'text', text: 'x' }, ...toolUse(4)]),
      user(toolResult(4)),
    ]
    // text(1) + tool_use run(1) + tool_result run(1)
    expect(countPositions(msgs, 0, 2)).toBe(3)
  })

  test('a text block breaks a run', () => {
    const msgs = [
      user(),
      assistant([...toolUse(1), { type: 'text', text: 'x' }, ...toolUse(1)]),
    ]
    expect(countPositions(msgs, 0, 1)).toBe(3)
  })

  test('thinking and image blocks count one each', () => {
    const msgs = [
      user(),
      assistant([
        { type: 'thinking', thinking: '', signature: 's' },
        ...toolUse(2),
      ]),
      user([
        { type: 'image', source: { type: 'base64', media_type: 'image/png', data: '' } },
        { type: 'text', text: 'see' },
      ]),
    ]
    expect(countPositions(msgs, 0, 2)).toBe(4)
  })

  test('a twenty-turn tiny tool loop exceeds the lookback window', () => {
    const msgs: Msg[] = [user()]
    for (let i = 0; i < 12; i += 1) {
      msgs.push(assistant(toolUse(1)), user(toolResult(1)))
    }
    expect(countPositions(msgs, 0, msgs.length - 1)).toBeGreaterThanOrEqual(
      CACHE_LOOKBACK_POSITIONS,
    )
  })
})

describe('isLagMarkerEnabled', () => {
  test('on by default, off under the killswitch', () => {
    expect(isLagMarkerEnabled()).toBe(true)
    process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER = '1'
    expect(isLagMarkerEnabled()).toBe(false)
  })
})

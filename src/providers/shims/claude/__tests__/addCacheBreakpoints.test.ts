/**
 * Behavioral tests for the defer-cache-marker placement logic in
 * addCacheBreakpoints. See the long comment on DEFAULT_DEFER_CACHE_MARKER_TOKENS
 * in paramBuilders.ts for why this matters.
 *
 * The threshold is memoized at module load. Each test flips the env then
 * calls _resetDeferCacheMarkerForTesting() to re-read it.
 */
import { afterEach, describe, expect, test } from 'bun:test'

;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
}

import {
  _resetDeferCacheMarkerForTesting,
  addCacheBreakpoints,
} from 'src/providers/shims/claude/paramBuilders.js'
import { _resetLagMarkerStateForTesting } from 'src/providers/shims/claude/lagCacheMarker.js'

type AnyMsg = {
  type: 'user' | 'assistant'
  message: { role: 'user' | 'assistant'; content: unknown }
}

const originalEnv = process.env.CLAUDIN_DEFER_CACHE_MARKER
const originalTrailEnv = process.env.CLAUDIN_TRAIL_CACHE_MARKER
const originalAnchorEnv = process.env.CLAUDIN_ANCHOR_CACHE_HEAD
const originalLagEnv = process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER

afterEach(() => {
  if (originalEnv === undefined) {
    delete process.env.CLAUDIN_DEFER_CACHE_MARKER
  } else {
    process.env.CLAUDIN_DEFER_CACHE_MARKER = originalEnv
  }
  if (originalTrailEnv === undefined) {
    delete process.env.CLAUDIN_TRAIL_CACHE_MARKER
  } else {
    process.env.CLAUDIN_TRAIL_CACHE_MARKER = originalTrailEnv
  }
  if (originalAnchorEnv === undefined) {
    delete process.env.CLAUDIN_ANCHOR_CACHE_HEAD
  } else {
    process.env.CLAUDIN_ANCHOR_CACHE_HEAD = originalAnchorEnv
  }
  if (originalLagEnv === undefined) {
    delete process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER
  } else {
    process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER = originalLagEnv
  }
  _resetDeferCacheMarkerForTesting()
  _resetLagMarkerStateForTesting()
})

function makeUser(text: string): AnyMsg {
  return {
    type: 'user',
    message: { role: 'user', content: [{ type: 'text', text }] },
  }
}
function makeAssistant(text: string): AnyMsg {
  return {
    type: 'assistant',
    message: { role: 'assistant', content: [{ type: 'text', text }] },
  }
}

/** Find indices of message params that carry cache_control on their last block. */
function markerIndices(
  out: Array<{ content?: unknown }>,
): number[] {
  const result: number[] = []
  for (let i = 0; i < out.length; i += 1) {
    const content = out[i]?.content
    if (!Array.isArray(content)) continue
    const last = content[content.length - 1] as
      | { cache_control?: unknown }
      | undefined
    if (last && last.cache_control) result.push(i)
  }
  return result
}

function setThreshold(value: string): void {
  process.env.CLAUDIN_DEFER_CACHE_MARKER = value
  _resetDeferCacheMarkerForTesting()
}

describe('addCacheBreakpoints — defer-cache-marker placement', () => {
  test('threshold=0 places marker at messages[length-1] (baseline)', () => {
    setThreshold('0')
    const msgs = [
      makeUser('hello'),
      makeAssistant('hi'),
      makeUser('again'),
      makeAssistant('yes'),
      makeUser('final'),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
    )
    expect(markerIndices(out)).toEqual([msgs.length - 1])
  })

  test('threshold met by small suffix → marker walks back to that index', () => {
    // ~1k chars per message ≈ 250 tok; threshold=600 → ~3 messages suffice.
    setThreshold('600')
    const big = 'x'.repeat(1024)
    const msgs = [
      makeUser(big),
      makeAssistant(big),
      makeUser(big),
      makeAssistant(big),
      makeUser(big),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
    )
    const idx = markerIndices(out)
    expect(idx.length).toBe(1)
    // Marker should land strictly before the last message because the
    // suffix [last] alone (~250 tok) is below 600 but a few-message suffix
    // clears it.
    expect(idx[0]).toBeLessThan(msgs.length - 1)
    expect(idx[0]).toBeGreaterThanOrEqual(0)
  })

  test('threshold never met → pins marker at messages[0] (head anchor)', () => {
    // Tiny messages + huge threshold → loop exhausts without hitting it.
    setThreshold('1000000')
    const msgs = [makeUser('a'), makeAssistant('b'), makeUser('c')]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
    )
    // Intentional: pin to head so early/short conversations still get a
    // stable byte-prefix the server can latch onto. See the long block
    // comment in paramBuilders.ts and the bench notes.
    expect(markerIndices(out)).toEqual([0])
  })

  test('skipCacheWrite bypasses the defer logic entirely', () => {
    setThreshold('100000')
    const big = 'x'.repeat(4096)
    const msgs = [
      makeUser(big),
      makeAssistant(big),
      makeUser(big),
      makeAssistant(big),
      makeUser(big),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      true,
    )
    // skipCacheWrite → baseline marker at second-to-last regardless of threshold.
    expect(markerIndices(out)).toEqual([msgs.length - 2])
  })

  test('garbage env var value silently falls back to default (does not throw)', () => {
    setThreshold('not-a-number')
    const msgs = [makeUser('hi'), makeAssistant('hello'), makeUser('final')]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
    )
    expect(markerIndices(out).length).toBe(1)
  })
})

describe('addCacheBreakpoints — clip-frontier cap (5th param)', () => {
  test('cap below the deferred index moves the marker to the frontier', () => {
    setThreshold('0') // baseline would put the marker at length-1
    const msgs = [
      makeUser('a'),
      makeAssistant('b'),
      makeUser('c'),
      makeAssistant('d'),
      makeUser('e'),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      2,
    )
    expect(markerIndices(out)).toEqual([2])
  })

  test('cap at or above the deferred index is a no-op (defer wins / min)', () => {
    setThreshold('600')
    const big = 'x'.repeat(1024)
    const msgs = [
      makeUser(big),
      makeAssistant(big),
      makeUser(big),
      makeAssistant(big),
      makeUser(big),
    ]
    const without = markerIndices(
      addCacheBreakpoints(
        msgs as Parameters<typeof addCacheBreakpoints>[0],
        true,
      ),
    )
    const withCap = markerIndices(
      addCacheBreakpoints(
        msgs as Parameters<typeof addCacheBreakpoints>[0],
        true,
        undefined,
        false,
        msgs.length - 1, // frontier deeper than the deferred index
      ),
    )
    expect(withCap).toEqual(without)
  })

  test('frontier -1 (no stable prefix) leaves placement untouched', () => {
    setThreshold('0')
    const msgs = [makeUser('a'), makeAssistant('b'), makeUser('c')]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      -1,
    )
    expect(markerIndices(out)).toEqual([msgs.length - 1])
  })

  test('undefined frontier keeps existing behavior (flag-off path)', () => {
    setThreshold('0')
    const msgs = [makeUser('a'), makeAssistant('b'), makeUser('c')]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      undefined,
    )
    expect(markerIndices(out)).toEqual([msgs.length - 1])
  })

  test('skipCacheWrite ignores the cap (fork marker stays at length-2)', () => {
    setThreshold('0')
    const msgs = [
      makeUser('a'),
      makeAssistant('b'),
      makeUser('c'),
      makeAssistant('d'),
      makeUser('e'),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      true,
      1,
    )
    expect(markerIndices(out)).toEqual([msgs.length - 2])
  })

  test('cap composes with head-pin: min(0, frontier) stays at head', () => {
    // Threshold never met → defer pins to index 0; a deeper frontier must not
    // drag the marker forward past the registration heuristic.
    setThreshold('1000000')
    const msgs = [makeUser('a'), makeAssistant('b'), makeUser('c')]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      2,
    )
    expect(markerIndices(out)).toEqual([0])
  })
})

describe('addCacheBreakpoints — trailing marker (CLAUDIN_TRAIL_CACHE_MARKER)', () => {
  function setTrail(on: boolean): void {
    if (on) process.env.CLAUDIN_TRAIL_CACHE_MARKER = '1'
    else delete process.env.CLAUDIN_TRAIL_CACHE_MARKER
  }

  test('flag on + frontier cap → markers at [frontier, length-1]', () => {
    setThreshold('0')
    setTrail(true)
    const msgs = [
      makeUser('a'),
      makeAssistant('b'),
      makeUser('c'),
      makeAssistant('d'),
      makeUser('e'),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      2,
    )
    expect(markerIndices(out)).toEqual([2, msgs.length - 1])
  })

  test('flag on + main marker already at length-1 → coalesces to one marker', () => {
    setThreshold('0') // baseline puts the main marker at length-1
    setTrail(true)
    const msgs = [makeUser('a'), makeAssistant('b'), makeUser('c')]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
    )
    expect(markerIndices(out)).toEqual([msgs.length - 1])
  })

  test('flag on + deferred marker behind the end → adds the trailing marker', () => {
    // Huge threshold pins the main marker to head; trail covers the window.
    setThreshold('1000000')
    setTrail(true)
    const msgs = [makeUser('a'), makeAssistant('b'), makeUser('c')]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
    )
    expect(markerIndices(out)).toEqual([0, msgs.length - 1])
  })

  test('flag on + skipCacheWrite → no trailing marker (fork path untouched)', () => {
    setThreshold('0')
    setTrail(true)
    const msgs = [
      makeUser('a'),
      makeAssistant('b'),
      makeUser('c'),
      makeAssistant('d'),
      makeUser('e'),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      true,
    )
    expect(markerIndices(out)).toEqual([msgs.length - 2])
  })

  test('flag on suppresses CLAUDIN_ANCHOR_CACHE_HEAD (4-block budget)', () => {
    setThreshold('0')
    setTrail(true)
    process.env.CLAUDIN_ANCHOR_CACHE_HEAD = '1'
    const msgs = [
      makeUser('a'),
      makeAssistant('b'),
      makeUser('c'),
      makeAssistant('d'),
      makeUser('e'),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      2,
    )
    // head anchor suppressed: only frontier + trail, never 3 message markers
    expect(markerIndices(out)).toEqual([2, msgs.length - 1])
  })

  test('flag off (default) keeps single-marker behavior with frontier cap', () => {
    setThreshold('0')
    setTrail(false)
    const msgs = [
      makeUser('a'),
      makeAssistant('b'),
      makeUser('c'),
      makeAssistant('d'),
      makeUser('e'),
    ]
    const out = addCacheBreakpoints(
      msgs as Parameters<typeof addCacheBreakpoints>[0],
      true,
      undefined,
      false,
      2,
    )
    expect(markerIndices(out)).toEqual([2])
  })
})

describe('addCacheBreakpoints — lagging marker (previous request\'s marker)', () => {
  // The lag marker needs a tracked querySource and message uuids; the
  // suites above pass neither, which is what keeps them single-marker.
  const SOURCE = 'repl_main_thread' as const
  let seq = 0
  function withUuid(msg: AnyMsg): AnyMsg & { uuid: string } {
    seq += 1
    return { ...msg, uuid: `m-${seq}` }
  }
  function run(
    msgs: AnyMsg[],
    opts: { skipCacheWrite?: boolean; frontier?: number; source?: string } = {},
  ): number[] {
    return markerIndices(
      addCacheBreakpoints(
        msgs as Parameters<typeof addCacheBreakpoints>[0],
        true,
        (opts.source ?? SOURCE) as Parameters<typeof addCacheBreakpoints>[2],
        opts.skipCacheWrite ?? false,
        opts.frontier,
      ),
    )
  }

  test('the second request carries the previous marker as a second breakpoint', () => {
    setThreshold('0') // main marker at length-1 every request
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    expect(run(first)).toEqual([2])
    const second = [...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    expect(run(second)).toEqual([2, 4])
    const third = [...second, withUuid(makeAssistant('f')), withUuid(makeUser('g'))]
    // Only the previous request's marker lags — never more than two markers.
    expect(run(third)).toEqual([4, 6])
  })

  test('a retry of the same request keeps the lag where the previous request wrote', () => {
    setThreshold('0')
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    run(first)
    const second = [...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    expect(run(second)).toEqual([2, 4])
    expect(run(second)).toEqual([2, 4])
  })

  test('a marker that did not move coalesces into one', () => {
    // Huge threshold pins the main marker at the head on every request.
    setThreshold('1000000')
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    expect(run(first)).toEqual([0])
    const second = [...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    expect(run(second)).toEqual([0])
  })

  test('the lag follows the message uuid across a prepend', () => {
    setThreshold('0')
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    run(first)
    const second = [withUuid(makeUser('announce')), ...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    expect(run(second)).toEqual([3, 5])
  })

  test('after a compaction the old marker is gone and only the main one is emitted', () => {
    setThreshold('0')
    run([withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))])
    const compacted = [withUuid(makeUser('summary')), withUuid(makeUser('next'))]
    expect(run(compacted)).toEqual([1])
  })

  test('the lag sits behind the clip-frontier cap, never past it', () => {
    setThreshold('0')
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    expect(run(first, { frontier: 1 })).toEqual([1])
    const second = [...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    expect(run(second, { frontier: 3 })).toEqual([1, 3])
  })

  test('skipCacheWrite forks get no lag marker', () => {
    setThreshold('0')
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    run(first)
    const second = [...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    expect(run(second, { skipCacheWrite: true })).toEqual([3])
  })

  test('an untracked querySource gets no lag marker', () => {
    setThreshold('0')
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    run(first, { source: 'speculation' })
    const second = [...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    expect(run(second, { source: 'speculation' })).toEqual([4])
  })

  test('the experimental trailing / head markers suppress the lag (4-breakpoint budget)', () => {
    setThreshold('1000000') // main pinned at head so trail actually adds one
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    run(first)
    const second = [...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    process.env.CLAUDIN_TRAIL_CACHE_MARKER = '1'
    expect(run(second)).toEqual([0, 4])
    delete process.env.CLAUDIN_TRAIL_CACHE_MARKER
    process.env.CLAUDIN_ANCHOR_CACHE_HEAD = '1'
    setThreshold('0')
    const third = [...second, withUuid(makeAssistant('f')), withUuid(makeUser('g'))]
    expect(run(third)).toEqual([0, 6])
  })

  test('the killswitch restores the single marker', () => {
    setThreshold('0')
    process.env.CLAUDIN_DISABLE_LAG_CACHE_MARKER = '1'
    const first = [withUuid(makeUser('a')), withUuid(makeAssistant('b')), withUuid(makeUser('c'))]
    run(first)
    const second = [...first, withUuid(makeAssistant('d')), withUuid(makeUser('e'))]
    expect(run(second)).toEqual([4])
  })

  test('no message ever carries more than two markers across a long tool loop', () => {
    setThreshold('600')
    let msgs = [withUuid(makeUser('x'.repeat(4096)))]
    for (let turn = 0; turn < 30; turn += 1) {
      msgs = [...msgs, withUuid(makeAssistant('t')), withUuid(makeUser(turn % 7 === 0 ? 'x'.repeat(4096) : 'r'))]
      const markers = run(msgs)
      expect(markers.length).toBeGreaterThanOrEqual(1)
      expect(markers.length).toBeLessThanOrEqual(2)
    }
  })
})

/**
 * Invariant: an image never holds the cache marker back.
 *
 * The clip frontier caps the message-level cache_control marker before the
 * first block a later request will rewrite (clipFrontier.ts). Everything after
 * the marker is billed as uncached input on EVERY request, so a block the
 * frontier wrongly calls mutable costs the whole tail, request after request,
 * for the rest of the session. Two image paths did exactly that (census
 * 2026-10-15, $243 in one week):
 *
 * - an idle-gap clip put a screenshot's id in the clipped set; stubOneBlock
 *   never stubs an image-bearing block, so the frontier waited for a stub that
 *   could not come (72c401aa: 2h at a frozen read, 38 calls);
 * - past the API's 100-media cap every media block counted as mutable
 *   (81744358: 230 calls with ~470k uncached each after the 101st screenshot).
 *
 * Requests here are built the way the Anthropic shim builds them — the
 * production render, the frontier, the markers (`wireRequest`).
 */
import { afterAll, beforeEach, describe, expect, test } from 'bun:test'
import { _resetCacheProfileForTesting } from 'src/agent/cache/cacheProfile.js'
import {
  _resetAllClippedIdsForTesting,
  addClippedIds,
} from 'src/agent/compact/stableStubState.js'
import { createAssistantMessage, createUserMessage } from 'src/agent/messages/messages.js'
import { resetGlobalConfigForTests } from 'src/platform/config/config.js'
import type { Message } from 'src/shared/types/message.js'
import {
  describePrefixBreak,
  findPrefixBreak,
  wireRequest,
} from 'src/agent/cache/__testutils__/prefixInvariant.js'

const savedProfile = process.env.CLAUDIN_CACHE_PROFILE

beforeEach(() => {
  process.env.CLAUDIN_CACHE_PROFILE = 'retain'
  _resetCacheProfileForTesting()
  _resetAllClippedIdsForTesting()
})

afterAll(() => {
  _resetAllClippedIdsForTesting()
  if (savedProfile === undefined) delete process.env.CLAUDIN_CACHE_PROFILE
  else process.env.CLAUDIN_CACHE_PROFILE = savedProfile
  _resetCacheProfileForTesting()
  resetGlobalConfigForTests()
})

// A 1×1 PNG: real bytes, so nothing on the way can reject it as malformed.
const PNG =
  'iVBORw0KGgoAAAANSUhEUgAAAAEAAAABCAYAAAAfFcSJAAAADUlEQVR42mNkYPhfDwAChwGA60e6kgAAAABJRU5ErkJggg=='

const screenshot = (label: string) => [
  { type: 'text' as const, text: `screenshot ${label}` },
  { type: 'image' as const, source: { type: 'base64' as const, media_type: 'image/png' as const, data: PNG } },
]

/** One tool call and its result. */
function exchange(id: string, name: string, content: unknown): Message[] {
  return [
    createAssistantMessage({ content: [{ type: 'tool_use', id, name, input: {} }] }),
    createUserMessage({ content: [{ type: 'tool_result', tool_use_id: id, content } as never] }),
  ]
}

const textResult = (i: number) => `output ${i}\n`.repeat(400)

describe('a clipped screenshot', () => {
  test('never fences the marker: the stub it waits for cannot come', () => {
    const history: Message[] = [
      createUserMessage({ content: 'check the dashboard' }),
      ...exchange('shot', 'mcp__playwright__browser_take_screenshot', screenshot('dashboard')),
      ...exchange('r1', 'Read', textResult(1)),
      ...exchange('r2', 'Read', textResult(2)),
    ]
    // What the idle-gap clip left behind before it learned to skip images.
    addClippedIds(['shot', 'r1'])

    const req = wireRequest(history, [])

    expect(req.wire.join('\n')).toContain('screenshot dashboard')
    expect(req.markerIndex).toBe(req.wire.length - 1)
  })

  test('is stubbed in the same request the media cap strips its image', () => {
    const history: Message[] = [createUserMessage({ content: 'walk the pages' })]
    for (let i = 0; i < 101; i++) {
      history.push(...exchange(`shot${i}`, 'mcp__playwright__browser_take_screenshot', screenshot(String(i))))
    }
    // The oldest screenshot is the one the cap drops; it was clipped earlier.
    addClippedIds(['shot0'])

    const req = wireRequest(history, [])
    const shot0 = req.wire.find(m => m.includes('"tool_use_id":"shot0"'))!

    expect(shot0).toContain('[clipped:')
    expect(req.markerIndex).toBe(req.wire.length - 1)
  })
})

describe('past the 100-media cap', () => {
  function walk(screens: number): Message[] {
    const history: Message[] = [createUserMessage({ content: 'walk the pages' })]
    for (let i = 0; i < screens; i++) {
      history.push(...exchange(`shot${i}`, 'mcp__playwright__browser_take_screenshot', screenshot(String(i))))
    }
    return history
  }

  test('the marker stays on the last message as screenshots keep arriving', () => {
    const history = walk(100)
    const markers: Array<{ screens: number; marker: number; last: number }> = []
    for (let next = 100; next < 105; next++) {
      history.push(...exchange(`shot${next}`, 'mcp__playwright__browser_take_screenshot', screenshot(String(next))))
      const req = wireRequest(history, [])
      markers.push({ screens: next + 1, marker: req.markerIndex, last: req.wire.length - 1 })
    }
    expect(markers.filter(m => m.marker !== m.last)).toEqual([])
  })

  test('the render reports how many media items it dropped', () => {
    expect(wireRequest(walk(100), []).mediaStripped).toBe(0)
    expect(wireRequest(walk(103), []).mediaStripped).toBe(3)
  })

  test('the only bytes a new screenshot changes are the oldest image it pushes out', () => {
    const history = walk(101)
    const before = wireRequest(history, []).wire
    history.push(...exchange('shot101', 'mcp__playwright__browser_take_screenshot', screenshot('101')))
    const after = wireRequest(history, []).wire

    const changed = findPrefixBreak([before, after])
    expect(changed, 'the cap dropped one more image, so one message must change').not.toBeNull()
    expect(before[changed!.index]).toContain('"type":"image"')
    expect(after[changed!.index]).not.toContain('"type":"image"')
    // …and nothing after it: the rest of the history is re-sent as it was.
    const rest = (w: string[]) => w.slice(changed!.index + 1, before.length)
    expect(findPrefixBreak([rest(before), rest(after)]), describePrefixBreak(changed!)).toBeNull()
  })
})

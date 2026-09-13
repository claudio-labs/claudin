import { describe, expect, test } from 'bun:test'

import {
  computeSliceStart,
  MAX_MESSAGES_WITHOUT_VIRTUALIZATION,
  MESSAGE_CAP_STEP,
  type SliceAnchor,
} from 'src/agent/ui/sliceAnchor.js'

function msgs(n: number, prefix = 'm'): { uuid: string }[] {
  return Array.from({ length: n }, (_, i) => ({ uuid: `${prefix}${i}` }))
}

function anchorRef(initial: SliceAnchor = null): { current: SliceAnchor } {
  return { current: initial }
}

describe('computeSliceStart', () => {
  test('renders everything until the array exceeds cap + step', () => {
    const cap = MAX_MESSAGES_WITHOUT_VIRTUALIZATION
    const step = MESSAGE_CAP_STEP
    const ref = anchorRef()

    expect(computeSliceStart(msgs(cap + step), ref)).toBe(0)

    // One past the band is what advances the window — the whole point of the
    // step: a plain slice(-cap) would have started cutting at cap + 1.
    const ref2 = anchorRef()
    expect(computeSliceStart(msgs(cap + step + 1), ref2)).toBe(cap + step + 1 - cap)
  })

  test('does not slide on append once anchored', () => {
    const ref = anchorRef()
    const first = computeSliceStart(msgs(261), ref, 200, 50)
    expect(first).toBe(61)
    expect(ref.current).toEqual({ uuid: 'm61', idx: 61 })

    // Appending keeps the same first rendered message: the anchor only moves
    // when the rendered count exceeds cap + step again. This is the CC-941
    // property — a count-based slice would shift by one on every append and
    // reprint the scrollback each turn.
    for (let extra = 1; extra <= 10; extra++) {
      expect(computeSliceStart(msgs(261 + extra), ref, 200, 50)).toBe(61)
      expect(ref.current?.uuid).toBe('m61')
    }
  })

  test('advances again when the appends outgrow the band', () => {
    const ref = anchorRef()
    computeSliceStart(msgs(261), ref, 200, 50)

    // 61 rendered-from + 251 remaining = past cap + step, so it re-anchors.
    expect(computeSliceStart(msgs(312), ref, 200, 50)).toBe(112)
    expect(ref.current).toEqual({ uuid: 'm112', idx: 112 })
  })

  test('falls back to the stored index when the anchor uuid vanishes', () => {
    // Collapse regrouping can change which uuid leads a merged group, so the
    // anchored uuid can disappear without any message being removed.
    const ref = anchorRef({ uuid: 'gone', idx: 61 })

    expect(computeSliceStart(msgs(300), ref, 200, 50)).toBe(61)
    // Healed onto whatever lives at the recovered start, so the next call has
    // a uuid to find again.
    expect(ref.current).toEqual({ uuid: 'm61', idx: 61 })
  })

  test('clamps the fallback index so the window still shows cap messages', () => {
    // A stale index past `length - cap` would render fewer than cap messages
    // — and past `length` it renders NOTHING, which is what the clamp is for.
    const ref = anchorRef({ uuid: 'gone', idx: 500 })
    expect(computeSliceStart(msgs(600), ref, 200, 50)).toBe(400)

    // Rewind/compaction shrinks the array under a stale anchor index.
    const shrunk = anchorRef({ uuid: 'gone', idx: 500 })
    expect(computeSliceStart(msgs(100), shrunk, 200, 50)).toBe(0)
    expect(shrunk.current).toEqual({ uuid: 'm0', idx: 0 })
  })

  test('is idempotent within a render', () => {
    // It mutates during render, so a StrictMode double-render must not move
    // the window.
    const ref = anchorRef()
    const first = computeSliceStart(msgs(400), ref, 200, 50)
    const snapshot = { ...ref.current! }

    expect(computeSliceStart(msgs(400), ref, 200, 50)).toBe(first)
    expect(ref.current).toEqual(snapshot)
  })

  test('drops the anchor when the array empties', () => {
    const ref = anchorRef({ uuid: 'm61', idx: 61 })

    expect(computeSliceStart([], ref, 200, 50)).toBe(0)
    expect(ref.current).toBeNull()
  })
})

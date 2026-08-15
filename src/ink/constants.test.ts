import { afterEach, describe, expect, test } from 'bun:test'
import {
  FRAME_INTERVAL_MS,
  SCROLL_DRAIN_INTERVAL_MS,
  getFrameIntervalMs,
  scrollDrainIntervalMs,
  setFrameIntervalMs,
} from 'src/ink/constants.js'

// The resolved interval is a module global. Leaving it set would leak into
// every other test file in the run — see .claudin/rules/testing.md.
afterEach(() => {
  setFrameIntervalMs(FRAME_INTERVAL_MS)
})

describe('frame interval injection', () => {
  test('defaults to the 60fps base interval', () => {
    expect(getFrameIntervalMs()).toBe(FRAME_INTERVAL_MS)
  })

  test('reports what was injected', () => {
    setFrameIntervalMs(4)
    expect(getFrameIntervalMs()).toBe(4)
  })

  test('leaves FRAME_INTERVAL_MS at 16 — pinned consumers stay at 60fps', () => {
    setFrameIntervalMs(3)
    expect(FRAME_INTERVAL_MS).toBe(16)
  })

  test('clamps to 1ms so setInterval never busy-loops', () => {
    setFrameIntervalMs(0)
    expect(getFrameIntervalMs()).toBe(1)
    setFrameIntervalMs(-5)
    expect(getFrameIntervalMs()).toBe(1)
  })

  test('truncates fractional intervals to whole milliseconds', () => {
    setFrameIntervalMs(8.33)
    expect(getFrameIntervalMs()).toBe(8)
  })
})

describe('scrollDrainIntervalMs', () => {
  test('holds the 4ms floor while regular frames are slower', () => {
    expect(scrollDrainIntervalMs()).toBe(SCROLL_DRAIN_INTERVAL_MS)
    setFrameIntervalMs(8)
    expect(scrollDrainIntervalMs()).toBe(SCROLL_DRAIN_INTERVAL_MS)
  })

  test('never drains slower than a regular frame', () => {
    setFrameIntervalMs(3)
    expect(scrollDrainIntervalMs()).toBe(3)
  })
})

import { beforeEach, describe, expect, test } from 'bun:test'
import { streamingTextStore } from 'src/agent/hooks/useStreamingTextStore.js'
import { FRAME_INTERVAL_MS } from 'src/terminal/ink/constants.js'

// Real-timer waits: the store schedules with setTimeout(FRAME_INTERVAL_MS).
const FLUSH_WAIT_MS = FRAME_INTERVAL_MS * 3

describe('streamingTextStore', () => {
  beforeEach(() => {
    streamingTextStore.resetForTesting()
  })

  test('presence flip (null → text) notifies synchronously', () => {
    let notifications = 0
    streamingTextStore.subscribe(() => notifications++)

    streamingTextStore.update(() => 'hello')

    expect(notifications).toBe(1)
    expect(streamingTextStore.getSnapshot()).toBe('hello')
    expect(streamingTextStore.getPresenceSnapshot()).toBe(true)
  })

  test('presence flips notify synchronously even inside a hot frame window', async () => {
    // Regression guard for the sync-presence invariant itself. The test
    // above can't catch a presence flip wrongly routed through the
    // coalesced path: after an idle gap the leading edge fires
    // immediately anyway. Heat the window first (a notify just happened),
    // then flip presence twice within the same frame interval — each flip
    // must notify synchronously, not ride a pending/leading-edge timer.
    let notifications = 0
    streamingTextStore.subscribe(() => notifications++)

    streamingTextStore.update(() => 'a') // flip null → text (sets lastNotifyAt = now)
    expect(notifications).toBe(1)
    streamingTextStore.update(() => null) // flip text → null, window still hot
    expect(notifications).toBe(2)
    streamingTextStore.update(() => 'b') // flip null → text, window still hot
    expect(notifications).toBe(3)

    // No stray trailing notify from a timer that shouldn't exist.
    await Bun.sleep(FLUSH_WAIT_MS)
    expect(notifications).toBe(3)
  })

  test('appends are applied synchronously but notify coalesced', async () => {
    let notifications = 0
    streamingTextStore.subscribe(() => notifications++)

    streamingTextStore.update(() => 'a') // presence flip — sync notify
    streamingTextStore.update(t => `${t}b`)
    streamingTextStore.update(t => `${t}c`)

    // Value is always fresh for read()/getSnapshot…
    expect(streamingTextStore.read()).toBe('abc')
    // …but the two appends inside the frame window produced no extra notify yet.
    expect(notifications).toBe(1)

    await Bun.sleep(FLUSH_WAIT_MS)
    expect(notifications).toBe(2)
    expect(streamingTextStore.getSnapshot()).toBe('abc')
  })

  test('clear notifies synchronously and drops the pending notify', async () => {
    let notifications = 0
    streamingTextStore.subscribe(() => notifications++)

    streamingTextStore.update(() => 'a') // sync (presence)
    streamingTextStore.update(t => `${t}b`) // schedules trailing notify
    streamingTextStore.clear() // presence flip — sync, cancels timer

    expect(notifications).toBe(2)
    expect(streamingTextStore.getSnapshot()).toBeNull()
    expect(streamingTextStore.getPresenceSnapshot()).toBe(false)

    await Bun.sleep(FLUSH_WAIT_MS)
    expect(notifications).toBe(2) // no stray trailing notify
  })

  test('no-op updates do not notify', () => {
    let notifications = 0
    streamingTextStore.subscribe(() => notifications++)

    streamingTextStore.update(() => null) // null → null
    expect(notifications).toBe(0)

    streamingTextStore.update(() => 'a')
    expect(notifications).toBe(1)
    streamingTextStore.update(t => t) // identical string
    expect(notifications).toBe(1)
  })

  test('leading edge: append after an idle gap notifies immediately', async () => {
    let notifications = 0
    streamingTextStore.subscribe(() => notifications++)

    streamingTextStore.update(() => 'a')
    expect(notifications).toBe(1)

    await Bun.sleep(FLUSH_WAIT_MS) // idle past the frame interval
    streamingTextStore.update(t => `${t}b`)
    expect(notifications).toBe(2) // no 16ms wait for the first delta after idle
  })

  test('unsubscribe stops notifications', () => {
    let notifications = 0
    const unsubscribe = streamingTextStore.subscribe(() => notifications++)

    streamingTextStore.update(() => 'a')
    expect(notifications).toBe(1)

    unsubscribe()
    streamingTextStore.clear()
    expect(notifications).toBe(1)
  })
})

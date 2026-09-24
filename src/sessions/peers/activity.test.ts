import { afterEach, expect, test } from 'bun:test'

import {
  activityOf,
  getIdleSince,
  onSessionIdle,
  reportSessionActivity,
  resetSessionActivityForTests,
} from 'src/sessions/peers/activity.js'

afterEach(() => {
  resetSessionActivityForTests()
})

const tick = (ms: number) => new Promise(resolve => setTimeout(resolve, ms))

test('a session is busy while a turn runs or the main thread has work queued', () => {
  expect(activityOf({ isLoading: false, queuedForMain: 0 })).toBe('idle')
  expect(activityOf({ isLoading: true, queuedForMain: 0 })).toBe('busy')
  expect(activityOf({ isLoading: false, queuedForMain: 1 })).toBe('busy')
})

test('idle listeners hear a settled idle stretch once, with when it began', async () => {
  const heard: number[] = []
  onSessionIdle(at => heard.push(at))
  reportSessionActivity('idle', 1_000, 5)
  expect(getIdleSince()).toBe(1_000)
  reportSessionActivity('idle', 2_000, 5)
  await tick(20)
  expect(heard).toEqual([1_000])
})

test('a turn that starts inside the debounce cancels the idle notice', async () => {
  const heard: number[] = []
  onSessionIdle(at => heard.push(at))
  reportSessionActivity('idle', 1_000, 10)
  reportSessionActivity('busy', 1_001, 10)
  expect(getIdleSince()).toBeUndefined()
  await tick(30)
  expect(heard).toEqual([])
})

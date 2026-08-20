import { expect, test } from 'bun:test'
import {
  retryDelayMs,
  retryWhileNull,
  SESSION_CREATE_BACKOFF,
} from 'src/platform/bridge/retryWhileNull.ts'

// baseDelayMs: 0 makes every backoff 0ms, so the loop runs without sleeping.
const NO_SLEEP = {
  maxAttempts: 5,
  baseDelayMs: 0,
  jitterFraction: 0.25,
  maxDelayMs: 4000,
}

test('returns the first non-null result without retrying', async () => {
  let calls = 0
  const result = await retryWhileNull(
    async () => {
      calls++
      return 'session-1'
    },
    { ...NO_SLEEP, label: 'createSession' },
  )
  expect(result).toBe('session-1')
  expect(calls).toBe(1)
})

test('retries a failing call and returns the first success', async () => {
  let calls = 0
  const result = await retryWhileNull(
    async () => {
      calls++
      return calls < 4 ? null : 'session-1'
    },
    { ...NO_SLEEP, label: 'createSession' },
  )
  expect(result).toBe('session-1')
  expect(calls).toBe(4)
})

test('gives up after maxAttempts and returns null', async () => {
  let calls = 0
  const result = await retryWhileNull(
    async () => {
      calls++
      return null
    },
    { ...NO_SLEEP, label: 'createSession' },
  )
  expect(result).toBeNull()
  expect(calls).toBe(5)
})

test('stops retrying once the signal aborts', async () => {
  const controller = new AbortController()
  let calls = 0
  const result = await retryWhileNull(
    async () => {
      calls++
      if (calls === 2) controller.abort()
      return null
    },
    { ...NO_SLEEP, label: 'createSession', signal: controller.signal },
  )
  expect(result).toBeNull()
  expect(calls).toBe(2)
})

test('stops on the first attempt when isRetryable says the failure is permanent', async () => {
  let calls = 0
  const result = await retryWhileNull(
    async () => {
      calls++
      return null
    },
    { ...NO_SLEEP, label: 'createSession', isRetryable: () => false },
  )
  expect(result).toBeNull()
  expect(calls).toBe(1)
})

test('keeps retrying while isRetryable stays true', async () => {
  let calls = 0
  const result = await retryWhileNull(
    async () => {
      calls++
      return calls < 3 ? null : 'session-1'
    },
    { ...NO_SLEEP, label: 'createSession', isRetryable: () => true },
  )
  expect(result).toBe('session-1')
  expect(calls).toBe(3)
})

test('backs off exponentially and clamps at maxDelayMs', () => {
  // random() = 0.5 → zero jitter, so the raw exponential is observable.
  const noJitter = () => 0.5
  expect(retryDelayMs(1, SESSION_CREATE_BACKOFF, noJitter)).toBe(500)
  expect(retryDelayMs(2, SESSION_CREATE_BACKOFF, noJitter)).toBe(1000)
  expect(retryDelayMs(3, SESSION_CREATE_BACKOFF, noJitter)).toBe(2000)
  expect(retryDelayMs(4, SESSION_CREATE_BACKOFF, noJitter)).toBe(4000)
  expect(retryDelayMs(9, SESSION_CREATE_BACKOFF, noJitter)).toBe(4000)
})

test('jitter stays within the configured fraction', () => {
  const low = retryDelayMs(2, SESSION_CREATE_BACKOFF, () => 0)
  const high = retryDelayMs(2, SESSION_CREATE_BACKOFF, () => 1)
  expect(low).toBe(750)
  expect(high).toBe(1250)
})

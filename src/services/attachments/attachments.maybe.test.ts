import { afterEach, beforeEach, describe, expect, mock, test } from 'bun:test'

type LogCall = { eventName: string; metadata: Record<string, unknown> }
const logCalls: LogCall[] = []

mock.module('src/platform/analytics/index.js', () => ({
  logEvent: (eventName: string, metadata: Record<string, unknown>) => {
    logCalls.push({ eventName, metadata })
  },
}))

import { maybe } from 'src/services/attachments/attachments.js'

describe('maybe wrapper', () => {
  const originalRandom = Math.random

  beforeEach(() => {
    logCalls.length = 0
    Math.random = () => 0
  })

  afterEach(() => {
    Math.random = originalRandom
  })

  test('returns producer result on success', async () => {
    const result = await maybe('happy', async () => [{ a: 1 }, { a: 2 }])
    expect(result).toEqual([{ a: 1 }, { a: 2 }])
  })

  test('swallows producer errors and returns []', async () => {
    const result = await maybe('boom', async () => {
      throw new Error('producer exploded')
    })
    expect(result).toEqual([])
  })

  test('logs duration event with label on success (when sampled)', async () => {
    await maybe('label-success', async () => [{ payload: 'x' }])
    const event = logCalls.find(c => c.eventName === 'tengu_attachment_compute_duration')
    expect(event).toBeDefined()
    expect(event!.metadata.label).toBe('label-success')
    expect(event!.metadata.attachment_count).toBe(1)
    expect(typeof event!.metadata.duration_ms).toBe('number')
    expect(typeof event!.metadata.attachment_size_bytes).toBe('number')
    expect(event!.metadata.error).toBeUndefined()
  })

  test('logs duration event with error=true on failure (when sampled)', async () => {
    await maybe('label-failure', async () => {
      throw new Error('boom')
    })
    const event = logCalls.find(c => c.eventName === 'tengu_attachment_compute_duration')
    expect(event).toBeDefined()
    expect(event!.metadata.label).toBe('label-failure')
    expect(event!.metadata.error).toBe(true)
  })

  test('does not log when sampling threshold not met', async () => {
    Math.random = () => 1
    await maybe('not-sampled', async () => [{ a: 1 }])
    const event = logCalls.find(c => c.eventName === 'tengu_attachment_compute_duration')
    expect(event).toBeUndefined()
  })

  test('skips undefined/null entries when computing attachment_size_bytes', async () => {
    const result = await maybe('with-holes', async () =>
      [{ a: 1 }, undefined, null, { a: 2 }] as unknown as Array<{ a: number }>,
    )
    expect(result).toHaveLength(4)
    const event = logCalls.find(c => c.eventName === 'tengu_attachment_compute_duration')
    expect(event).toBeDefined()
    expect(event!.metadata.attachment_count).toBe(4)
  })
})

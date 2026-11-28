import { describe, expect, test } from 'bun:test'

import {
  addMonitorMcpController,
  hasMonitorMcpController,
  stopWithin,
  takeMonitorMcpController,
} from 'src/agent/tasks/MonitorMcpTask/controllers.js'

describe('the controller map', () => {
  test('take hands the controller out once', () => {
    const controller = { stop: () => {}, unregisterCleanup: () => {} }
    addMonitorMcpController('mctl1', controller)
    expect(hasMonitorMcpController('mctl1')).toBe(true)
    expect(takeMonitorMcpController('mctl1')).toBe(controller)
    expect(hasMonitorMcpController('mctl1')).toBe(false)
    expect(takeMonitorMcpController('mctl1')).toBeUndefined()
  })
})

describe('stopWithin', () => {
  test('a synchronous stop runs and settles at once', async () => {
    let calls = 0
    await stopWithin(() => {
      calls++
    }, 10_000)
    expect(calls).toBe(1)
  })

  test('waits for a stop that answers in time', async () => {
    let done = false
    await stopWithin(async () => {
      await Bun.sleep(5)
      done = true
    }, 10_000)
    expect(done).toBe(true)
  })

  test('gives up on a stop that never answers, after the budget', async () => {
    const started = Date.now()
    await stopWithin(() => new Promise<void>(() => {}), 30)
    expect(Date.now() - started).toBeGreaterThanOrEqual(25)
  })

  test('never rejects, whether stop throws or its promise rejects', async () => {
    await expect(
      stopWithin(() => {
        throw new Error('sync boom')
      }, 10),
    ).resolves.toBeUndefined()
    await expect(stopWithin(() => Promise.reject(new Error('async boom')), 10_000)).resolves.toBeUndefined()
  })
})

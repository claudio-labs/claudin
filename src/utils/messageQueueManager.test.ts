/**
 * Pre-removal regression tests for the command queue path used by cron
 * fires (useScheduledTasks → enqueuePendingNotification → drain by REPL).
 *
 * Workload tag (cc_workload routing for Anthropic 1P QoS) is being
 * removed — these tests pin the *queue* behavior so that the removal
 * leaves enqueue/dequeue/priority intact. After workload removal these
 * still pass; they just stop carrying the `workload` field through.
 */
;(globalThis as Record<string, unknown>).MACRO = {
  VERSION: '99.0.0',
  DISPLAY_VERSION: '0.0.0-test',
  BUILD_TIME: new Date().toISOString(),
  ISSUES_EXPLAINER: 'report the issue at https://github.com/anthropics/claude-code/issues',
  PACKAGE_URL: '@claudiolabs/claudin',
  NATIVE_PACKAGE_URL: undefined,
}

import { afterEach, beforeEach, describe, expect, test } from 'bun:test'

import {
  dequeue,
  enqueuePendingNotification,
  getCommandQueue,
  getCommandQueueLength,
  resetCommandQueue,
} from 'src/utils/messageQueueManager.ts'

beforeEach(() => {
  resetCommandQueue()
})

afterEach(() => {
  resetCommandQueue()
})

describe('command queue (cron-fire path)', () => {
  test('enqueuePendingNotification appends a command preserving its fields', () => {
    enqueuePendingNotification({
      value: 'run the scheduled task',
      mode: 'prompt',
      priority: 'later',
      isMeta: true,
    })
    const queue = getCommandQueue()
    expect(queue).toHaveLength(1)
    expect(queue[0]).toMatchObject({
      value: 'run the scheduled task',
      mode: 'prompt',
      priority: 'later',
      isMeta: true,
    })
  })

  test('enqueue defaults priority to "later" when omitted (cron fires use this default)', () => {
    enqueuePendingNotification({ value: 'x', mode: 'prompt' })
    expect(getCommandQueue()[0]!.priority).toBe('later')
  })

  test('dequeue returns commands in priority order; same-priority commands are FIFO', () => {
    enqueuePendingNotification({ value: 'cron-1', mode: 'prompt', priority: 'later' })
    enqueuePendingNotification({ value: 'human-1', mode: 'prompt', priority: 'now' })
    enqueuePendingNotification({ value: 'cron-2', mode: 'prompt', priority: 'later' })
    expect(getCommandQueueLength()).toBe(3)
    expect(dequeue()?.value).toBe('human-1') // priority "now" wins
    expect(dequeue()?.value).toBe('cron-1') // FIFO within "later"
    expect(dequeue()?.value).toBe('cron-2')
    expect(dequeue()).toBeUndefined()
  })
})

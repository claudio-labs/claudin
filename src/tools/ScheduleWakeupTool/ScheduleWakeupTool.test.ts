import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'

import {
  clearPendingSessionWakeup,
  getPendingSessionWakeup,
  getScheduledTasksEnabled,
  getSessionId,
  regenerateSessionId,
  setScheduledTasksEnabled,
  switchSession,
} from 'src/bootstrap/state.js'
import type { SessionId } from 'src/types/ids.js'
import { takeDueSessionWakeup } from 'src/tasks/cronScheduler.js'
import { resetLoopSentinelState } from 'src/utils/loopSentinels.js'
import {
  createTeammateContext,
  runWithTeammateContext,
} from 'src/coordinator/teammateContext.js'
import {
  clampWakeupDelaySeconds,
  WAKEUP_MAX_DELAY_SECONDS,
  WAKEUP_MIN_DELAY_SECONDS,
} from './prompt.js'
import { ScheduleWakeupTool } from './ScheduleWakeupTool.js'

let priorEnabled = false

beforeAll(() => {
  delete process.env.CLAUDE_CODE_DISABLE_CRON
  priorEnabled = getScheduledTasksEnabled()
})

afterAll(() => {
  setScheduledTasksEnabled(priorEnabled)
})

afterEach(() => {
  clearPendingSessionWakeup()
  resetLoopSentinelState()
})

describe('clampWakeupDelaySeconds', () => {
  test('clamps below the minimum up to 60', () => {
    expect(clampWakeupDelaySeconds(0)).toBe(WAKEUP_MIN_DELAY_SECONDS)
    expect(clampWakeupDelaySeconds(59)).toBe(WAKEUP_MIN_DELAY_SECONDS)
    expect(clampWakeupDelaySeconds(-100)).toBe(WAKEUP_MIN_DELAY_SECONDS)
  })

  test('clamps above the maximum down to 3600', () => {
    expect(clampWakeupDelaySeconds(3601)).toBe(WAKEUP_MAX_DELAY_SECONDS)
    expect(clampWakeupDelaySeconds(99999)).toBe(WAKEUP_MAX_DELAY_SECONDS)
    expect(clampWakeupDelaySeconds(Infinity)).toBe(WAKEUP_MAX_DELAY_SECONDS)
  })

  test('passes in-range values through (rounded to whole seconds)', () => {
    expect(clampWakeupDelaySeconds(60)).toBe(60)
    expect(clampWakeupDelaySeconds(270)).toBe(270)
    expect(clampWakeupDelaySeconds(1200.6)).toBe(1201)
    expect(clampWakeupDelaySeconds(3600)).toBe(3600)
  })

  test('falls back to the minimum on NaN (never throws)', () => {
    expect(clampWakeupDelaySeconds(Number.NaN)).toBe(WAKEUP_MIN_DELAY_SECONDS)
  })
})

describe('ScheduleWakeupTool', () => {
  test('isEnabled() follows the cron gate', () => {
    expect(ScheduleWakeupTool.isEnabled?.()).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_CRON = '1'
    try {
      expect(ScheduleWakeupTool.isEnabled?.()).toBe(false)
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_CRON
    }
  })

  test('input schema rejects unknown keys, accepts schedule and cancel shapes', () => {
    expect(
      ScheduleWakeupTool.inputSchema.safeParse({
        delaySeconds: 600,
        reason: 'watching CI run',
        prompt: '/loop check CI',
      }).success,
    ).toBe(true)
    expect(
      ScheduleWakeupTool.inputSchema.safeParse({ cancel: true }).success,
    ).toBe(true)
    expect(
      ScheduleWakeupTool.inputSchema.safeParse({
        delaySeconds: 600,
        reason: 'r',
        prompt: 'p',
        extra: 1,
      }).success,
    ).toBe(false)
  })

  test('validateInput requires delaySeconds, reason, and prompt when scheduling', async () => {
    const missingDelay = await ScheduleWakeupTool.validateInput?.(
      { reason: 'r', prompt: '/loop x' } as never,
    )
    expect(missingDelay?.result).toBe(false)

    const missingReason = await ScheduleWakeupTool.validateInput?.(
      { delaySeconds: 600, reason: '  ', prompt: '/loop x' } as never,
    )
    expect(missingReason?.result).toBe(false)

    const missingPrompt = await ScheduleWakeupTool.validateInput?.(
      { delaySeconds: 600, reason: 'r', prompt: '   ' } as never,
    )
    expect(missingPrompt?.result).toBe(false)

    const ok = await ScheduleWakeupTool.validateInput?.(
      { delaySeconds: 600, reason: 'r', prompt: '/loop x' } as never,
    )
    expect(ok?.result).toBe(true)

    // cancel needs none of them.
    const cancelOk = await ScheduleWakeupTool.validateInput?.(
      { cancel: true } as never,
    )
    expect(cancelOk?.result).toBe(true)
  })

  test('validateInput rejects teammate callers (process-global slot)', async () => {
    const ctx = createTeammateContext({
      agentId: 'researcher@team',
      agentName: 'researcher',
      teamName: 'team',
      planModeRequired: false,
      parentSessionId: 'parent',
      abortController: new AbortController(),
    })
    const result = await runWithTeammateContext(ctx, () =>
      ScheduleWakeupTool.validateInput?.(
        { delaySeconds: 600, reason: 'r', prompt: '/loop x' } as never,
      ),
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('not available to teammates')
    }
  })

  test('validateInput rejects Task/fork subagent callers (context.agentId set)', async () => {
    const result = await ScheduleWakeupTool.validateInput?.(
      { delaySeconds: 600, reason: 'r', prompt: '/loop x' } as never,
      { agentId: 'subagent-1' } as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('not available to subagents')
      expect(result.message).toContain('CronCreate')
    }

    // The lead thread (no agentId on the context) is unaffected.
    const lead = await ScheduleWakeupTool.validateInput?.(
      { delaySeconds: 600, reason: 'r', prompt: '/loop x' } as never,
      {} as never,
    )
    expect(lead?.result).toBe(true)
  })

  test('switchSession (in-process /resume) clears the pending wakeup', async () => {
    const original = getSessionId()
    await ScheduleWakeupTool.call(
      { delaySeconds: 600, reason: 'r', prompt: '/loop x' } as never,
    )
    expect(getPendingSessionWakeup()).not.toBeNull()
    try {
      // The resumed conversation never armed a loop — a surviving wakeup
      // would fire its loop prompt into the wrong transcript.
      switchSession('wakeup-resume-test-session' as SessionId)
      expect(getPendingSessionWakeup()).toBeNull()
    } finally {
      switchSession(original)
    }
  })

  test('regenerateSessionId (the /clear emit path) clears the pending wakeup', async () => {
    const original = getSessionId()
    await ScheduleWakeupTool.call(
      { delaySeconds: 600, reason: 'r', prompt: '/loop x' } as never,
    )
    expect(getPendingSessionWakeup()).not.toBeNull()
    try {
      regenerateSessionId()
      expect(getPendingSessionWakeup()).toBeNull()
    } finally {
      switchSession(original)
    }
  })

  test('call() clamps the delay instead of erroring', async () => {
    const low = await ScheduleWakeupTool.call(
      { delaySeconds: 5, reason: 'too eager', prompt: '/loop x' } as never,
    )
    expect(low.data.delaySeconds).toBe(WAKEUP_MIN_DELAY_SECONDS)

    const high = await ScheduleWakeupTool.call(
      { delaySeconds: 90000, reason: 'too sleepy', prompt: '/loop x' } as never,
    )
    expect(high.data.delaySeconds).toBe(WAKEUP_MAX_DELAY_SECONDS)
  })

  test('call() stores the pending wakeup and enables the scheduler', async () => {
    setScheduledTasksEnabled(false)
    const before = Date.now()
    const { data } = await ScheduleWakeupTool.call(
      {
        delaySeconds: 600,
        reason: 'watching CI run',
        prompt: '/loop check CI',
      } as never,
    )
    const after = Date.now()

    expect(data.action).toBe('scheduled')
    expect(data.replaced).toBe(false)
    expect(data.fireAtMs).toBeGreaterThanOrEqual(before + 600_000)
    expect(data.fireAtMs).toBeLessThanOrEqual(after + 600_000)
    expect(getScheduledTasksEnabled()).toBe(true)

    const pending = getPendingSessionWakeup()
    expect(pending).not.toBeNull()
    expect(pending?.prompt).toBe('/loop check CI')
    expect(pending?.reason).toBe('watching CI run')
    expect(pending?.fireAtMs).toBe(data.fireAtMs!)
  })

  test('calling again replaces the pending wakeup (only one alive)', async () => {
    const first = await ScheduleWakeupTool.call(
      { delaySeconds: 600, reason: 'first', prompt: '/loop a' } as never,
    )
    expect(first.data.replaced).toBe(false)

    const second = await ScheduleWakeupTool.call(
      { delaySeconds: 1200, reason: 'second', prompt: '/loop b' } as never,
    )
    expect(second.data.replaced).toBe(true)

    const pending = getPendingSessionWakeup()
    expect(pending?.prompt).toBe('/loop b')
    expect(pending?.reason).toBe('second')
    expect(pending?.fireAtMs).toBe(second.data.fireAtMs!)
  })

  test('cancel: true clears the pending wakeup', async () => {
    await ScheduleWakeupTool.call(
      { delaySeconds: 600, reason: 'r', prompt: '/loop x' } as never,
    )
    expect(getPendingSessionWakeup()).not.toBeNull()

    const cancelled = await ScheduleWakeupTool.call({ cancel: true } as never)
    expect(cancelled.data.action).toBe('cancelled')
    expect(cancelled.data.hadPending).toBe(true)
    expect(getPendingSessionWakeup()).toBeNull()

    // Cancelling again is a safe no-op.
    const again = await ScheduleWakeupTool.call({ cancel: true } as never)
    expect(again.data.hadPending).toBe(false)
  })

  test('takeDueSessionWakeup fires the prompt exactly once when due', async () => {
    const { data } = await ScheduleWakeupTool.call(
      {
        delaySeconds: 600,
        reason: 'watching CI',
        prompt: '/loop check CI',
      } as never,
    )

    // Not due yet — nothing fires, slot stays pending.
    expect(takeDueSessionWakeup(data.fireAtMs! - 1)).toBeNull()
    expect(getPendingSessionWakeup()).not.toBeNull()

    // Due — fires the stored prompt (plus the reason for the transcript
    // marker) and clears the slot.
    const fired = takeDueSessionWakeup(data.fireAtMs!)
    expect(fired?.prompt).toBe('/loop check CI')
    expect(fired?.reason).toBe('watching CI')
    expect(getPendingSessionWakeup()).toBeNull()

    // Exactly once — a second tick sees nothing.
    expect(takeDueSessionWakeup(data.fireAtMs! + 1000)).toBeNull()
  })

  test('a replaced wakeup never fires — only the latest one does', async () => {
    await ScheduleWakeupTool.call(
      { delaySeconds: 60, reason: 'old', prompt: '/loop old' } as never,
    )
    const second = await ScheduleWakeupTool.call(
      { delaySeconds: 3600, reason: 'new', prompt: '/loop new' } as never,
    )

    // At the old fire time the replacement is not yet due.
    expect(takeDueSessionWakeup(Date.now() + 61_000)).toBeNull()
    // At the new fire time the latest prompt fires.
    expect(takeDueSessionWakeup(second.data.fireAtMs!)?.prompt).toBe(
      '/loop new',
    )
  })

  test('tool result confirms fire time, reason, replacement, and cancellation', () => {
    const map = ScheduleWakeupTool.mapToolResultToToolResultBlockParam
    const fresh = map?.(
      {
        action: 'scheduled',
        fireAtMs: 0,
        fireAt: '3:25:00 PM',
        delaySeconds: 1200,
        reason: 'watching CI run',
        replaced: false,
      },
      'u1',
    )
    expect(fresh?.content).toContain('3:25:00 PM')
    expect(fresh?.content).toContain('in 1200s')
    expect(fresh?.content).toContain('watching CI run')
    expect(fresh?.content).not.toContain('Replaced the previously pending')

    const replaced = map?.(
      {
        action: 'scheduled',
        fireAtMs: 0,
        fireAt: '3:25:00 PM',
        delaySeconds: 600,
        reason: 'r',
        replaced: true,
      },
      'u2',
    )
    expect(replaced?.content).toContain(
      'Replaced the previously pending wakeup',
    )

    const cancelled = map?.({ action: 'cancelled', hadPending: true }, 'u3')
    expect(cancelled?.content).toContain('Cancelled the pending wakeup')

    const noop = map?.({ action: 'cancelled', hadPending: false }, 'u4')
    expect(noop?.content).toContain('No wakeup was pending')
  })
})

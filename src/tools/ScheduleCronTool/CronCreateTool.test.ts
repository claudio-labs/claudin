import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getScheduledTasksEnabled,
  getSessionCronTasks,
  removeSessionCronTasks,
  setScheduledTasksEnabled,
} from '../../bootstrap/state.js'
import { CronCreateTool } from './CronCreateTool.js'

let configDir: string
let priorEnabled = false

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'croncreate-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CODE_DISABLE_CRON
  priorEnabled = getScheduledTasksEnabled()
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.CLAUDIN_CONFIG_DIR
  setScheduledTasksEnabled(priorEnabled)
})

afterEach(() => {
  removeSessionCronTasks(getSessionCronTasks().map(t => t.id))
})

describe('CronCreateTool', () => {
  test('isEnabled() is true when cron is not disabled by env', () => {
    expect(CronCreateTool.isEnabled?.()).toBe(true)
  })

  test('isEnabled() is false when CLAUDE_CODE_DISABLE_CRON=1', () => {
    process.env.CLAUDE_CODE_DISABLE_CRON = '1'
    try {
      expect(CronCreateTool.isEnabled?.()).toBe(false)
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_CRON
    }
  })

  test('input schema requires cron and prompt', () => {
    expect(CronCreateTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      CronCreateTool.inputSchema.safeParse({ cron: '* * * * *' }).success,
    ).toBe(false)
    expect(
      CronCreateTool.inputSchema.safeParse({
        cron: '* * * * *',
        prompt: 'hi',
      }).success,
    ).toBe(true)
  })

  test('input schema rejects unknown keys', () => {
    expect(
      CronCreateTool.inputSchema.safeParse({
        cron: '* * * * *',
        prompt: 'hi',
        extra: 1,
      }).success,
    ).toBe(false)
  })

  test('toAutoClassifierInput joins cron and prompt', () => {
    expect(
      CronCreateTool.toAutoClassifierInput?.({
        cron: '* * * * *',
        prompt: 'wake up',
      } as never),
    ).toBe('* * * * *: wake up')
  })

  test('validateInput rejects malformed cron expression', async () => {
    const result = await CronCreateTool.validateInput?.(
      { cron: 'not a cron', prompt: 'p' } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(1)
    }
  })

  test('validateInput rejects valid syntax that never matches', async () => {
    // Feb 30 never exists
    const result = await CronCreateTool.validateInput?.(
      { cron: '0 0 30 2 *', prompt: 'p' } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(2)
    }
  })

  test('validateInput passes for a sound cron expression', async () => {
    const result = await CronCreateTool.validateInput?.(
      { cron: '*/5 * * * *', prompt: 'p' } as never,
      {} as never,
    )
    expect(result?.result).toBe(true)
  })

  test('call() creates a session-only task and enables the scheduler', async () => {
    setScheduledTasksEnabled(false)
    const { data } = await CronCreateTool.call(
      {
        cron: '*/5 * * * *',
        prompt: 'remind me',
        recurring: true,
        durable: false,
      } as never,
      {} as never,
    )
    expect(typeof data.id).toBe('string')
    expect(data.id.length).toBeGreaterThan(0)
    expect(data.recurring).toBe(true)
    expect(data.durable).toBe(false)
    expect(getScheduledTasksEnabled()).toBe(true)
    expect(getSessionCronTasks().some(t => t.id === data.id)).toBe(true)
  })

  test('mapToolResultToToolResultBlockParam describes recurring vs one-shot', () => {
    const map = CronCreateTool.mapToolResultToToolResultBlockParam
    const recurring = map?.(
      {
        id: 'abc',
        humanSchedule: 'every minute',
        recurring: true,
        durable: false,
      },
      'u1',
    )
    expect(recurring?.content).toContain('Scheduled recurring job abc')
    expect(recurring?.content).toContain('Session-only')

    const oneShot = map?.(
      {
        id: 'def',
        humanSchedule: 'at noon',
        recurring: false,
        durable: true,
      },
      'u2',
    )
    expect(oneShot?.content).toContain('one-shot task def')
    expect(oneShot?.content).toContain('Persisted')
  })
})

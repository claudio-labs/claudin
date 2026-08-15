import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  addSessionCronTask,
  getSessionCronTasks,
  removeSessionCronTasks,
} from 'src/platform/bootstrap/state.js'
import { CronDeleteTool } from 'src/tools/ScheduleCronTool/CronDeleteTool.js'

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'crondelete-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
  delete process.env.CLAUDE_CODE_DISABLE_CRON
})

afterAll(() => {
  rmSync(configDir, { recursive: true, force: true })
  delete process.env.CLAUDIN_CONFIG_DIR
})

afterEach(() => {
  removeSessionCronTasks(getSessionCronTasks().map(t => t.id))
})

describe('CronDeleteTool', () => {
  test('isEnabled() follows the cron kill switch', () => {
    expect(CronDeleteTool.isEnabled?.()).toBe(true)
    process.env.CLAUDE_CODE_DISABLE_CRON = '1'
    try {
      expect(CronDeleteTool.isEnabled?.()).toBe(false)
    } finally {
      delete process.env.CLAUDE_CODE_DISABLE_CRON
    }
  })

  test('input schema requires id and rejects unknown keys', () => {
    expect(CronDeleteTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      CronDeleteTool.inputSchema.safeParse({ id: 'a', extra: 1 }).success,
    ).toBe(false)
    expect(CronDeleteTool.inputSchema.safeParse({ id: 'a' }).success).toBe(true)
  })

  test('toAutoClassifierInput returns the id', () => {
    expect(CronDeleteTool.toAutoClassifierInput?.({ id: 'abc' } as never)).toBe(
      'abc',
    )
  })

  test('validateInput rejects unknown id', async () => {
    const result = await CronDeleteTool.validateInput?.(
      { id: 'nope' } as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.errorCode).toBe(1)
    }
  })

  test('validateInput accepts existing session task', async () => {
    addSessionCronTask({
      id: 'sess-1',
      cron: '* * * * *',
      prompt: 'p',
      createdAt: Date.now(),
    })
    const result = await CronDeleteTool.validateInput?.(
      { id: 'sess-1' } as never,
    )
    expect(result?.result).toBe(true)
  })

  test('call() removes the session task and returns its id', async () => {
    addSessionCronTask({
      id: 'sess-2',
      cron: '* * * * *',
      prompt: 'p',
      createdAt: Date.now(),
    })
    expect(getSessionCronTasks().some(t => t.id === 'sess-2')).toBe(true)

    const { data } = await CronDeleteTool.call(
      { id: 'sess-2' } as never,
    )
    expect(data.id).toBe('sess-2')
    expect(getSessionCronTasks().some(t => t.id === 'sess-2')).toBe(false)
  })

  test('mapToolResultToToolResultBlockParam reports cancellation', () => {
    const block = CronDeleteTool.mapToolResultToToolResultBlockParam?.(
      { id: 'abc' },
      'u1',
    )
    expect(block?.content).toBe('Cancelled job abc.')
  })
})

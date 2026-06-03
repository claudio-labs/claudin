import { afterAll, afterEach, beforeAll, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  addSessionCronTask,
  getSessionCronTasks,
  removeSessionCronTasks,
} from '../../bootstrap/state.js'
import { CronListTool } from './CronListTool.js'

let configDir: string

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'cronlist-'))
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

describe('CronListTool', () => {
  test('flags: read-only, concurrency-safe, defer, isEnabled', () => {
    expect(CronListTool.isReadOnly?.()).toBe(true)
    expect(CronListTool.isConcurrencySafe?.()).toBe(true)
    expect(CronListTool.shouldDefer).toBe(true)
    expect(CronListTool.isEnabled?.()).toBe(true)
  })

  test('input schema is strict empty object', () => {
    expect(CronListTool.inputSchema.safeParse({}).success).toBe(true)
    expect(CronListTool.inputSchema.safeParse({ x: 1 }).success).toBe(false)
  })

  test('call() returns empty job list when nothing is scheduled', async () => {
    const { data } = await CronListTool.call({} as never, {} as never)
    expect(data.jobs).toEqual([])
  })

  test('call() lists session tasks marked as non-durable', async () => {
    addSessionCronTask({
      id: 'sess-1',
      cron: '*/5 * * * *',
      prompt: 'hi',
      createdAt: Date.now(),
      recurring: true,
    })
    const { data } = await CronListTool.call({} as never, {} as never)
    const job = data.jobs.find(j => j.id === 'sess-1')
    expect(job).toBeDefined()
    expect(job?.recurring).toBe(true)
    expect(job?.durable).toBe(false)
    expect(job?.cron).toBe('*/5 * * * *')
    expect(typeof job?.humanSchedule).toBe('string')
  })

  test('mapToolResultToToolResultBlockParam renders empty and populated states', () => {
    const map = CronListTool.mapToolResultToToolResultBlockParam
    expect(map?.({ jobs: [] }, 'u')?.content).toBe('No scheduled jobs.')

    const block = map?.(
      {
        jobs: [
          {
            id: 'abc',
            cron: '*/5 * * * *',
            humanSchedule: 'every 5 minutes',
            prompt: 'do thing',
            recurring: true,
            durable: false,
          },
        ],
      },
      'u',
    )
    expect(block?.content).toContain('abc')
    expect(block?.content).toContain('every 5 minutes')
    expect(block?.content).toContain('(recurring)')
    expect(block?.content).toContain('[session-only]')
    expect(block?.content).toContain('do thing')
  })
})

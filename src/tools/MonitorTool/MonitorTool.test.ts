import { describe, expect, test } from 'bun:test'

import { MonitorTool } from './MonitorTool.js'

describe('MonitorTool', () => {
  test('isConcurrencySafe is true and userFacingName is Monitor', () => {
    expect(MonitorTool.isConcurrencySafe?.()).toBe(true)
    expect(MonitorTool.userFacingName()).toBe('Monitor')
  })

  test('input schema requires command and description', () => {
    expect(MonitorTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      MonitorTool.inputSchema.safeParse({ command: 'ls' }).success,
    ).toBe(false)
    expect(
      MonitorTool.inputSchema.safeParse({
        command: 'ls',
        description: 'list files',
      }).success,
    ).toBe(true)
  })

  test('input schema rejects unknown keys (strict)', () => {
    expect(
      MonitorTool.inputSchema.safeParse({
        command: 'ls',
        description: 'd',
        extra: 1,
      }).success,
    ).toBe(false)
  })

  test('toAutoClassifierInput returns the raw command', () => {
    expect(
      MonitorTool.toAutoClassifierInput?.({
        command: 'ls /tmp',
        description: 'list',
      } as never),
    ).toBe('ls /tmp')
  })

  test('description() falls back when input omits a description', async () => {
    expect(await MonitorTool.description({ command: 'ls' } as never)).toBe(
      'Monitor shell command',
    )
    expect(
      await MonitorTool.description({
        command: 'ls',
        description: 'list files',
      } as never),
    ).toBe('list files')
  })

  test('getToolUseSummary prefers description, falls back to command', () => {
    expect(
      MonitorTool.getToolUseSummary?.({
        command: 'ls',
        description: 'list files',
      } as never),
    ).toBe('list files')
    expect(
      MonitorTool.getToolUseSummary?.({ command: 'ls' } as never),
    ).toBe('ls')
  })

  test('getActivityDescription frames description as "Monitoring X"', () => {
    expect(
      MonitorTool.getActivityDescription?.({
        command: 'ls',
        description: 'logs',
      } as never),
    ).toBe('Monitoring logs')
    expect(MonitorTool.getActivityDescription?.({} as never)).toBe(
      'Starting monitor',
    )
  })

  test('mapToolResultToToolResultBlockParam references the task id and output path', () => {
    const block = MonitorTool.mapToolResultToToolResultBlockParam?.(
      { taskId: 'tsk_1', outputFile: '/tmp/out.log' },
      'u1',
    )
    expect(block?.content).toContain('tsk_1')
    expect(block?.content).toContain('/tmp/out.log')
    expect(block?.content).toContain('TaskStop')
  })
})

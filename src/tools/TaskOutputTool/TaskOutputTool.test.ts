import { describe, expect, test } from 'bun:test'

import type { ToolUseContext } from 'src/tools/Tool.js'
import { TaskOutputTool } from 'src/tools/TaskOutputTool/TaskOutputTool.js'

function makeCtx(appState: Record<string, unknown>): ToolUseContext {
  return {
    abortController: new AbortController(),
    getAppState: () => appState,
    setAppState: () => {},
    options: {},
  } as unknown as ToolUseContext
}

describe('TaskOutputTool', () => {
  test('aliases preserve renamed legacy tool names', () => {
    expect(TaskOutputTool.aliases).toEqual(
      expect.arrayContaining(['AgentOutputTool', 'BashOutputTool']),
    )
  })

  test('input schema enforces task_id and clamps timeout range', () => {
    expect(TaskOutputTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      TaskOutputTool.inputSchema.safeParse({
        task_id: '1',
        timeout: -1,
      }).success,
    ).toBe(false)
    expect(
      TaskOutputTool.inputSchema.safeParse({
        task_id: '1',
        timeout: 600_001,
      }).success,
    ).toBe(false)
    const ok = TaskOutputTool.inputSchema.safeParse({ task_id: '1' })
    expect(ok.success).toBe(true)
    if (ok.success) {
      expect(ok.data.block).toBe(true)
      expect(ok.data.timeout).toBe(30_000)
    }
  })

  test('isReadOnly() and isEnabled() are true', () => {
    expect(TaskOutputTool.isReadOnly?.({} as never)).toBe(true)
    expect(TaskOutputTool.isEnabled?.()).toBe(true)
  })

  test('validateInput rejects missing or unknown task_id', async () => {
    const missing = await TaskOutputTool.validateInput?.(
      { task_id: '' } as never,
      makeCtx({ tasks: {} }),
    )
    expect(missing && missing.result === false && missing.message).toContain(
      'Task ID is required',
    )

    const unknown = await TaskOutputTool.validateInput?.(
      { task_id: 'nope' } as never,
      makeCtx({ tasks: {} }),
    )
    expect(unknown && unknown.result === false && unknown.message).toContain(
      'No task found',
    )
  })

  test('validateInput accepts known task', async () => {
    const result = await TaskOutputTool.validateInput?.(
      { task_id: 'a' } as never,
      makeCtx({
        tasks: { a: { id: 'a', status: 'completed', type: 'local_bash' } },
      }),
    )
    expect(result?.result).toBe(true)
  })

  test('call() throws when task is gone from app state', async () => {
    await expect(
      TaskOutputTool.call(
        { task_id: 'missing', block: false, timeout: 1000 } as never,
        makeCtx({ tasks: {} }),
        undefined as never,
        undefined as never,
      ),
    ).rejects.toThrow('No task found')
  })

  test('non-blocking call() reports not_ready for running task', async () => {
    const ctx = makeCtx({
      tasks: {
        a: {
          id: 'a',
          status: 'running',
          type: 'local_bash',
          description: 'sleep 9',
          shellCommand: undefined,
        },
      },
    })
    const { data } = await TaskOutputTool.call(
      { task_id: 'a', block: false, timeout: 1000 } as never,
      ctx,
      undefined as never,
      undefined as never,
    )
    expect(data.retrieval_status).toBe('not_ready')
    expect(data.task?.status).toBe('running')
  })

  // The wiring, not the filter — `filterBashTaskOutput.test.ts` owns the
  // filtering rules. What this pins is that the model-facing mapper actually
  // calls it, and only for a shell task. A backgrounded run skips the Bash
  // filter at execution time, so this mapper is the single place its output is
  // trimmed before it reaches the model.
  describe('mapToolResultToToolResultBlockParam — the background filter lane', () => {
    const NOISY = [
      '\x1b[32mstarting\x1b[0m',
      ...Array.from({ length: 40 }, () => 'waiting for lock'),
      'done',
    ].join('\n')

    function mapped(task: Record<string, unknown>): string {
      const block = TaskOutputTool.mapToolResultToToolResultBlockParam?.(
        { retrieval_status: 'success', task } as never,
        'toolu_1',
      )
      return typeof block?.content === 'string' ? block.content : ''
    }

    const BASH_TASK = {
      task_id: 'a',
      task_type: 'local_bash',
      status: 'completed',
      description: 'install',
      output: NOISY,
      exitCode: 0,
      command: 'some-unregistered-cmd',
    }

    test('a shell task is filtered on the way out', () => {
      const content = mapped(BASH_TASK)
      expect(content).toContain('<bash-output-filtered')
      expect(content).not.toContain('\x1b[32m')
      expect(content.length).toBeLessThan(NOISY.length)
      expect(content).toContain('done')
    })

    test('a task with no command passes through unfiltered', () => {
      const content = mapped({ ...BASH_TASK, command: undefined })
      expect(content).toContain('\x1b[32m')
    })

    test('a non-shell task is left alone', () => {
      const content = mapped({ ...BASH_TASK, task_type: 'local_agent' })
      expect(content).toContain('\x1b[32m')
    })
  })
})

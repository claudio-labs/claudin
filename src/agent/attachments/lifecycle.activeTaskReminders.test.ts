import { describe, expect, test } from 'bun:test'
import { getActiveBackgroundTaskReminders } from 'src/agent/attachments/lifecycle.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

function makeContext(args: {
  agentId?: string
  tasks: Record<string, unknown>
}): ToolUseContext {
  return {
    agentId: args.agentId,
    options: {
      tools: [],
      mcpClients: [],
      agentDefinitions: { activeAgents: [] },
      mainLoopModel: 'test-model',
    },
    getAppState: () => ({
      toolPermissionContext: {},
      mcp: { commands: [] },
      tasks: args.tasks,
    }),
    setAppState: () => {},
    readFileState: new Map(),
  } as unknown as ToolUseContext
}

const baseShell = {
  type: 'local_bash' as const,
  id: 'bash_dev',
  status: 'running' as const,
  command: 'bun run dev:grpc',
  description: 'gRPC dev server',
  isBackgrounded: true,
  lastReportedTotalLines: 0,
  completionStatusSentInAttachment: false,
  shellCommand: null,
}

const baseAgent = {
  type: 'local_agent' as const,
  id: 'agent_xyz',
  status: 'running' as const,
  description: 'explore auth code',
  agentId: 'agent_xyz',
}

describe('getActiveBackgroundTaskReminders', () => {
  test('emits task_status for a backgrounded shell not owned by current agent', async () => {
    const ctx = makeContext({ tasks: { bash_dev: { ...baseShell } } })
    const out = await getActiveBackgroundTaskReminders(ctx, [])
    expect(out).toHaveLength(1)
    const a = out[0]!
    expect(a.type).toBe('task_status')
    if (a.type === 'task_status') {
      expect(a.taskType).toBe('local_bash')
      expect(a.taskId).toBe('bash_dev')
      expect(a.status).toBe('running')
      expect(a.command).toBe('bun run dev:grpc')
    }
  })

  test('skips foreground shells (isBackgrounded=false)', async () => {
    const ctx = makeContext({
      tasks: { bash_x: { ...baseShell, isBackgrounded: false } },
    })
    expect(await getActiveBackgroundTaskReminders(ctx, [])).toEqual([])
  })

  test('skips pending and completed tasks', async () => {
    const ctx = makeContext({
      tasks: {
        a: { ...baseShell, id: 'a', status: 'pending' },
        b: { ...baseShell, id: 'b', status: 'completed' },
        c: { ...baseShell, id: 'c', status: 'failed' },
      },
    })
    expect(await getActiveBackgroundTaskReminders(ctx, [])).toEqual([])
  })

  test('skips tasks owned by the current agent', async () => {
    const ctx = makeContext({
      agentId: 'agent_xyz',
      tasks: { bash_dev: { ...baseShell, agentId: 'agent_xyz' } },
    })
    expect(await getActiveBackgroundTaskReminders(ctx, [])).toEqual([])
  })

  test('emits task_status for a running local_agent', async () => {
    const ctx = makeContext({ tasks: { agent_xyz: { ...baseAgent } } })
    const out = await getActiveBackgroundTaskReminders(ctx, [])
    expect(out).toHaveLength(1)
    if (out[0]!.type === 'task_status') {
      expect(out[0]!.taskType).toBe('local_agent')
      expect(out[0]!.command).toBeUndefined()
    }
  })

  test('truncates very long commands', async () => {
    const longCmd = 'echo ' + 'x'.repeat(2000)
    const ctx = makeContext({
      tasks: { bash_dev: { ...baseShell, command: longCmd } },
    })
    const out = await getActiveBackgroundTaskReminders(ctx, [])
    expect(out).toHaveLength(1)
    if (out[0]!.type === 'task_status') {
      expect(out[0]!.command!.length).toBeLessThan(longCmd.length)
      expect(out[0]!.command).toContain('… [truncated]')
    }
  })

  test('truncates a huge description (inline bash heredoc with no label)', async () => {
    const huge = 'x'.repeat(50_000)
    const ctx = makeContext({
      tasks: {
        bash_dev: { ...baseShell, command: huge, description: undefined as unknown as string },
      },
    })
    const out = await getActiveBackgroundTaskReminders(ctx, [])
    expect(out).toHaveLength(1)
    if (out[0]!.type === 'task_status') {
      expect(out[0]!.description!.length).toBeLessThan(huge.length)
      expect(out[0]!.description).toContain('… [truncated]')
    }
  })

  test('emits one reminder per active task when mixing local_bash and local_agent', async () => {
    const ctx = makeContext({
      tasks: {
        bash_dev: { ...baseShell },
        agent_xyz: { ...baseAgent },
      },
    })
    const out = await getActiveBackgroundTaskReminders(ctx, [])
    expect(out).toHaveLength(2)
    const byType = new Map(
      out.flatMap(a => (a.type === 'task_status' ? [[a.taskType, a]] : [])),
    )
    expect(byType.get('local_bash')).toBeDefined()
    expect(byType.get('local_agent')).toBeDefined()
  })

  test('skips a task whose id was mentioned in tool_results since last human turn', async () => {
    const messages = [
      {
        type: 'user',
        isMeta: false,
        message: { content: 'restart the dev server' },
      },
      {
        type: 'assistant',
        message: {
          content: [
            { type: 'tool_use', name: 'Bash', input: { command: 'bun run dev:grpc' } },
          ],
        },
      },
      {
        type: 'user',
        isMeta: false,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'Command running in background with ID: bash_dev. Output is being written to: /tmp/bash_dev.log',
            },
          ],
        },
      },
    ]
    const ctx = makeContext({ tasks: { bash_dev: { ...baseShell } } })
    const out = await getActiveBackgroundTaskReminders(ctx, messages as any)
    expect(out).toEqual([])
  })

  test('emits for main-thread task viewed by main thread (both agentId undefined)', async () => {
    // Regression: an earlier filter `task.agentId === toolUseContext.agentId`
    // treated (undefined === undefined) as "owner viewing own task" and dropped
    // the reminder. Main thread tasks viewed by main thread MUST emit.
    const ctx = makeContext({
      tasks: { bash_dev: { ...baseShell, agentId: undefined } },
    })
    const out = await getActiveBackgroundTaskReminders(ctx, [])
    expect(out).toHaveLength(1)
  })

  test('emits for sub-agent-owned task viewed by main thread', async () => {
    const ctx = makeContext({
      tasks: { bash_dev: { ...baseShell, agentId: 'agent_other' } },
    })
    const out = await getActiveBackgroundTaskReminders(ctx, [])
    expect(out).toHaveLength(1)
  })

  test('emits for main-thread task viewed by a sub-agent', async () => {
    const ctx = makeContext({
      agentId: 'agent_sub',
      tasks: { bash_dev: { ...baseShell, agentId: undefined } },
    })
    const out = await getActiveBackgroundTaskReminders(ctx, [])
    expect(out).toHaveLength(1)
  })

  test('does NOT false-positive when a substring of the taskId appears in tool output', async () => {
    // Bug: JSON.stringify(...).includes('bash_dev') matched
    // "bash_dev_helper.ts" in a Grep output. Word-boundary regex must avoid this.
    const messages = [
      {
        type: 'user',
        isMeta: false,
        message: { content: 'search the repo' },
      },
      {
        type: 'assistant',
        message: {
          content: [{ type: 'tool_use', id: 'tu_1', name: 'Grep', input: { pattern: 'foo' } }],
        },
      },
      {
        type: 'user',
        isMeta: false,
        message: {
          content: [
            {
              type: 'tool_result',
              tool_use_id: 'tu_1',
              content: 'src/utils/bash_dev_helper.ts:42: match\nsrc/bash_devops.ts:7: match',
            },
          ],
        },
      },
    ]
    const ctx = makeContext({ tasks: { bash_dev: { ...baseShell } } })
    const out = await getActiveBackgroundTaskReminders(ctx, messages as any)
    expect(out).toHaveLength(1)
  })

  test('suppresses when a compact-injected task_status attachment exists for the same taskId', async () => {
    // After compaction, createAsyncAgentAttachmentsIfNeeded injects task_status
    // attachments to preserve the spawn mapping. The next user prompt then
    // follows. Without an attachment-scan pass, we would re-emit a duplicate
    // task_status reminder this turn.
    const messages = [
      {
        type: 'attachment',
        attachment: {
          type: 'task_status',
          taskId: 'bash_dev',
          taskType: 'local_bash',
          status: 'running',
          description: 'gRPC dev server',
          deltaSummary: null,
        },
      },
      {
        type: 'user',
        isMeta: false,
        message: { content: 'what is the status of the dev server?' },
      },
    ]
    const ctx = makeContext({ tasks: { bash_dev: { ...baseShell } } })
    const out = await getActiveBackgroundTaskReminders(ctx, messages as any)
    expect(out).toEqual([])
  })

  test('emits when the id is only mentioned BEFORE the last human turn', async () => {
    const messages = [
      {
        type: 'user',
        isMeta: false,
        message: {
          content: [
            { type: 'tool_result', tool_use_id: 'tu_1', content: 'bash_dev started' },
          ],
        },
      },
      {
        type: 'user',
        isMeta: false,
        message: { content: 'now do something else' },
      },
    ]
    const ctx = makeContext({ tasks: { bash_dev: { ...baseShell } } })
    const out = await getActiveBackgroundTaskReminders(ctx, messages as any)
    expect(out).toHaveLength(1)
  })
})

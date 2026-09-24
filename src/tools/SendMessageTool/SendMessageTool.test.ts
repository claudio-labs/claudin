import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

import {
  getCommandQueueSnapshot,
  resetCommandQueue,
} from 'src/agent/messageQueueManager.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import {
  inputSchemaFor,
  SendMessageTool,
} from 'src/tools/SendMessageTool/SendMessageTool.js'

// An unknown name is looked up among the other sessions on this machine, so
// point the session directory somewhere empty rather than at the developer's.
let configDir: string
const savedConfigDir = process.env.CLAUDIN_CONFIG_DIR

beforeAll(() => {
  configDir = mkdtempSync(join(tmpdir(), 'send-message-'))
  process.env.CLAUDIN_CONFIG_DIR = configDir
})

afterAll(() => {
  if (savedConfigDir === undefined) delete process.env.CLAUDIN_CONFIG_DIR
  else process.env.CLAUDIN_CONFIG_DIR = savedConfigDir
  rmSync(configDir, { recursive: true, force: true })
})

beforeEach(() => {
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  delete process.env.CLAUDIN_DISABLE_SEND_MESSAGE
})

afterEach(() => {
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
  delete process.env.CLAUDIN_DISABLE_SEND_MESSAGE
  resetCommandQueue()
})

function withTeams(): void {
  process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
}

type FakeTask = {
  type: 'local_agent'
  agentType: string
  description: string
  isBackgrounded: boolean
}

function makeContext({
  agentId,
  tasks = {},
  names = new Map<string, string>(),
}: {
  agentId?: string
  tasks?: Record<string, FakeTask>
  names?: Map<string, string>
}): ToolUseContext {
  return {
    agentId,
    getAppState: () => ({ tasks, agentNameRegistry: names }),
  } as unknown as ToolUseContext
}

function backgroundAgent(description: string): FakeTask {
  return {
    type: 'local_agent',
    agentType: 'Code',
    description,
    isBackgrounded: true,
  }
}

async function send(
  input: Record<string, unknown>,
  context: ToolUseContext,
): Promise<unknown> {
  const result = await SendMessageTool.call(
    input as never,
    context,
    (() => {}) as never,
    undefined as never,
  )
  return result.data
}

describe('SendMessageTool', () => {
  test('userFacingName is SendMessage and shouldDefer is true', () => {
    expect(SendMessageTool.userFacingName(undefined)).toBe('SendMessage')
    expect(SendMessageTool.shouldDefer).toBe(true)
  })

  test('isEnabled() is on without agent teams; the killswitch only acts outside one', () => {
    expect(SendMessageTool.isEnabled?.()).toBe(true)

    process.env.CLAUDIN_DISABLE_SEND_MESSAGE = '1'
    expect(SendMessageTool.isEnabled?.()).toBe(false)

    withTeams()
    expect(SendMessageTool.isEnabled?.()).toBe(true)
  })

  test('isReadOnly() is true only for plain-text messages', () => {
    expect(
      SendMessageTool.isReadOnly?.({
        to: 'alice',
        summary: 'hi',
        message: 'hello',
      } as never),
    ).toBe(true)
    expect(
      SendMessageTool.isReadOnly?.({
        to: 'alice',
        message: { type: 'shutdown_request' },
      } as never),
    ).toBe(false)
  })

  test('the input schema offers structured messages only to agent teams', () => {
    const structured = {
      to: 'team-lead',
      message: { type: 'shutdown_response', request_id: 'r', approve: true },
    }
    const plain = inputSchemaFor({ swarm: false, crossSession: true })
    const team = inputSchemaFor({ swarm: true, crossSession: true })
    expect(plain.safeParse({}).success).toBe(false)
    expect(plain.safeParse({ to: 'alice', message: 'hi' }).success).toBe(true)
    expect(plain.safeParse(structured).success).toBe(false)
    expect(team.safeParse(structured).success).toBe(true)
    // Each variant is built once, so the schema bytes stay stable.
    expect(inputSchemaFor({ swarm: false, crossSession: true })).toBe(plain)
    // Unknown structured type rejected
    expect(
      team.safeParse({
        to: 'alice',
        message: { type: 'bogus' },
      }).success,
    ).toBe(false)
  })

  test('toAutoClassifierInput handles strings and each structured branch', () => {
    expect(
      SendMessageTool.toAutoClassifierInput?.({
        to: 'alice',
        summary: 's',
        message: 'hi',
      } as never),
    ).toBe('to alice: hi')
    expect(
      SendMessageTool.toAutoClassifierInput?.({
        to: 'team-lead',
        message: { type: 'shutdown_request' },
      } as never),
    ).toBe('shutdown_request to team-lead')
    expect(
      SendMessageTool.toAutoClassifierInput?.({
        to: 'team-lead',
        message: {
          type: 'shutdown_response',
          request_id: 'r1',
          approve: false,
        },
      } as never),
    ).toBe('shutdown_response reject r1')
    expect(
      SendMessageTool.toAutoClassifierInput?.({
        to: 'alice',
        message: {
          type: 'plan_approval_response',
          request_id: 'r2',
          approve: true,
        },
      } as never),
    ).toBe('plan_approval approve to alice')
  })

  test('validateInput rejects empty recipient', async () => {
    const result = await SendMessageTool.validateInput?.(
      { to: '   ', summary: 's', message: 'hi' } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
  })

  test('validateInput rejects @ in recipient', async () => {
    const result = await SendMessageTool.validateInput?.(
      { to: 'alice@team', summary: 's', message: 'hi' } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('"@" is not part of any address')
    }
  })

  test('validateInput rejects a recipient spanning lines', async () => {
    const result = await SendMessageTool.validateInput?.(
      { to: 'alice\nmain', message: 'hi' } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('single-line')
    }
  })

  test('validateInput accepts a plain-text message without a summary', async () => {
    const result = await SendMessageTool.validateInput?.(
      { to: 'alice', message: 'hi' } as never,
      {} as never,
    )
    expect(result?.result).toBe(true)
  })

  test('validateInput rejects an empty message', async () => {
    const result = await SendMessageTool.validateInput?.(
      { to: 'alice', message: '   ' } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
  })

  test('validateInput keeps "*" and structured messages for agent teams', async () => {
    const broadcast = await SendMessageTool.validateInput?.(
      { to: '*', message: 'hi' } as never,
      {} as never,
    )
    expect(broadcast?.result).toBe(false)
    if (broadcast && broadcast.result === false) {
      expect(broadcast.message).toContain('not in one')
    }
    const structured = await SendMessageTool.validateInput?.(
      { to: 'team-lead', message: { type: 'shutdown_request' } } as never,
      {} as never,
    )
    expect(structured?.result).toBe(false)
    if (structured && structured.result === false) {
      expect(structured.message).toContain('agent-team protocol')
    }
  })

  test('validateInput rejects broadcasting a structured message', async () => {
    withTeams()
    const result = await SendMessageTool.validateInput?.(
      {
        to: '*',
        message: { type: 'shutdown_request' },
      } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('cannot be broadcast')
    }
  })

  test('validateInput rejects shutdown_response sent to non-team-lead', async () => {
    withTeams()
    const result = await SendMessageTool.validateInput?.(
      {
        to: 'alice',
        message: {
          type: 'shutdown_response',
          request_id: 'r',
          approve: true,
        },
      } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('shutdown_response must be sent to')
    }
  })

  test('validateInput requires a reason when rejecting a shutdown_request', async () => {
    withTeams()
    const result = await SendMessageTool.validateInput?.(
      {
        to: 'team-lead',
        message: {
          type: 'shutdown_response',
          request_id: 'r',
          approve: false,
        },
      } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('reason is required')
    }
  })

  test('validateInput passes for a well-formed plain-text send', async () => {
    const result = await SendMessageTool.validateInput?.(
      { to: 'alice', summary: 'hi', message: 'hello' } as never,
      {} as never,
    )
    expect(result?.result).toBe(true)
  })

  test('mapToolResultToToolResultBlockParam serialises the payload as JSON', () => {
    const block = SendMessageTool.mapToolResultToToolResultBlockParam?.(
      {
        success: true,
        message: 'sent',
        request_id: 'r1',
      },
      'u1',
    )
    expect(block?.tool_use_id).toBe('u1')
    const text =
      Array.isArray(block?.content) && block.content[0]
        ? (block.content[0] as { text: string }).text
        : ''
    expect(text).toContain('"sent"')
    expect(text).toContain('"r1"')
  })
})

describe('SendMessageTool — routing outside an agent team', () => {
  test('an unknown name fails instead of reporting a send nobody reads', async () => {
    await expect(send({ to: 'nobody', message: 'hi' }, makeContext({}))).rejects.toThrow(
      'No agent or session named "nobody" — call ListAgents',
    )
  })

  test('"main" from a background agent queues an agent-message for the main thread', async () => {
    const data = await send(
      { to: 'main', message: 'found it\nsee a.ts' },
      makeContext({
        agentId: 'a1',
        tasks: { a1: backgroundAgent('Map the registry') },
        names: new Map([['researcher', 'a1']]),
      }),
    )
    expect(data).toEqual({
      success: true,
      message: "Message queued for the main conversation's next turn.",
    })
    const [queued] = getCommandQueueSnapshot()
    expect(queued).toMatchObject({
      mode: 'task-notification',
      priority: 'next',
      skipSlashCommands: true,
      origin: { kind: 'subagent', name: 'researcher' },
    })
    expect(queued?.agentId).toBeUndefined()
    expect(String(queued?.value)).toStartWith(
      '<agent-message from="researcher">\nfound it\nsee a.ts\n</agent-message>',
    )
  })

  test('an unnamed background agent answers to its agentId and shows its description', async () => {
    await send(
      { to: 'main', message: 'done' },
      makeContext({ agentId: 'a1', tasks: { a1: backgroundAgent('Map the registry') } }),
    )
    const [queued] = getCommandQueueSnapshot()
    expect(String(queued?.value)).toStartWith(
      '<agent-message from="a1" description="Map the registry">',
    )
    expect(queued?.origin).toEqual({ kind: 'subagent', name: 'Map the registry' })
  })

  test('"main" from the main conversation is refused', async () => {
    await expect(send({ to: 'main', message: 'hi' }, makeContext({}))).rejects.toThrow(
      '"main" addresses you',
    )
    expect(getCommandQueueSnapshot()).toEqual([])
  })

  test('"main" from an inline agent is refused — its final message already goes there', async () => {
    const inline = { ...backgroundAgent('inline'), isBackgrounded: false }
    await expect(
      send({ to: 'main', message: 'hi' }, makeContext({ agentId: 'a1', tasks: { a1: inline } })),
    ).rejects.toThrow('is for background agents')
    expect(getCommandQueueSnapshot()).toEqual([])
  })
})

import { afterAll, afterEach, beforeAll, beforeEach, describe, expect, test } from 'bun:test'
import { existsSync, mkdtempSync, rmSync } from 'fs'
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
import { renderToolUseMessage } from 'src/tools/SendMessageTool/UI.js'

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
  teamContext,
}: {
  agentId?: string
  tasks?: Record<string, FakeTask>
  names?: Map<string, string>
  teamContext?: { teamName: string; teammates: Record<string, never> }
}): ToolUseContext {
  return {
    agentId,
    getAppState: () => ({ tasks, agentNameRegistry: names, teamContext }),
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

  test('the use line shows a reply as one, and names a pure subscription', () => {
    expect(renderToolUseMessage({ to: 'uds:/run/user/1000/claudin-socks/42.sock', message: 'PONG' })).toBe(
      'reply: PONG',
    )
    expect(renderToolUseMessage({ to: 'claudin-goal', notify_when_idle: true })).toBe(
      'claudin-goal: notify when idle',
    )
    expect(renderToolUseMessage({ to: 'researcher', message: 'go\nmore' })).toBe('researcher: go')
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

describe('SendMessageTool — agent teams switched on', () => {
  test('with no team joined, an unknown name fails instead of filling a mailbox nobody polls', async () => {
    withTeams()
    await expect(send({ to: 'dev-backend', message: 'DB is up' }, makeContext({}))).rejects.toThrow(
      'No agent or session named "dev-backend" — call ListAgents',
    )
    expect(existsSync(join(configDir, 'teams', 'default', 'inboxes', 'dev-backend.json'))).toBe(false)
  })

  test('inside a team, a name off the local roster still goes to its mailbox', async () => {
    // A teammate's own roster is empty, so a sibling's name is only in the team file.
    withTeams()
    const data = await send(
      { to: 'sibling', message: 'hi' },
      makeContext({ teamContext: { teamName: 'crew', teammates: {} } }),
    )
    expect(data).toMatchObject({ success: true, message: "Message sent to sibling's inbox" })
    expect(existsSync(join(configDir, 'teams', 'crew', 'inboxes', 'sibling.json'))).toBe(true)
  })
})

describe('SendMessageTool — a message to a running agent carries its sender', () => {
  const DEV = 'a0123456789abcdef'
  const TESTER = 'a1123456789abcdef'
  const HELPER = 'a2123456789abcdef'

  function team(agentId?: string) {
    const running = (id: string, description: string) => ({
      type: 'local_agent',
      agentType: 'Code',
      agentId: id,
      description,
      status: 'running',
      isBackgrounded: true,
      pendingMessages: [] as string[],
    })
    let state = {
      tasks: {
        [DEV]: running(DEV, 'Implement the feature'),
        [TESTER]: running(TESTER, 'Test the feature'),
        [HELPER]: running(HELPER, 'Unnamed helper'),
      } as Record<string, ReturnType<typeof running>>,
      agentNameRegistry: new Map([
        ['dev', DEV],
        ['tester', TESTER],
      ]),
    }
    const context = {
      agentId,
      getAppState: () => state,
      setAppState: (f: (prev: typeof state) => typeof state) => {
        state = f(state)
      },
    } as unknown as ToolUseContext
    return {
      context,
      pending: (id: string) => state.tasks[id]!.pendingMessages,
      kill: (id: string) => {
        state = { ...state, tasks: { ...state.tasks, [id]: { ...state.tasks[id]!, status: 'killed' } } }
      },
    }
  }

  test('from main: the envelope says main, and how to answer', async () => {
    const { context, pending } = team()
    await send({ to: 'dev', message: 'status?' }, context)
    const [letter] = pending(DEV)
    expect(letter).toStartWith('<agent-message from="main">\nstatus?\n</agent-message>\n')
    expect(letter).toContain('SendMessage with to: "main"')
  })

  test('from a sibling: its name is the reply address', async () => {
    const { context, pending } = team(TESTER)
    await send({ to: 'dev', message: 'bug in a.ts:12' }, context)
    expect(pending(DEV)[0]).toStartWith('<agent-message from="tester">')
    expect(pending(DEV)[0]).toContain('SendMessage with to: "tester"')
  })

  test('an agent the user stopped is not restarted by another agent', async () => {
    const { context, pending, kill } = team(TESTER)
    kill(DEV)
    const data = await send({ to: 'dev', message: 'one more fix' }, context)
    expect(data).toMatchObject({ success: false })
    expect((data as { message: string }).message).toContain('only the main conversation can start it again')
    expect(pending(DEV)).toEqual([])
  })

  test('main may restart it — the resume is attempted', async () => {
    const { context, kill } = team()
    kill(DEV)
    const data = await send({ to: 'dev', message: 'one more fix' }, context)
    // Attempted; here it fails only for want of a transcript.
    expect((data as { message: string }).message).toContain('could not be resumed')
  })

  test('from an unnamed agent: its agentId, with its description for the transcript', async () => {
    const { context, pending } = team(HELPER)
    await send({ to: 'tester', message: 'done' }, context)
    expect(pending(TESTER)[0]).toStartWith(
      `<agent-message from="${HELPER}" description="Unnamed helper">`,
    )
  })
})

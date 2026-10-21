// The small readers of a history in queryHelpers: whether the last message
// counts as a successful end of the turn, which CLIs the Bash calls ran, and
// how a user or progress message reaches the SDK stream. Covered before
// queryHelpers is touched for the own-writes rebuild.
import { afterEach, beforeEach, describe, expect, test } from 'bun:test'
import { createAssistantMessage, createProgressMessage, createUserMessage } from 'src/agent/messages/factories.js'
import {
  __TEST_ONLY_getToolProgressMapSize,
  __TEST_ONLY_recordToolProgress,
  __TEST_ONLY_resetToolProgressMap,
  extractBashToolsFromMessages,
  isResultSuccessful,
  normalizeMessage,
} from 'src/agent/queryHelpers.js'
import type { Message } from 'src/shared/types/message.js'

function assistant(content: unknown[]): Message {
  return { type: 'assistant', uuid: 'a', message: { role: 'assistant', content } } as unknown as Message
}

function user(content: unknown): Message {
  return { type: 'user', uuid: 'u', message: { role: 'user', content } } as unknown as Message
}

function bash(command: unknown, name = 'Bash'): Message {
  return assistant([{ type: 'tool_use', id: 't', name, input: { command } }])
}

describe('isResultSuccessful', () => {
  test('no message is not a success', () => {
    expect(isResultSuccessful(undefined)).toBe(false)
    expect(isResultSuccessful(undefined, 'end_turn')).toBe(false)
  })

  test('an assistant message succeeds when it ends on text or thinking', () => {
    expect(isResultSuccessful(assistant([{ type: 'text', text: 'done' }]))).toBe(true)
    expect(isResultSuccessful(assistant([{ type: 'thinking', thinking: 'x' }]))).toBe(true)
    expect(isResultSuccessful(assistant([{ type: 'redacted_thinking', data: 'x' }]))).toBe(true)
  })

  test('an assistant message that ends on a tool call is not a success, whatever the stop reason', () => {
    const toolCall = assistant([{ type: 'text', text: 'now' }, { type: 'tool_use', id: 't', name: 'Bash', input: {} }])
    expect(isResultSuccessful(toolCall)).toBe(false)
    expect(isResultSuccessful(toolCall, 'end_turn')).toBe(false)
    expect(isResultSuccessful(assistant([]))).toBe(false)
  })

  test('a user message made only of tool results succeeds', () => {
    const results = user([
      { type: 'tool_result', tool_use_id: 'a', content: 'ok' },
      { type: 'tool_result', tool_use_id: 'b', content: 'ok' },
    ])
    expect(isResultSuccessful(results)).toBe(true)
  })

  test('a user prompt succeeds only when the API ended the turn with no content', () => {
    for (const prompt of [user('hi'), user([{ type: 'text', text: 'hi' }]), user([])]) {
      expect(isResultSuccessful(prompt)).toBe(false)
      expect(isResultSuccessful(prompt, 'max_tokens')).toBe(false)
      expect(isResultSuccessful(prompt, 'end_turn')).toBe(true)
    }
    const mixed = user([{ type: 'tool_result', tool_use_id: 'a', content: 'ok' }, { type: 'text', text: 'and' }])
    expect(isResultSuccessful(mixed)).toBe(false)
  })
})

describe('extractBashToolsFromMessages', () => {
  test('names each CLI once, past env assignments and sudo', () => {
    const tools = extractBashToolsFromMessages([
      bash('git status'),
      bash('  FOO=1 BAR=2 vercel deploy --prod'),
      bash('sudo docker ps'),
      bash('git log -1'),
    ])
    expect([...tools].sort()).toEqual(['docker', 'git', 'vercel'])
  })

  test('skips what is not a Bash command it can read', () => {
    const tools = extractBashToolsFromMessages([
      bash('rg foo', 'Grep'),
      bash(42),
      bash(''),
      bash('FOO=1 sudo'),
      assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: null }]),
      assistant([{ type: 'tool_use', id: 't', name: 'Bash', input: { description: 'no command' } }]),
      assistant([{ type: 'text', text: 'git push' }]),
      user([{ type: 'tool_result', tool_use_id: 't', content: 'npm test' }]),
    ])
    expect([...tools]).toEqual([])
  })
})

describe('normalizeMessage — user and progress messages', () => {
  const priorRemote = process.env.CLAUDE_CODE_REMOTE
  const priorContainer = process.env.CLAUDE_CODE_CONTAINER_ID
  beforeEach(() => {
    delete process.env.CLAUDE_CODE_REMOTE
    delete process.env.CLAUDE_CODE_CONTAINER_ID
    __TEST_ONLY_resetToolProgressMap()
  })
  afterEach(() => {
    if (priorRemote === undefined) delete process.env.CLAUDE_CODE_REMOTE
    else process.env.CLAUDE_CODE_REMOTE = priorRemote
    if (priorContainer === undefined) delete process.env.CLAUDE_CODE_CONTAINER_ID
    else process.env.CLAUDE_CODE_CONTAINER_ID = priorContainer
    __TEST_ONLY_resetToolProgressMap()
  })

  const bashProgress = (parent: string) =>
    createProgressMessage({
      toolUseID: `progress-${parent}`,
      parentToolUseID: parent,
      data: { type: 'bash_progress', elapsedTimeSeconds: 31, taskId: 'task-1' } as never,
    }) as unknown as Message

  test('a tool result reaches the stream with its result, and an MCP one with its meta beside it', () => {
    const plain = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }], toolUseResult: { stdout: 'ok' } })
    const [out] = [...normalizeMessage(plain as Message)] as Array<Record<string, unknown>>
    expect(out).toMatchObject({ type: 'user', parent_tool_use_id: null, uuid: plain.uuid, tool_use_result: { stdout: 'ok' } })

    const mcp = createUserMessage({
      content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }],
      toolUseResult: 'ok',
      mcpMeta: { structuredContent: { rows: 2 } },
    })
    const [mcpOut] = [...normalizeMessage(mcp as Message)] as Array<Record<string, unknown>>
    expect(mcpOut!.tool_use_result).toEqual({ content: 'ok', structuredContent: { rows: 2 } })
  })

  test("a sub-agent's progress carries its messages under the parent call", () => {
    const nestedAssistant = createAssistantMessage({ content: 'working on it' })
    const nestedUser = createUserMessage({ content: [{ type: 'tool_result', tool_use_id: 't', content: 'ok' }], isMeta: true })
    const progress = (message: unknown) =>
      createProgressMessage({ toolUseID: 'p', parentToolUseID: 'agent-call', data: { type: 'agent_progress', message } as never }) as unknown as Message

    const [fromAssistant] = [...normalizeMessage(progress(nestedAssistant))] as Array<Record<string, unknown>>
    expect(fromAssistant).toMatchObject({ type: 'assistant', parent_tool_use_id: 'agent-call' })
    const [fromUser] = [...normalizeMessage(progress(nestedUser))] as Array<Record<string, unknown>>
    expect(fromUser).toMatchObject({ type: 'user', parent_tool_use_id: 'agent-call', isSynthetic: true })
  })

  test('Bash progress is sent only to a remote session, and at most once per 30 seconds per call', () => {
    expect([...normalizeMessage(bashProgress('a'))]).toEqual([])

    process.env.CLAUDE_CODE_REMOTE = '1'
    const [first] = [...normalizeMessage(bashProgress('a'))] as Array<Record<string, unknown>>
    expect(first).toMatchObject({ type: 'tool_progress', tool_name: 'Bash', parent_tool_use_id: 'a', elapsed_time_seconds: 31, task_id: 'task-1' })
    expect([...normalizeMessage(bashProgress('a'))]).toEqual([])
    expect([...normalizeMessage(bashProgress('b'))]).toHaveLength(1)
  })

  test('the throttle map keeps its last 100 calls', () => {
    for (let i = 0; i < 105; i++) __TEST_ONLY_recordToolProgress(`call-${i}`)
    expect(__TEST_ONLY_getToolProgressMapSize()).toBe(100)
  })

  test('any other message type yields nothing', () => {
    const system = { type: 'system', uuid: 's', subtype: 'informational', content: 'x' } as unknown as Message
    expect([...normalizeMessage(system)]).toEqual([])
  })
})

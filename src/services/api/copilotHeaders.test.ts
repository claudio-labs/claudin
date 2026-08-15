import { describe, expect, test } from 'bun:test'
import {
  buildCopilotDynamicHeaders,
  detectCopilotInitiator,
  messagesContainImage,
  wrapFetchWithCopilotHeaders,
} from 'src/services/api/copilotHeaders.js'

const text = (s: string) => ({ type: 'text', text: s })
const image = () => ({
  type: 'image',
  source: { type: 'base64', media_type: 'image/png', data: 'aGk=' },
})
const toolResult = (content?: unknown[]) => ({
  type: 'tool_result',
  tool_use_id: 'tu_1',
  ...(content ? { content } : { content: [text('ok')] }),
})

describe('detectCopilotInitiator', () => {
  test('human user turn → user', () => {
    expect(
      detectCopilotInitiator([{ role: 'user', content: [text('oi')] }]),
    ).toBe('user')
  })

  test('string-content user turn → user', () => {
    expect(detectCopilotInitiator([{ role: 'user', content: 'oi' }])).toBe(
      'user',
    )
  })

  test('tool_result continuation (role user, all tool_results) → agent', () => {
    expect(
      detectCopilotInitiator([
        { role: 'user', content: [text('faz X')] },
        { role: 'assistant', content: [{ type: 'tool_use', id: 'tu_1', name: 'Bash', input: {} }] },
        { role: 'user', content: [toolResult()] },
      ]),
    ).toBe('agent')
  })

  test('assistant-last replay → agent', () => {
    expect(
      detectCopilotInitiator([
        { role: 'user', content: [text('oi')] },
        { role: 'assistant', content: [text('olá')] },
      ]),
    ).toBe('agent')
  })

  test('internal Claudin message shape ({ message: { role } })', () => {
    expect(
      detectCopilotInitiator([
        { type: 'user', message: { role: 'user', content: [toolResult()] } },
      ]),
    ).toBe('agent')
    expect(
      detectCopilotInitiator([
        { type: 'user', message: { role: 'user', content: [text('oi')] } },
      ]),
    ).toBe('user')
  })

  test('empty list defaults to user', () => {
    expect(detectCopilotInitiator([])).toBe('user')
  })

  test('mixed tool_result + text user turn → user', () => {
    expect(
      detectCopilotInitiator([
        { role: 'user', content: [toolResult(), text('e mais isso')] },
      ]),
    ).toBe('user')
  })
})

describe('messagesContainImage', () => {
  test('detects top-level image blocks', () => {
    expect(
      messagesContainImage([{ role: 'user', content: [text('veja'), image()] }]),
    ).toBe(true)
  })

  test('detects images nested in tool_result content', () => {
    expect(
      messagesContainImage([
        { role: 'user', content: [toolResult([image()])] },
      ]),
    ).toBe(true)
  })

  test('detects images in internal Claudin shape', () => {
    expect(
      messagesContainImage([
        { type: 'user', message: { role: 'user', content: [image()] } },
      ]),
    ).toBe(true)
  })

  test('false for text-only and string content', () => {
    expect(
      messagesContainImage([
        { role: 'user', content: 'oi' },
        { role: 'assistant', content: [text('olá')] },
      ]),
    ).toBe(false)
  })
})

describe('buildCopilotDynamicHeaders', () => {
  test('user turn without image → x-initiator only', () => {
    expect(
      buildCopilotDynamicHeaders([{ role: 'user', content: [text('oi')] }]),
    ).toEqual({ 'x-initiator': 'user' })
  })

  test('agent continuation with image → both headers', () => {
    expect(
      buildCopilotDynamicHeaders([
        { role: 'user', content: [toolResult([image()])] },
      ]),
    ).toEqual({
      'x-initiator': 'agent',
      'Copilot-Vision-Request': 'true',
    })
  })
})

describe('wrapFetchWithCopilotHeaders', () => {
  test('injects static + dynamic headers from JSON body', async () => {
    let seen: Headers | undefined
    const wrapped = wrapFetchWithCopilotHeaders(
      async (_input, init) => {
        seen = new Headers(init?.headers)
        return new Response('{}')
      },
      { 'Copilot-Integration-Id': 'vscode-chat' },
    )
    await wrapped('https://api.githubcopilot.com/v1/messages', {
      method: 'POST',
      body: JSON.stringify({
        model: 'claude-sonnet-4.6',
        messages: [{ role: 'user', content: [toolResult()] }],
      }),
    })
    expect(seen?.get('copilot-integration-id')).toBe('vscode-chat')
    expect(seen?.get('x-initiator')).toBe('agent')
  })

  test('does not override caller-provided static header, sets vision header', async () => {
    let seen: Headers | undefined
    const wrapped = wrapFetchWithCopilotHeaders(
      async (_input, init) => {
        seen = new Headers(init?.headers)
        return new Response('{}')
      },
      { 'Editor-Version': 'vscode/1.99.3' },
    )
    await wrapped('https://api.githubcopilot.com/v1/messages', {
      method: 'POST',
      headers: { 'Editor-Version': 'custom/1.0' },
      body: JSON.stringify({
        messages: [{ role: 'user', content: [image()] }],
      }),
    })
    expect(seen?.get('editor-version')).toBe('custom/1.0')
    expect(seen?.get('copilot-vision-request')).toBe('true')
    expect(seen?.get('x-initiator')).toBe('user')
  })

  test('non-JSON body passes through with static headers only', async () => {
    let seen: Headers | undefined
    const wrapped = wrapFetchWithCopilotHeaders(
      async (_input, init) => {
        seen = new Headers(init?.headers)
        return new Response('{}')
      },
      { 'Copilot-Integration-Id': 'vscode-chat' },
    )
    await wrapped('https://api.githubcopilot.com/v1/models', { method: 'GET' })
    expect(seen?.get('copilot-integration-id')).toBe('vscode-chat')
    expect(seen?.get('x-initiator')).toBeNull()
  })
})

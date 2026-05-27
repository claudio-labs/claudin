import { afterEach, describe, expect, test } from 'bun:test'

import { SendMessageTool } from './SendMessageTool.js'

afterEach(() => {
  delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
})

describe('SendMessageTool', () => {
  test('userFacingName is SendMessage and shouldDefer is true', () => {
    expect(SendMessageTool.userFacingName()).toBe('SendMessage')
    expect(SendMessageTool.shouldDefer).toBe(true)
  })

  test('isEnabled() requires the agent-teams opt-in', () => {
    delete process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS
    expect(SendMessageTool.isEnabled?.()).toBe(false)

    process.env.CLAUDE_CODE_EXPERIMENTAL_AGENT_TEAMS = '1'
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

  test('input schema requires to and message, accepts structured messages', () => {
    expect(SendMessageTool.inputSchema.safeParse({}).success).toBe(false)
    expect(
      SendMessageTool.inputSchema.safeParse({
        to: 'alice',
        summary: 's',
        message: 'hi',
      }).success,
    ).toBe(true)
    expect(
      SendMessageTool.inputSchema.safeParse({
        to: 'team-lead',
        message: {
          type: 'shutdown_response',
          request_id: 'r',
          approve: true,
        },
      }).success,
    ).toBe(true)
    // Unknown structured type rejected
    expect(
      SendMessageTool.inputSchema.safeParse({
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
      expect(result.message).toContain('bare teammate name')
    }
  })

  test('validateInput rejects plain-text message without summary', async () => {
    const result = await SendMessageTool.validateInput?.(
      { to: 'alice', message: 'hi' } as never,
      {} as never,
    )
    expect(result?.result).toBe(false)
    if (result && result.result === false) {
      expect(result.message).toContain('summary is required')
    }
  })

  test('validateInput rejects broadcasting a structured message', async () => {
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

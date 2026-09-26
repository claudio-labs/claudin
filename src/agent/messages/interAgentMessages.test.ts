import { describe, expect, test } from 'bun:test'

import {
  describeInterAgentMessage,
  isAgentAuthored,
  isInterAgentMessage,
  pendingMessageOrigin,
} from 'src/agent/messages/interAgentMessages.js'
import { wrapCommandText } from 'src/agent/messages/text.js'
import { getAgentPendingMessageAttachments } from 'src/agent/attachments/pipeline.js'
import { formatAgentMessage } from 'src/tools/SendMessageTool/agentMessage.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

describe('describeInterAgentMessage', () => {
  test('names a named background agent by its name', () => {
    const text = formatAgentMessage({ from: 'researcher', body: 'found it\nsee a.ts', to: 'main' })
    expect(describeInterAgentMessage(text)).toEqual({
      kind: 'message',
      sender: 'researcher',
      relation: 'background agent',
      body: 'found it\nsee a.ts',
    })
  })

  test('names an unnamed agent by its description, not its id', () => {
    const text = formatAgentMessage({
      from: 'a1b2c3d4e5f60718',
      description: 'Map the registry',
      body: 'done',
      to: 'main',
    })
    expect(describeInterAgentMessage(text)?.sender).toBe('Map the registry')
  })

  test('a message from main shows as the main conversation', () => {
    const text = formatAgentMessage({ from: 'main', body: 'status?', to: 'dev' })
    expect(describeInterAgentMessage(text)).toMatchObject({
      sender: 'main',
      relation: 'main conversation',
    })
  })

  test('ignores prose that only mentions the tag', () => {
    expect(isInterAgentMessage('what does <agent-message> mean?')).toBe(false)
    expect(isInterAgentMessage('plain prompt')).toBe(false)
  })
})

test('only agent-written origins count as agent-authored', () => {
  expect(isAgentAuthored({ kind: 'agent', name: 'tester' })).toBe(true)
  expect(isAgentAuthored({ kind: 'subagent', name: 'researcher' })).toBe(true)
  expect(isAgentAuthored({ kind: 'peer', name: 'claudin-goal' })).toBe(true)
  expect(isAgentAuthored({ kind: 'peer-notice', name: 'claudin-goal' })).toBe(true)
  expect(isAgentAuthored(undefined)).toBe(false)
  expect(isAgentAuthored({ kind: 'human' })).toBe(false)
  expect(isAgentAuthored({ kind: 'task-notification' })).toBe(false)
})

test('formatAgentMessage tells the receiver how to answer', () => {
  const text = formatAgentMessage({ from: 'researcher', body: 'hi', to: 'main' })
  expect(text).toStartWith('<agent-message from="researcher">\nhi\n</agent-message>\n')
  expect(text).toContain('not from your user')
  expect(text).toContain('SendMessage with to: "researcher"')
})

test('formatAgentMessage says who the sender is to the receiver', () => {
  expect(formatAgentMessage({ from: 'dev', body: 'hi', to: 'main' })).toContain(
    'From your background agent',
  )
  expect(formatAgentMessage({ from: 'main', body: 'hi', to: 'dev' })).toContain(
    'From the main conversation, which launched you',
  )
  const sibling = formatAgentMessage({ from: 'tester', body: 'bug in a.ts', to: 'dev' })
  expect(sibling).toContain('From another agent of this conversation')
  expect(sibling).toContain('SendMessage with to: "tester"')
})

describe('a message queued for a running agent', () => {
  test('SendMessage envelopes are agent-authored, with the address to answer', () => {
    const letter = formatAgentMessage({ from: 'tester', body: 'bug in a.ts', to: 'dev' })
    expect(pendingMessageOrigin(letter)).toEqual({ kind: 'agent', name: 'tester' })
  })

  test('anything else was typed by the user into the agent view', () => {
    expect(pendingMessageOrigin('please also check b.ts')).toEqual({ kind: 'human' })
    // Prose that only mentions the tag is not an envelope.
    expect(pendingMessageOrigin('what is an <agent-message>?')).toEqual({ kind: 'human' })
  })

  test('the drain labels each one by its author, not as "the coordinator"', () => {
    const letter = formatAgentMessage({ from: 'main', body: 'status?', to: 'dev' })
    let state = {
      tasks: {
        a1: { type: 'local_agent', pendingMessages: [letter, 'from the user'] },
      },
    }
    const context = {
      agentId: 'a1',
      getAppState: () => state,
      setAppState: (f: (prev: typeof state) => typeof state) => {
        state = f(state)
      },
    } as unknown as ToolUseContext
    const attachments = getAgentPendingMessageAttachments(context)
    expect(attachments.map(a => (a as { origin?: unknown }).origin)).toEqual([
      { kind: 'agent', name: 'main' },
      { kind: 'human' },
    ])
    expect(state.tasks.a1.pendingMessages).toEqual([])
  })

  test('the wrapper names the sender', () => {
    expect(wrapCommandText('x', { kind: 'agent', name: 'main' })).toStartWith(
      'The main conversation sent you a message',
    )
    expect(wrapCommandText('x', { kind: 'agent', name: 'tester' })).toStartWith(
      'Agent "tester" sent you a message',
    )
  })
})

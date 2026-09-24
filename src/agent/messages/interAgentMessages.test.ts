import { describe, expect, test } from 'bun:test'

import {
  describeInterAgentMessage,
  isAgentAuthored,
  isInterAgentMessage,
} from 'src/agent/messages/interAgentMessages.js'
import { formatAgentMessage } from 'src/tools/SendMessageTool/agentMessage.js'

describe('describeInterAgentMessage', () => {
  test('names a named background agent by its name', () => {
    const text = formatAgentMessage({ from: 'researcher', body: 'found it\nsee a.ts' })
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
    })
    expect(describeInterAgentMessage(text)?.sender).toBe('Map the registry')
  })

  test('ignores prose that only mentions the tag', () => {
    expect(isInterAgentMessage('what does <agent-message> mean?')).toBe(false)
    expect(isInterAgentMessage('plain prompt')).toBe(false)
  })
})

test('only agent-written origins count as agent-authored', () => {
  expect(isAgentAuthored({ kind: 'subagent', name: 'researcher' })).toBe(true)
  expect(isAgentAuthored({ kind: 'peer', name: 'claudin-goal' })).toBe(true)
  expect(isAgentAuthored({ kind: 'peer-notice', name: 'claudin-goal' })).toBe(true)
  expect(isAgentAuthored(undefined)).toBe(false)
  expect(isAgentAuthored({ kind: 'human' })).toBe(false)
  expect(isAgentAuthored({ kind: 'task-notification' })).toBe(false)
})

test('formatAgentMessage tells the receiver how to answer', () => {
  const text = formatAgentMessage({ from: 'researcher', body: 'hi' })
  expect(text).toStartWith('<agent-message from="researcher">\nhi\n</agent-message>\n')
  expect(text).toContain('not from your user')
  expect(text).toContain('SendMessage with to: "researcher"')
})

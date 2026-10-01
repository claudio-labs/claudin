import { describe, expect, test } from 'bun:test'
import { createAssistantMessage } from 'src/agent/messages/messages.js'
import { withObservableToolInputs } from 'src/agent/messages/observableInput.js'
import { normalizeMessage } from 'src/agent/queryHelpers.js'
import type { Tool, Tools } from 'src/tools/Tool.js'

function toolWithBackfill(name: string, backfill: (input: Record<string, unknown>) => void): Tool {
  return { name, backfillObservableInput: backfill } as unknown as Tool
}

const notify = toolWithBackfill('Notify', input => {
  if (typeof input.to === 'string') {
    input.type = 'message'
    input.recipient = input.to
  }
})
const write = toolWithBackfill('Write', input => {
  if (typeof input.file_path === 'string') input.file_path = `/abs/${input.file_path}`
})
const TOOLS: Tools = [notify, write]

function call(name: string, input: Record<string, unknown>) {
  return createAssistantMessage({
    content: [{ type: 'tool_use', id: 'toolu_1', name, input } as never],
  })
}

describe('withObservableToolInputs', () => {
  test('adds what the backfill adds, on a copy', () => {
    const message = call('Notify', { to: 'main', message: 'hi' })
    const observed = withObservableToolInputs(message, TOOLS)
    expect(observed).not.toBe(message)
    expect((observed.message.content[0] as { input: unknown }).input).toEqual({
      to: 'main',
      message: 'hi',
      type: 'message',
      recipient: 'main',
    })
    expect((message.message.content[0] as { input: unknown }).input).toEqual({ to: 'main', message: 'hi' })
  })

  test('leaves the message alone when the backfill only overwrites', () => {
    const message = call('Write', { file_path: 'a.ts' })
    expect(withObservableToolInputs(message, TOOLS)).toBe(message)
  })
})

// The SDK stream is the one observer that keeps the backfilled view.
test('the SDK assistant message carries the backfilled input', () => {
  const [out] = [...normalizeMessage(call('Notify', { to: 'main', message: 'hi' }), TOOLS)]
  const block = (out as unknown as { message: { content: Array<{ input: Record<string, unknown> }> } })
    .message.content[0]!
  expect(block.input.recipient).toBe('main')
})

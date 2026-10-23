import { describe, expect, test } from 'bun:test'
import { readFileSync } from 'fs'
import {
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
} from 'src/agent/messages/messages.js'
import { getLastAssistantMessageId } from 'src/platform/status/StatusLine.js'

// The status line re-runs its command when this id changes, so it is what
// makes a compaction show up there before the next reply.
describe('getLastAssistantMessageId', () => {
  test('is the uuid of the last assistant message', () => {
    const first = createAssistantMessage({ content: 'one' })
    const last = createAssistantMessage({ content: 'two' })
    expect(getLastAssistantMessageId([first, createUserMessage({ content: 'x' }), last])).toBe(last.uuid)
  })

  test('is null with no assistant message', () => {
    expect(getLastAssistantMessageId([createUserMessage({ content: 'x' })])).toBeNull()
  })

  test('is null right after a compact boundary, before any new reply', () => {
    const history = [createAssistantMessage({ content: 'old' }), createCompactBoundaryMessage('manual', 100)]
    expect(getLastAssistantMessageId(history)).toBeNull()
  })

  test('the footer keys its status line refresh on it', () => {
    const footer = readFileSync(new URL('../../terminal/prompt-input/PromptInputFooter.tsx', import.meta.url), 'utf8')
    expect(footer).toContain('getLastAssistantMessageId(messages)')
  })
})

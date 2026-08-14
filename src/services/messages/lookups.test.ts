/**
 * Characterization tests for lookups bucket of src/services/messages/messages.ts.
 * See normalize.test.ts header for context (ROADMAP 11a).
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  buildMessageLookups,
  createAssistantMessage,
  createUserMessage,
  getSiblingToolUseIDsFromLookup,
  getToolResultIDs,
  getToolUseIDs,
  hasUnresolvedHooksFromLookup,
  normalizeMessages,
} from 'src/services/messages/messages.js'
import { resetGlobalConfigForTests } from 'src/services/config/config.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

function toolUseBlock(id: string, name = 'Bash') {
  return { type: 'tool_use' as const, id, name, input: {} }
}
function toolResultBlock(toolUseId: string, content = 'ok', isError = false) {
  return {
    type: 'tool_result' as const,
    tool_use_id: toolUseId,
    content,
    ...(isError && { is_error: true }),
  }
}

function buildFixture() {
  const assistant = createAssistantMessage({
    content: [
      { type: 'text', text: 'using two tools' } as any,
      toolUseBlock('toolu_1') as any,
      toolUseBlock('toolu_2') as any,
    ],
  })
  // Force a stable message.id so siblings collapse correctly.
  assistant.message.id = 'msg_pair'

  const result1 = createUserMessage({ content: [toolResultBlock('toolu_1', 'ok1')] })
  const result2 = createUserMessage({
    content: [toolResultBlock('toolu_2', 'fail', true)],
  })

  const messages = [createUserMessage({ content: 'go' }), assistant, result1, result2]
  return { messages, assistant }
}

describe('buildMessageLookups', () => {
  test('builds sibling map, tool_result map, errored set', () => {
    const { messages } = buildFixture()
    const normalized = normalizeMessages(messages)
    const lookups = buildMessageLookups(normalized, messages)

    // Siblings: each toolu_* references the same Set of {toolu_1, toolu_2}.
    const siblings1 = lookups.siblingToolUseIDs.get('toolu_1')
    expect(siblings1).toBeDefined()
    expect([...siblings1!].sort()).toEqual(['toolu_1', 'toolu_2'])

    // Tool results indexed.
    expect(lookups.toolResultByToolUseID.has('toolu_1')).toBe(true)
    expect(lookups.toolResultByToolUseID.has('toolu_2')).toBe(true)

    // Resolved + errored.
    expect(lookups.resolvedToolUseIDs.has('toolu_1')).toBe(true)
    expect(lookups.resolvedToolUseIDs.has('toolu_2')).toBe(true)
    expect(lookups.erroredToolUseIDs.has('toolu_1')).toBe(false)
    expect(lookups.erroredToolUseIDs.has('toolu_2')).toBe(true)

    // toolUseByToolUseID populated.
    expect(lookups.toolUseByToolUseID.get('toolu_1')?.id).toBe('toolu_1')

    // Counts.
    expect(lookups.normalizedMessageCount).toBe(normalized.length)
  })
})

describe('getSiblingToolUseIDsFromLookup', () => {
  test('returns siblings for a tool_use normalized message', () => {
    const { messages } = buildFixture()
    const normalized = normalizeMessages(messages)
    const lookups = buildMessageLookups(normalized, messages)

    const toolUseMsg = normalized.find(
      m =>
        m.type === 'assistant' &&
        Array.isArray(m.message.content) &&
        (m.message.content[0] as any)?.type === 'tool_use' &&
        (m.message.content[0] as any)?.id === 'toolu_1',
    )!
    const siblings = getSiblingToolUseIDsFromLookup(toolUseMsg, lookups)
    expect([...siblings].sort()).toEqual(['toolu_1', 'toolu_2'])
  })

  test('returns empty set for non tool_use message', () => {
    const { messages } = buildFixture()
    const normalized = normalizeMessages(messages)
    const lookups = buildMessageLookups(normalized, messages)
    const userMsg = normalized.find(m => m.type === 'user' && !Array.isArray((m as any).message.content[0]?.tool_use_id))!
    expect(getSiblingToolUseIDsFromLookup(userMsg, lookups).size).toBe(0)
  })
})

describe('hasUnresolvedHooksFromLookup', () => {
  test('returns false when no hook activity tracked', () => {
    const { messages } = buildFixture()
    const normalized = normalizeMessages(messages)
    const lookups = buildMessageLookups(normalized, messages)
    expect(
      hasUnresolvedHooksFromLookup('toolu_1', 'PreToolUse' as any, lookups),
    ).toBe(false)
  })
})

describe('getToolUseIDs / getToolResultIDs', () => {
  test('extract IDs from normalized stream', () => {
    const { messages } = buildFixture()
    const normalized = normalizeMessages(messages)

    const useIDs = getToolUseIDs(normalized)
    expect([...useIDs].sort()).toEqual(['toolu_1', 'toolu_2'])

    const resultMap = getToolResultIDs(normalized)
    expect(Object.keys(resultMap).sort()).toEqual(['toolu_1', 'toolu_2'])
    expect(resultMap['toolu_1']).toBe(false)
    expect(resultMap['toolu_2']).toBe(true)
  })
})

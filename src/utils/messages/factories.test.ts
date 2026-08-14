/**
 * Characterization tests for factories bucket of src/utils/messages.ts.
 * See normalize.test.ts header for full context (ROADMAP 11a).
 *
 * Coverage: the 8 most-used create* helpers per the plan.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  createApiMetricsMessage,
  createAssistantAPIErrorMessage,
  createAssistantMessage,
  createCompactBoundaryMessage,
  createProgressMessage,
  createSystemMessage,
  createUserMessage,
  createToolUseSummaryMessage,
} from 'src/utils/messages.js'
import { resetGlobalConfigForTests } from 'src/utils/config.js'
import { normalizeForSnapshot } from './__test-helpers__/snapshot.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

describe('createAssistantMessage', () => {
  test('string content → single text block', () => {
    const m = createAssistantMessage({ content: 'hi' })
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })

  test('empty string content gets NO_CONTENT placeholder', () => {
    const m = createAssistantMessage({ content: '' })
    const block = (m.message.content as any[])[0]
    expect(block.type).toBe('text')
    expect(block.text.length).toBeGreaterThan(0)
  })

  test('block content passes through', () => {
    const m = createAssistantMessage({
      content: [{ type: 'text', text: 'hello' } as any],
    })
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })
})

describe('createUserMessage', () => {
  test('string content + defaults', () => {
    const m = createUserMessage({ content: 'hi' })
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })

  test('isMeta + custom uuid preserved', () => {
    const m = createUserMessage({
      content: 'sys note',
      isMeta: true,
      uuid: '00000000-0000-4000-8000-000000000000',
    })
    expect(m.isMeta).toBe(true)
    // uuid is preserved verbatim (not regenerated)
    expect(m.uuid).toBe('00000000-0000-4000-8000-000000000000')
  })
})

describe('createAssistantAPIErrorMessage', () => {
  test('flags isApiErrorMessage + carries content', () => {
    const m = createAssistantAPIErrorMessage({
      content: 'rate limit hit',
      errorDetails: 'extra',
    })
    expect(m.isApiErrorMessage).toBe(true)
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })
})

describe('createSystemMessage', () => {
  test('informational level + content', () => {
    const m = createSystemMessage('hello world', 'info')
    expect(m.subtype).toBe('informational')
    expect(m.level).toBe('info')
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })
})

describe('createProgressMessage', () => {
  test('carries toolUseID, parentToolUseID, data', () => {
    const m = createProgressMessage({
      toolUseID: 'toolu_1',
      parentToolUseID: 'toolu_parent',
      data: { kind: 'progress', step: 1 } as any,
    })
    expect(m.toolUseID).toBe('toolu_1')
    expect(m.parentToolUseID).toBe('toolu_parent')
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })
})

describe('createCompactBoundaryMessage', () => {
  test('manual trigger snapshot', () => {
    const m = createCompactBoundaryMessage('manual', 12345, undefined, 'why', 7)
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })
})

describe('createApiMetricsMessage', () => {
  test('minimal metrics', () => {
    const m = createApiMetricsMessage({ ttftMs: 100, otps: 50 })
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })
})

describe('createToolUseSummaryMessage', () => {
  test('snapshot of basic summary', () => {
    const m = createToolUseSummaryMessage('1 tool used', ['toolu_1'])
    expect(normalizeForSnapshot(m)).toMatchSnapshot()
  })
})

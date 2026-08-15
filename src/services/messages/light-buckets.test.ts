/**
 * Characterization tests for lighter buckets of src/services/messages/messages.ts.
 * One file covers: predicates, text helpers, constants, rejection, auto-mode,
 * plan-mode. Per plan (ROADMAP 11a) each gets 1-2 representative cases.
 *
 * Goal: detect identity/shape regressions when these move to per-bucket
 * modules, without exhaustive enumeration.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  AUTO_REJECT_MESSAGE,
  CANCEL_MESSAGE,
  DENIAL_WORKAROUND_GUIDANCE,
  DONT_ASK_REJECT_MESSAGE,
  INTERRUPT_MESSAGE,
  INTERRUPT_MESSAGE_FOR_TOOL_USE,
  NO_RESPONSE_REQUESTED,
  PLAN_PHASE4_CONTROL,
  PLAN_REJECTION_PREFIX,
  REJECT_MESSAGE,
  SYNTHETIC_MESSAGES,
  SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
  buildClassifierUnavailableMessage,
  buildYoloRejectionMessage,
  countToolCalls,
  createAssistantMessage,
  createCompactBoundaryMessage,
  createUserMessage,
  deriveShortMessageId,
  deriveUUID,
  extractTag,
  extractTextContent,
  findLastCompactBoundaryIndex,
  getAssistantMessageText,
  getMessagesAfterCompactBoundary,
  hasToolCallsInLastAssistantTurn,
  isClassifierDenial,
  isCompactBoundaryMessage,
  isNotEmptyMessage,
  isSyntheticMessage,
  isThinkingMessage,
  stripPromptXMLTags,
  wrapInSystemReminder,
} from 'src/services/messages/messages.js'
import { resetGlobalConfigForTests } from 'src/services/config/config.js'
import { normalizeForSnapshot } from 'src/services/messages/__test-helpers__/snapshot.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

// ---------- constants ----------

describe('public constants', () => {
  test('exported strings are stable', () => {
    expect({
      INTERRUPT_MESSAGE,
      INTERRUPT_MESSAGE_FOR_TOOL_USE,
      CANCEL_MESSAGE,
      REJECT_MESSAGE,
      NO_RESPONSE_REQUESTED,
      SYNTHETIC_TOOL_RESULT_PLACEHOLDER,
      PLAN_REJECTION_PREFIX,
      DENIAL_WORKAROUND_GUIDANCE,
    }).toMatchSnapshot()
  })

  test('SYNTHETIC_MESSAGES contains expected entries', () => {
    expect(SYNTHETIC_MESSAGES.has(INTERRUPT_MESSAGE)).toBe(true)
    expect(SYNTHETIC_MESSAGES.has(REJECT_MESSAGE)).toBe(true)
    expect(SYNTHETIC_MESSAGES.has(CANCEL_MESSAGE)).toBe(true)
  })
})

// ---------- rejection ----------

describe('rejection helpers', () => {
  test('AUTO_REJECT_MESSAGE / DONT_ASK_REJECT_MESSAGE include tool name + guidance', () => {
    expect({
      auto: AUTO_REJECT_MESSAGE('Bash'),
      dontAsk: DONT_ASK_REJECT_MESSAGE('Bash'),
    }).toMatchSnapshot()
  })

  test('buildYoloRejectionMessage embeds reason + permission hint', () => {
    expect(buildYoloRejectionMessage('looks risky')).toMatchSnapshot()
  })

  test('buildClassifierUnavailableMessage includes tool + model', () => {
    expect(
      buildClassifierUnavailableMessage('Bash', 'claude-haiku-4-5-20251001'),
    ).toMatchSnapshot()
  })

  test('isClassifierDenial — positive/negative cases', () => {
    expect(
      isClassifierDenial(buildYoloRejectionMessage('nope')),
    ).toBe(true)
    expect(isClassifierDenial('Plain text')).toBe(false)
    expect(isClassifierDenial('')).toBe(false)
  })
})

// ---------- text helpers ----------

describe('text helpers', () => {
  test('extractTag returns inner content, null when missing', () => {
    expect(extractTag('<foo>bar</foo>', 'foo')).toBe('bar')
    expect(extractTag('<a>x</a>', 'b')).toBeNull()
    expect(extractTag('', 'foo')).toBeNull()
  })

  test('wrapInSystemReminder produces stable XML chrome', () => {
    expect(wrapInSystemReminder('hello')).toBe(
      '<system-reminder>\nhello\n</system-reminder>',
    )
  })

  test('stripPromptXMLTags removes known wrappers', () => {
    const input = '<context>ignored</context>real text'
    expect(stripPromptXMLTags(input)).toBe('real text')
  })

  test('extractTextContent joins only text blocks', () => {
    const blocks = [
      { type: 'text', text: 'a' },
      { type: 'thinking', thinking: 'skip' } as any,
      { type: 'text', text: 'b' },
    ] as any
    expect(extractTextContent(blocks, '|')).toBe('a|b')
  })

  test('getAssistantMessageText returns concatenated text, null for non-assistant', () => {
    const a = createAssistantMessage({
      content: [
        { type: 'text', text: 'one' } as any,
        { type: 'text', text: 'two' } as any,
      ],
    })
    expect(getAssistantMessageText(a)).toBe('one\ntwo')
    const u = createUserMessage({ content: 'hi' })
    expect(getAssistantMessageText(u)).toBeNull()
  })

  test('deriveUUID is deterministic per (parent, index)', () => {
    const parent = '11111111-2222-4333-8444-555555555555' as any
    const a = deriveUUID(parent, 0)
    const b = deriveUUID(parent, 0)
    const c = deriveUUID(parent, 1)
    expect(a).toBe(b)
    expect(a).not.toBe(c)
    expect(a).toMatchSnapshot()
  })

  test('deriveShortMessageId produces stable short form', () => {
    expect(
      deriveShortMessageId('11111111-2222-4333-8444-555555555555'),
    ).toMatchSnapshot()
  })
})

// ---------- predicates ----------

describe('predicates', () => {
  test('isSyntheticMessage detects INTERRUPT / non-synthetic', () => {
    const interrupt = createUserMessage({
      content: [{ type: 'text', text: INTERRUPT_MESSAGE }],
    })
    const plain = createUserMessage({ content: 'hello' })
    expect(isSyntheticMessage(interrupt)).toBe(true)
    expect(isSyntheticMessage(plain)).toBe(false)
  })

  test('isNotEmptyMessage true for text, false for empty array', () => {
    expect(isNotEmptyMessage(createUserMessage({ content: 'hi' }))).toBe(true)
    const empty = createAssistantMessage({ content: [] as any })
    expect(isNotEmptyMessage(empty)).toBe(false)
  })

  test('isThinkingMessage true only for assistant with only thinking blocks', () => {
    const t = createAssistantMessage({
      content: [{ type: 'thinking', thinking: 't', signature: 's' } as any],
    })
    expect(isThinkingMessage(t)).toBe(true)
    const mixed = createAssistantMessage({
      content: [
        { type: 'thinking', thinking: 't', signature: 's' } as any,
        { type: 'text', text: 'visible' } as any,
      ],
    })
    expect(isThinkingMessage(mixed)).toBe(false)
  })

  test('hasToolCallsInLastAssistantTurn — last assistant has tool_use', () => {
    const msgs = [
      createUserMessage({ content: 'go' }),
      createAssistantMessage({
        content: [
          { type: 'tool_use', id: 'toolu_x', name: 'Bash', input: {} } as any,
        ],
      }),
    ]
    expect(hasToolCallsInLastAssistantTurn(msgs)).toBe(true)
  })

  test('countToolCalls counts tool_use blocks across messages', () => {
    const msgs = [
      createAssistantMessage({
        content: [
          { type: 'tool_use', id: 't1', name: 'Bash', input: {} } as any,
          { type: 'tool_use', id: 't2', name: 'Bash', input: {} } as any,
        ],
      }),
      createAssistantMessage({
        content: [
          { type: 'tool_use', id: 't3', name: 'Other', input: {} } as any,
        ],
      }),
    ]
    // countToolCalls counts assistant *messages* that contain at least one
    // matching tool_use (not the number of tool_use blocks).
    expect(countToolCalls(msgs, 'Bash')).toBe(1)
    expect(countToolCalls(msgs, 'Other')).toBe(1)
    expect(countToolCalls(msgs, 'Missing')).toBe(0)
  })

  test('isCompactBoundaryMessage + findLastCompactBoundaryIndex + slice', () => {
    const boundary = createCompactBoundaryMessage('manual', 100)
    expect(isCompactBoundaryMessage(boundary)).toBe(true)
    const msgs = [
      createUserMessage({ content: 'first' }),
      boundary as any,
      createUserMessage({ content: 'after' }),
    ]
    expect(findLastCompactBoundaryIndex(msgs)).toBe(1)
    const after = getMessagesAfterCompactBoundary(msgs)
    expect(after.length).toBe(2) // boundary + next user
  })
})

// ---------- plan/auto mode constants ----------

describe('plan mode constants', () => {
  test('PLAN_PHASE4_CONTROL prompt is stable', () => {
    expect(normalizeForSnapshot(PLAN_PHASE4_CONTROL)).toMatchSnapshot()
  })
})

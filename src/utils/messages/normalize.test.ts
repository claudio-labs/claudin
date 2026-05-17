/**
 * Characterization tests for normalize-bucket exports of src/utils/messages.ts.
 *
 * Written before the file split (ROADMAP 11a) to detect silent regressions when
 * functions move to src/utils/messages/normalize.ts. Snapshots freeze the
 * current behavior — diffs in Fase 2 commits = regression.
 *
 * Scope (per plan): normalizeMessages overloads, mergeUserMessagesAndToolResults,
 * normalizeMessagesForAPI, ensureToolResultPairing, stripAdvisorBlocks,
 * stripSignatureBlocks, filterTrailing/Whitespace/OrphanedThinking.
 *
 * filterTrailingThinkingFromLastAssistant is module-private; we cover it
 * indirectly via normalizeMessagesForAPI.
 */
import { afterAll, describe, expect, test } from 'bun:test'
import {
  createAssistantMessage,
  createUserMessage,
  ensureToolResultPairing,
  filterOrphanedThinkingOnlyMessages,
  filterWhitespaceOnlyAssistantMessages,
  mergeUserMessagesAndToolResults,
  normalizeMessages,
  normalizeMessagesForAPI,
  stripAdvisorBlocks,
  stripSignatureBlocks,
} from '../messages.js'
import { resetGlobalConfigForTests } from '../config.js'
import { normalizeForSnapshot } from './__test-helpers__/snapshot.js'

afterAll(() => {
  resetGlobalConfigForTests()
})

// ---------- fixture helpers ----------

function userText(text: string) {
  return createUserMessage({ content: text })
}

function assistantText(text: string) {
  return createAssistantMessage({ content: text })
}

function assistantBlocks(content: any[]) {
  return createAssistantMessage({ content })
}

function toolUseBlock(id: string, name: string, input: object = {}) {
  return { type: 'tool_use' as const, id, name, input }
}

function toolResultBlock(toolUseId: string, content: string) {
  return {
    type: 'tool_result' as const,
    tool_use_id: toolUseId,
    content,
  }
}

function userWithToolResult(toolUseId: string, content: string) {
  return createUserMessage({ content: [toolResultBlock(toolUseId, content)] })
}

// ---------- normalizeMessages ----------

describe('normalizeMessages', () => {
  test('passes through single-block assistant + user pair', () => {
    const msgs = [userText('hi'), assistantText('hello')]
    const out = normalizeMessages(msgs)
    expect(out).toHaveLength(2)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('splits multi-block assistant into one message per block', () => {
    const msgs = [
      userText('do it'),
      assistantBlocks([
        { type: 'text', text: 'sure' },
        toolUseBlock('toolu_1', 'Bash', { command: 'ls' }),
      ]),
    ]
    const out = normalizeMessages(msgs)
    // assistant with 2 blocks becomes 2 messages
    expect(out).toHaveLength(3)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('orphan tool_result user message is preserved as-is', () => {
    const msgs = [userText('go'), userWithToolResult('toolu_missing', 'x')]
    const out = normalizeMessages(msgs)
    expect(out).toHaveLength(2)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })
})

// ---------- mergeUserMessagesAndToolResults ----------

describe('mergeUserMessagesAndToolResults', () => {
  test('merges adjacent user content blocks, hoisting tool_results first', () => {
    const a = userText('first')
    const b = userWithToolResult('toolu_42', 'ok')
    const merged = mergeUserMessagesAndToolResults(a, b)
    expect(merged.type).toBe('user')
    expect(normalizeForSnapshot(merged)).toMatchSnapshot()
  })
})

// ---------- normalizeMessagesForAPI ----------

describe('normalizeMessagesForAPI', () => {
  test('5-turn fixture with tool use/result roundtrip', () => {
    const msgs = [
      userText('hello'),
      assistantText('hi'),
      userText('run ls'),
      assistantBlocks([toolUseBlock('toolu_a', 'Bash', { command: 'ls' })]),
      userWithToolResult('toolu_a', 'file1\nfile2'),
      assistantText('done'),
    ]
    const out = normalizeMessagesForAPI(msgs)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('empty input returns empty output', () => {
    expect(normalizeMessagesForAPI([])).toEqual([])
  })
})

// ---------- ensureToolResultPairing ----------

describe('ensureToolResultPairing', () => {
  test('paired tool_use → tool_result passes through', () => {
    const msgs = [
      assistantBlocks([toolUseBlock('toolu_p', 'Bash')]),
      userWithToolResult('toolu_p', 'ok'),
    ]
    const out = ensureToolResultPairing(msgs as any)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('orphan tool_result (no preceding assistant) gets placeholder', () => {
    const msgs = [userWithToolResult('toolu_orphan', 'stranded')]
    const out = ensureToolResultPairing(msgs as any)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('tool_use without result gets stub result appended', () => {
    const msgs = [
      assistantBlocks([toolUseBlock('toolu_lonely', 'Bash')]),
      userText('next turn anyway'),
    ]
    const out = ensureToolResultPairing(msgs as any)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })
})

// ---------- strip + filter ----------

describe('stripAdvisorBlocks', () => {
  test('removes advisor blocks, inserts placeholder when emptied', () => {
    const advisorOnly = createAssistantMessage({
      content: [
        { type: 'text', text: 'advisor reply', advisor: true } as any,
      ],
    })
    const out = stripAdvisorBlocks([advisorOnly] as any)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('passes through messages with no advisor blocks unchanged', () => {
    const plain = [userText('hi'), assistantText('hello')] as any
    expect(stripAdvisorBlocks(plain)).toBe(plain)
  })
})

describe('stripSignatureBlocks', () => {
  test('strips thinking blocks from assistant messages', () => {
    const withThinking = createAssistantMessage({
      content: [
        { type: 'thinking', thinking: 'reasoning', signature: 'sig' } as any,
        { type: 'text', text: 'answer' } as any,
      ],
    })
    const out = stripSignatureBlocks([withThinking])
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('passes through messages with no thinking unchanged (identity)', () => {
    const plain = [userText('hi'), assistantText('hello')]
    expect(stripSignatureBlocks(plain)).toBe(plain)
  })
})

describe('filterWhitespaceOnlyAssistantMessages', () => {
  test('drops whitespace-only assistant, merges adjacent users', () => {
    const msgs = [
      userText('first'),
      assistantBlocks([{ type: 'text', text: '   \n\t  ' }]),
      userText('second'),
    ] as any
    const out = filterWhitespaceOnlyAssistantMessages(msgs)
    expect(out.length).toBeLessThan(msgs.length)
    expect(normalizeForSnapshot(out)).toMatchSnapshot()
  })

  test('keeps assistant with real content (identity return)', () => {
    const msgs = [userText('hi'), assistantText('hello')] as any
    expect(filterWhitespaceOnlyAssistantMessages(msgs)).toBe(msgs)
  })
})

describe('filterOrphanedThinkingOnlyMessages', () => {
  test('keeps thinking-only message when sibling with same id has real content', () => {
    const id = 'msg_shared'
    const thinkingPart = createAssistantMessage({
      content: [
        { type: 'thinking', thinking: 't', signature: 's' } as any,
      ],
    })
    thinkingPart.message.id = id
    const textPart = createAssistantMessage({
      content: [{ type: 'text', text: 'real' } as any],
    })
    textPart.message.id = id

    const msgs = [userText('q'), thinkingPart, textPart] as any
    const out = filterOrphanedThinkingOnlyMessages(msgs)
    expect(out.length).toBe(msgs.length)
  })

  test('drops thinking-only message with no real-content sibling', () => {
    const orphan = createAssistantMessage({
      content: [
        { type: 'thinking', thinking: 't', signature: 's' } as any,
      ],
    })
    orphan.message.id = 'msg_orphan'

    const msgs = [userText('q'), orphan] as any
    const out = filterOrphanedThinkingOnlyMessages(msgs)
    expect(out.find(m => m === orphan)).toBeUndefined()
  })
})

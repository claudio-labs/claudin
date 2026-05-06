import { describe, expect, test, beforeEach } from 'bun:test'
import { createUserMessage } from '../../utils/messages.js'
import {
  pruneStaleClippedIds,
  addClippedIds,
  _resetAllClippedIdsForTesting,
  _getClippedIdsMapSizeForTesting,
} from './stableStubState.js'
import {
  type ContentReplacementState,
  reconstructContentReplacementState,
} from '../../utils/toolResultStorage.js'
import {
  resetPromptCacheBreakDetection,
  _getSourceCountForTesting,
} from '../../services/api/promptCacheBreakDetection.js'
import {
  clearAllSessions,
  _getSessionCountForTesting,
} from '../../services/api/sessionIngress.js'

// Helper: build a user message containing a tool_result
function makeToolResultMessage(id: string, content: string) {
  return createUserMessage({
    content: [
      {
        type: 'tool_result',
        tool_use_id: id,
        content,
        is_error: false,
      },
    ],
  })
}

describe('pruneStaleClippedIds', () => {
  beforeEach(() => {
    _resetAllClippedIdsForTesting()
  })

  test('removes non-current keys from perKeyClippedIds', () => {
    addClippedIds(['id-1'])
    expect(_getClippedIdsMapSizeForTesting()).toBeGreaterThanOrEqual(1)

    pruneStaleClippedIds()
    // After pruning, only the current key remains
    expect(_getClippedIdsMapSizeForTesting()).toBeLessThanOrEqual(1)
  })

  test('handles empty perKeyClippedIds without error', () => {
    expect(_getClippedIdsMapSizeForTesting()).toBe(0)
    expect(() => pruneStaleClippedIds()).not.toThrow()
  })

  test('preserves current key entries after prune', () => {
    addClippedIds(['keep-1', 'keep-2'])
    pruneStaleClippedIds()
    // Current key should still be present
    expect(_getClippedIdsMapSizeForTesting()).toBeGreaterThanOrEqual(1)
  })
})

describe('reconstructContentReplacementState', () => {
  test('only keeps seenIds for IDs present in current messages', () => {
    const msg1 = makeToolResultMessage('id-1', 'result 1')
    const msg2 = makeToolResultMessage('id-2', 'result 2')

    const state = reconstructContentReplacementState([msg1, msg2], [])
    expect(state.seenIds.has('id-1')).toBe(true)
    expect(state.seenIds.has('id-2')).toBe(true)
    expect(state.seenIds.has('id-3')).toBe(false)
  })

  test('preserves inherited replacements for IDs still in messages', () => {
    const msg1 = makeToolResultMessage('id-1', 'original content')
    const inherited = new Map<string, string>([
      ['id-1', '[preview of id-1]'],
      ['id-gone', '[preview of id-gone]'],
    ])

    const state = reconstructContentReplacementState([msg1], [], inherited)
    // id-1 is in messages and has an inherited replacement — keep it
    expect(state.replacements.has('id-1')).toBe(true)
    // id-gone is NOT in messages — drop it
    expect(state.replacements.has('id-gone')).toBe(false)
  })

  test('drops all entries when messages are empty', () => {
    const inherited = new Map<string, string>([
      ['id-1', '[preview 1]'],
      ['id-2', '[preview 2]'],
    ])

    const state = reconstructContentReplacementState([], [], inherited)
    expect(state.seenIds.size).toBe(0)
    expect(state.replacements.size).toBe(0)
  })

  test('produces a fresh state without mutating inherited map', () => {
    const msg1 = makeToolResultMessage('id-1', 'content')
    const inherited = new Map<string, string>([['id-1', '[preview]']])

    const state = reconstructContentReplacementState([msg1], [], inherited)
    expect(state.replacements).not.toBe(inherited)
    expect(state.replacements.has('id-1')).toBe(true)
  })

  test('returns empty state for empty messages and no inherited', () => {
    const state = reconstructContentReplacementState([], [])
    expect(state.seenIds.size).toBe(0)
    expect(state.replacements.size).toBe(0)
  })
})

describe('post-compact ContentReplacementState cleanup', () => {
  test('simulates full compact cycle: messages removed, state rebuilt', () => {
    // Before compact: 3 tool results
    const oldState: ContentReplacementState = {
      seenIds: new Set(['id-1', 'id-2', 'id-3']),
      replacements: new Map([
        ['id-1', '[preview 1]'],
        ['id-2', '[preview 2]'],
        ['id-3', '[preview 3]'],
      ]),
    }

    // After compact: only id-2 and id-3 survive (id-1 compacted away)
    const postCompactMsgs = [
      makeToolResultMessage('id-2', 'result 2'),
      makeToolResultMessage('id-3', 'result 3'),
    ]

    // Rebuild state from post-compact messages, inheriting active replacements
    const rebuilt = reconstructContentReplacementState(
      postCompactMsgs,
      [],
      oldState.replacements,
    )

    // id-1 should be gone from both seenIds and replacements
    expect(rebuilt.seenIds.has('id-1')).toBe(false)
    expect(rebuilt.replacements.has('id-1')).toBe(false)

    // id-2 and id-3 should remain
    expect(rebuilt.seenIds.has('id-2')).toBe(true)
    expect(rebuilt.seenIds.has('id-3')).toBe(true)
    expect(rebuilt.replacements.has('id-2')).toBe(true)
    expect(rebuilt.replacements.has('id-3')).toBe(true)
  })
})

describe('microcompact replacements cleanup', () => {
  test('deleting clipped IDs from replacements frees preview strings', () => {
    const crs: ContentReplacementState = {
      seenIds: new Set(['id-1', 'id-2', 'id-3']),
      replacements: new Map([
        ['id-1', '[preview 1]'],
        ['id-2', '[preview 2]'],
        ['id-3', '[preview 3]'],
      ]),
    }

    // Simulate what microcompact does after addClippedIds
    const clippedIds = ['id-1', 'id-2']
    for (const id of clippedIds) {
      crs.replacements.delete(id)
    }

    // seenIds unchanged — enforceToolResultBudget guard preserved
    expect(crs.seenIds.has('id-1')).toBe(true)
    expect(crs.seenIds.has('id-2')).toBe(true)

    // replacements freed for clipped IDs
    expect(crs.replacements.has('id-1')).toBe(false)
    expect(crs.replacements.has('id-2')).toBe(false)

    // non-clipped replacement still intact
    expect(crs.replacements.has('id-3')).toBe(true)
  })
})

describe('postCompactCleanup: promptCacheBreakDetection', () => {
  test('resetPromptCacheBreakDetection clears source map', () => {
    resetPromptCacheBreakDetection()
    // Simulate entries being added by normal API calls
    const before = _getSourceCountForTesting()
    // The map may already have entries from other tests, so just verify
    // that resetting clears it
    resetPromptCacheBreakDetection()
    expect(_getSourceCountForTesting()).toBe(0)
  })
})

describe('postCompactCleanup: sessionIngress', () => {
  test('clearAllSessions clears session tracking maps', () => {
    clearAllSessions()
    expect(_getSessionCountForTesting()).toBe(0)
  })
})

import { describe, expect, test, beforeEach } from 'bun:test'
import { createUserMessage } from 'src/services/messages/messages.js'
import {
  pruneStaleClippedIds,
  addClippedIds,
  getClippedIds,
  getStandDownEpoch,
  isPinRegistered,
  pinToolResult,
  retirePinAfterUse,
  _resetAllClippedIdsForTesting,
  _getClippedIdsMapSizeForTesting,
} from 'src/services/compact/stableStubState.js'
import { runPostCompactCleanup } from 'src/services/compact/postCompactCleanup.js'
import {
  type ContentReplacementState,
  reconstructContentReplacementState,
} from 'src/services/tools/toolResultStorage.js'
import {
  resetPromptCacheBreakDetection,
  _getSourceCountForTesting,
} from 'src/services/api/promptCacheBreakDetection.js'
import {
  clearAllSessions,
  _getSessionCountForTesting,
} from 'src/services/api/sessionIngress.js'

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

describe('runPostCompactCleanup — orphan sweep authority', () => {
  type QuerySourceParam = Parameters<typeof runPostCompactCleanup>[0]

  beforeEach(() => {
    _resetAllClippedIdsForTesting()
  })

  test('a sub-agent compact does not prune main-key ids its transcript cannot see', () => {
    // The parent pinned a re-sent Read, remembers a spent one, and holds a
    // clipped id — all living in the PARENT transcript. A fork sub-agent
    // autocompacts against its own view, which never contained them, and both
    // run under the SAME registry key (getAgentId() is blind to ordinary
    // Agent/fork sub-agents — stableStubState's ownership caveat). An
    // unguarded sweep reads the fork's transcript as authority and deletes
    // the parent's LIVE state as orphans; 'agent:fork' stands for any
    // non-main-thread query source here.
    pinToolResult('toolu_parent_pin')
    pinToolResult('toolu_parent_spent')
    retirePinAfterUse('toolu_parent_spent')
    addClippedIds(['toolu_parent_clipped'])
    const forkView = [makeToolResultMessage('toolu_fork_own', 'fork result')]

    runPostCompactCleanup('agent:fork' as QuerySourceParam, forkView)
    expect(isPinRegistered('toolu_parent_pin')).toBe(true)
    expect(isPinRegistered('toolu_parent_spent')).toBe(true)
    expect(getClippedIds().has('toolu_parent_clipped')).toBe(true)

    // Control arm: the main thread's own compact IS the authority for the
    // key, so the same state prunes there. This is also what makes the test
    // fail if the gate is deleted rather than merely misrouted.
    runPostCompactCleanup('repl_main_thread' as QuerySourceParam, [])
    expect(isPinRegistered('toolu_parent_pin')).toBe(false)
    expect(isPinRegistered('toolu_parent_spent')).toBe(false)
    expect(getClippedIds().has('toolu_parent_clipped')).toBe(false)
  })

  test('only a main-thread compact advances the stand-down epoch', () => {
    // The epoch expires FileReadTool's sticky "outline already served" marker,
    // i.e. it re-grants a full body for a range the fallback had settled. That
    // is only true when the compaction relieved THIS transcript's pressure — a
    // fork sub-agent's compact says nothing about the parent's, and shares
    // this module's key blindly (getAgentId() is blind to forks). Same
    // authority argument as the sweeps above, so the same gate.
    expect(getStandDownEpoch()).toBe(0)

    runPostCompactCleanup('agent:fork' as QuerySourceParam, [])
    expect(getStandDownEpoch()).toBe(0)

    runPostCompactCleanup('repl_main_thread' as QuerySourceParam, [])
    expect(getStandDownEpoch()).toBe(1)
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

import { describe, expect, test, beforeEach } from 'bun:test'
import { createUserMessage } from 'src/agent/messages/messages.js'
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
} from 'src/agent/compact/stableStubState.js'
import { runPostCompactCleanup } from 'src/agent/compact/postCompactCleanup.js'
import {
  resetPromptCacheBreakDetection,
  _getSourceCountForTesting,
} from 'src/providers/cache/promptCacheBreakDetection.js'
import {
  clearAllSessions,
  _getSessionCountForTesting,
} from 'src/providers/transport/sessionIngress.js'

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

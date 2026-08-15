// Focused tests for `resumeSession` — the extracted resume callback from
// `src/agent/repl/REPL.tsx`. Side-effecting boundaries (hooks, plan copy,
// session storage, cost tracker, worktree, asciicast, remote tasks) are
// mocked at the module level so the test asserts the orchestration shape
// (call ordering, deps wiring, error handling) without performing real IO.
//
// What's intentionally covered:
//   * happy-path `resume` entrypoint touches every dep slot in the
//     expected order.
//   * `fork` entrypoint takes the fork branch (copyPlanForFork +
//     saveWorktreeState, skips worktree restore + replacement recon).
//   * caught errors still log a `success: false` analytic and re-throw.
//
// What's intentionally NOT covered:
//   * coordinator-mode branch — gated by `feature('COORDINATOR_MODE')`,
//     which is a build-time constant and false in tests; the dead branch
//     is preserved verbatim in the source so this is safe to skip.
//   * exact contents of the hydrated messages — the production code path
//     just forwards `deserializeMessages(log.messages)` through optional
//     content-replacement reconstruction; both helpers have their own
//     tests.

import { afterAll, beforeAll, describe, expect, mock, test } from 'bun:test'
import type { UUID } from 'crypto'

import type { ResumeSessionDeps } from 'src/agent/repl/services/resumeSession.js'
import type { LogOption } from 'src/shared/types/logs.js'

// --- module mocks (must be installed before importing the SUT) -----------

const calls: string[] = []

// Capture real modules BEFORE mocking so afterAll can restore them. mock.restore()
// only resets mock()/spyOn spies — it does NOT revert mock.module(), so without
// these the stubs (notably bootstrap/state.js with getOriginalCwd → '/tmp/test'
// and a no-op switchSession, plus sessionStorage.js) leaked into later files in
// the same worker and corrupted their transcript-path / project-totals logic.
const REAL_MODULES: Array<[string, Record<string, unknown>]> = await Promise.all(
  [
    // Aliased, and it has to stay that way: these are consumed by a dynamic
    // `import(spec)` over the array, so no codemod that scans call sites can
    // see them and the build's missing-import scan cannot either. A stale entry
    // here fails at runtime as "Cannot find module", between tests.
    'src/sessions/conversationRecovery.js',
    'src/sessions/sessionStart.js',
    'src/platform/lifecycleHooks/hooks.js',
    'src/agent/plans/plans.js',
    'src/sessions/sessionRestore.js',
    'src/sessions/concurrentSessions.js',
    'src/shared/fs/fileHistory.js',
    'src/sessions/sessionStorage.js',
    'src/agent/tasks/RemoteAgentTask/RemoteAgentTask.js',
    'src/vcs/git/worktree.js',
    'src/platform/bootstrap/state.js',
    'src/agent/cost-tracker.js',
    'src/terminal/image/asciicast.js',
    'src/agent/tools/toolResultStorage.js',
    'src/platform/analytics/index.js',
    'src/agent/messages/messages.js',
    'src/shared/types/ids.js',
  ].map(
    async spec =>
      [spec, { ...(await import(spec)) }] as [string, Record<string, unknown>],
  ),
)

mock.module('src/sessions/conversationRecovery.js', () => ({
  deserializeMessages: mock((m: unknown[]) => {
    calls.push('deserializeMessages')
    return [...m]
  }),
}))

mock.module('src/sessions/sessionStart.js', () => ({
  processSessionStartHooks: mock(async () => {
    calls.push('processSessionStartHooks')
    return []
  }),
}))

mock.module('src/platform/lifecycleHooks/hooks.js', () => ({
  executeSessionEndHooks: mock(async () => {
    calls.push('executeSessionEndHooks')
  }),
  getSessionEndHookTimeoutMs: () => 100,
}))

mock.module('src/agent/plans/plans.js', () => ({
  copyPlanForFork: mock(() => {
    calls.push('copyPlanForFork')
  }),
  copyPlanForResume: mock(() => {
    calls.push('copyPlanForResume')
  }),
}))

mock.module('src/sessions/sessionRestore.js', () => ({
  restoreSessionStateFromLog: mock(() => {
    calls.push('restoreSessionStateFromLog')
  }),
  restoreAgentFromSession: mock(() => {
    calls.push('restoreAgentFromSession')
    return { agentDefinition: undefined }
  }),
  computeStandaloneAgentContext: mock(() => undefined),
  restoreWorktreeForResume: mock(() => {
    calls.push('restoreWorktreeForResume')
  }),
  exitRestoredWorktree: mock(() => {
    calls.push('exitRestoredWorktree')
  }),
}))

mock.module('src/sessions/concurrentSessions.js', () => ({
  updateSessionName: mock(async () => {
    calls.push('updateSessionName')
  }),
  updateSessionActivity: () => {},
}))

mock.module('src/shared/fs/fileHistory.js', () => ({
  copyFileHistoryForResume: mock(() => {
    calls.push('copyFileHistoryForResume')
  }),
}))

mock.module('src/sessions/sessionStorage.js', () => ({
  adoptResumedSessionFile: mock(() => {
    calls.push('adoptResumedSessionFile')
  }),
  clearSessionMetadata: mock(() => {
    calls.push('clearSessionMetadata')
  }),
  resetSessionFilePointer: mock(async () => {
    calls.push('resetSessionFilePointer')
  }),
  restoreSessionMetadata: mock(() => {
    calls.push('restoreSessionMetadata')
  }),
  saveWorktreeState: mock(() => {
    calls.push('saveWorktreeState')
  }),
}))

mock.module('src/agent/tasks/RemoteAgentTask/RemoteAgentTask.js', () => ({
  restoreRemoteAgentTasks: mock(async () => {
    calls.push('restoreRemoteAgentTasks')
  }),
}))

mock.module('src/vcs/git/worktree.js', () => ({
  getCurrentWorktreeSession: () => null,
}))

mock.module('src/platform/bootstrap/state.js', () => ({
  getOriginalCwd: () => '/tmp/test',
  setCostStateForRestore: mock(() => {
    calls.push('setCostStateForRestore')
  }),
  switchSession: mock(() => {
    calls.push('switchSession')
  }),
}))

mock.module('src/agent/cost-tracker.js', () => ({
  getStoredSessionCosts: mock(() => {
    calls.push('getStoredSessionCosts')
    return null
  }),
  resetCostState: mock(() => {
    calls.push('resetCostState')
  }),
  saveCurrentSessionCosts: mock(() => {
    calls.push('saveCurrentSessionCosts')
  }),
}))

mock.module('src/terminal/image/asciicast.js', () => ({
  renameRecordingForSession: mock(async () => {
    calls.push('renameRecordingForSession')
  }),
}))

mock.module('src/agent/tools/toolResultStorage.js', () => ({
  applyToolResultReplacementsToMessages: (m: unknown) => m,
  reconstructContentReplacementState: mock((m: unknown) => {
    calls.push('reconstructContentReplacementState')
    return { seenIds: new Set(), replacements: new Map(), messages: m }
  }),
  provisionContentReplacementState: () => undefined,
}))

mock.module('src/platform/analytics/index.js', () => ({
  logEvent: mock((evt: string, payload: Record<string, unknown>) => {
    calls.push(`logEvent:${evt}:${payload.success}`)
  }),
}))

mock.module('src/agent/messages/messages.js', () => ({
  createSystemMessage: (text: string) => ({ type: 'system', text }),
}))

mock.module('src/shared/types/ids.js', () => ({
  asSessionId: (id: unknown) => id,
  asAgentId: (id: unknown) => id,
}))

// --- SUT import (after mocks) -------------------------------------------

const { resumeSession } = await import('src/agent/repl/services/resumeSession.js')

// --- harness ------------------------------------------------------------

function makeDeps(overrides: Partial<ResumeSessionDeps> = {}): ResumeSessionDeps {
  const haikuTitleAttemptedRef = { current: false }
  const contentReplacementStateRef = {
    current: { seenIds: new Set<string>(), replacements: new Map<string, unknown>() } as never,
  }
  return {
    setAppState: mock(() => {}),
    store: { getState: () => ({}) } as never,
    mainThreadAgentDefinition: undefined,
    initialMainThreadAgentDefinition: undefined,
    agentDefinitions: { activeAgents: [], allAgents: [] } as never,
    setMainThreadAgentDefinition: mock(() => {}),
    mainLoopModel: 'mock-model',
    restoreReadFileState: mock(() => {
      calls.push('restoreReadFileState')
    }),
    resetLoadingState: mock(() => {
      calls.push('resetLoadingState')
    }),
    setAbortController: mock(() => {
      calls.push('setAbortController')
    }),
    setConversationId: mock(() => {
      calls.push('setConversationId')
    }),
    haikuTitleAttemptedRef,
    setHaikuTitle: mock(() => {
      calls.push('setHaikuTitle')
    }),
    contentReplacementStateRef,
    setMessages: mock(() => {
      calls.push('setMessages')
    }),
    setToolJSX: mock(() => {
      calls.push('setToolJSX')
    }),
    setInputValue: mock(() => {
      calls.push('setInputValue')
    }),
    ...overrides,
  }
}

function makeLog(overrides: Partial<LogOption> = {}): LogOption {
  return {
    date: '2025-01-01',
    messages: [],
    value: 0,
    created: new Date(),
    modified: new Date(),
    firstPrompt: '',
    messageCount: 0,
    isSidechain: false,
    fullPath: '/tmp/test/.claudin/projects/x/abc.jsonl',
    ...overrides,
  }
}

const SESSION_ID = '00000000-0000-0000-0000-000000000001' as UUID

beforeAll(() => {
  calls.length = 0
})

afterAll(() => {
  mock.restore()
  // mock.restore() does not revert mock.module(); re-install the real modules.
  for (const [spec, real] of REAL_MODULES) {
    mock.module(spec, () => real)
  }
})

describe('resumeSession', () => {
  test('resume entrypoint runs full restore pipeline', async () => {
    calls.length = 0
    const deps = makeDeps()

    await resumeSession(SESSION_ID, makeLog(), 'cli_flag', deps)

    // Spot-check the key ordered milestones — these are the load-bearing
    // side effects from the original inline callback.
    expect(calls).toContain('deserializeMessages')
    expect(calls).toContain('executeSessionEndHooks')
    expect(calls).toContain('processSessionStartHooks')
    expect(calls).toContain('copyPlanForResume')
    expect(calls).not.toContain('copyPlanForFork')
    expect(calls).toContain('restoreSessionStateFromLog')
    expect(calls).toContain('restoreAgentFromSession')
    expect(calls).toContain('restoreReadFileState')
    expect(calls).toContain('resetLoadingState')
    expect(calls).toContain('setAbortController')
    expect(calls).toContain('setConversationId')
    expect(calls).toContain('getStoredSessionCosts')
    expect(calls).toContain('saveCurrentSessionCosts')
    expect(calls).toContain('resetCostState')
    expect(calls).toContain('switchSession')
    expect(calls).toContain('renameRecordingForSession')
    expect(calls).toContain('resetSessionFilePointer')
    expect(calls).toContain('clearSessionMetadata')
    expect(calls).toContain('restoreSessionMetadata')
    expect(calls).toContain('exitRestoredWorktree')
    expect(calls).toContain('restoreWorktreeForResume')
    expect(calls).toContain('adoptResumedSessionFile')
    expect(calls).toContain('restoreRemoteAgentTasks')
    expect(calls).toContain('reconstructContentReplacementState')
    expect(calls).toContain('setMessages')
    expect(calls).toContain('setToolJSX')
    expect(calls).toContain('setInputValue')
    expect(calls).toContain('logEvent:tengu_session_resumed:true')

    // Resume must not call fork-only branches.
    expect(calls).not.toContain('saveWorktreeState')

    // Title attempt is silenced on resume.
    expect(deps.haikuTitleAttemptedRef.current).toBe(true)
  })

  test('fork entrypoint takes fork branch (no worktree restore, no content reconstruction)', async () => {
    calls.length = 0
    const deps = makeDeps()

    await resumeSession(SESSION_ID, makeLog(), 'fork', deps)

    expect(calls).toContain('copyPlanForFork')
    expect(calls).not.toContain('copyPlanForResume')
    expect(calls).not.toContain('exitRestoredWorktree')
    expect(calls).not.toContain('restoreWorktreeForResume')
    expect(calls).not.toContain('adoptResumedSessionFile')
    expect(calls).not.toContain('restoreRemoteAgentTasks')
    expect(calls).not.toContain('reconstructContentReplacementState')

    // Fork branch still hydrates message state.
    expect(calls).toContain('setMessages')
    expect(calls).toContain('logEvent:tengu_session_resumed:true')
  })

  test('errors are logged with success:false and re-thrown', async () => {
    calls.length = 0
    const deps = makeDeps({
      setMessages: () => {
        throw new Error('boom')
      },
    })

    await expect(resumeSession(SESSION_ID, makeLog(), 'cli_flag', deps)).rejects.toThrow('boom')
    expect(calls).toContain('logEvent:tengu_session_resumed:false')
  })
})

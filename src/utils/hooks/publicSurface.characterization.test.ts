/**
 * Characterization: public-surface snapshot for src/utils/hooks.ts.
 *
 * Locks in the set of exported names and their typeof shape before the
 * 11d split. After splitting hooks.ts into hooks/{messages, matching,
 * runner, exec, events, types}, the top-level src/utils/hooks.ts (or its
 * re-export barrel) must keep every name in this snapshot — otherwise a
 * caller somewhere will break silently. This test is intentionally
 * mechanical: no behavior, just shape.
 *
 * Type-only exports (HookBlockingError, ElicitationResponse, HookResult,
 * AggregatedHookResult, HookOutsideReplResult, ConfigChangeSource,
 * InstructionsLoadReason, InstructionsMemoryType, ElicitationHookResult,
 * ElicitationResultHookResult) cannot be observed at runtime — they are
 * checked separately by tsc via the type import below.
 */
import { describe, expect, test } from 'bun:test'
import * as hooks from '../hooks.js'

// Type-only import: if any of these names disappear after the split, tsc
// will fail this file's compilation.
import type {
  HookBlockingError,
  ElicitationResponse,
  HookResult,
  AggregatedHookResult,
  HookOutsideReplResult,
  ConfigChangeSource,
  InstructionsLoadReason,
  InstructionsMemoryType,
  ElicitationHookResult,
  ElicitationResultHookResult,
} from '../hooks.js'

// Reference each type so the import isn't tree-shaken away by tsc with
// `noUnusedLocals` style strictness. The runtime cost is zero.
type _TypeAnchor =
  | HookBlockingError
  | ElicitationResponse
  | HookResult
  | AggregatedHookResult
  | HookOutsideReplResult
  | ConfigChangeSource
  | InstructionsLoadReason
  | InstructionsMemoryType
  | ElicitationHookResult
  | ElicitationResultHookResult

const FUNCTION_EXPORTS = [
  // pure helpers
  'getSessionEndHookTimeoutMs',
  'shouldSkipHookDueToTrust',
  'createBaseHookInput',
  // matching
  'getMatchingHooks',
  // message formatters
  'getPreToolHookBlockingMessage',
  'getStopHookMessage',
  'getTeammateIdleHookMessage',
  'getTaskCreatedHookMessage',
  'getTaskCompletedHookMessage',
  'getUserPromptSubmitHookBlockingMessage',
  // outside-REPL helpers
  'hasBlockingResult',
  // tool-hook executors (async generators)
  'executePreToolHooks',
  'executePostToolHooks',
  'executePostToolUseFailureHooks',
  'executePermissionDeniedHooks',
  'executePermissionRequestHooks',
  // lifecycle executors
  'executeNotificationHooks',
  'executeStopFailureHooks',
  'executeStopHooks',
  'executeTeammateIdleHooks',
  'executeTaskCreatedHooks',
  'executeTaskCompletedHooks',
  'executeUserPromptSubmitHooks',
  'executeSessionStartHooks',
  'executeSetupHooks',
  'executeSubagentStartHooks',
  'executePreCompactHooks',
  'executePostCompactHooks',
  'executeSessionEndHooks',
  // config / file watchers
  'executeConfigChangeHooks',
  'executeCwdChangedHooks',
  'executeFileChangedHooks',
  // instructions
  'hasInstructionsLoadedHook',
  'executeInstructionsLoadedHooks',
  // elicitation
  'executeElicitationHooks',
  'executeElicitationResultHooks',
  // statusline / file suggestions
  'executeStatusLineCommand',
  'executeFileSuggestionCommand',
  // worktree
  'hasWorktreeCreateHook',
  'executeWorktreeCreateHook',
  'executeWorktreeRemoveHook',
]

describe('hooks.ts public surface — runtime exports', () => {
  test.each(FUNCTION_EXPORTS)('exports %s as a function', name => {
    const exported = (hooks as Record<string, unknown>)[name]
    expect(typeof exported).toBe('function')
  })

  test('export count matches the locked snapshot (functions + types)', () => {
    // 41 function exports + 10 type-only exports = 51 total exports.
    // If you add/remove an export, update this number AND the list above
    // (or the type imports) — the discrepancy is the point.
    expect(FUNCTION_EXPORTS).toHaveLength(41)
  })
})

describe('hooks.ts public surface — async-generator vs async fn shape', () => {
  // Generators have constructor.name = 'GeneratorFunction' or
  // 'AsyncGeneratorFunction'. The split must preserve generator-ness
  // for streaming consumers (REPL, AgentTool, etc.).
  const ASYNC_GENERATORS = [
    'executePreToolHooks',
    'executePostToolHooks',
    'executePostToolUseFailureHooks',
    'executePermissionDeniedHooks',
    'executePermissionRequestHooks',
    'executeStopHooks',
    'executeTeammateIdleHooks',
    'executeTaskCreatedHooks',
    'executeTaskCompletedHooks',
    'executeUserPromptSubmitHooks',
    'executeSessionStartHooks',
    'executeSetupHooks',
    'executeSubagentStartHooks',
  ]

  test.each(ASYNC_GENERATORS)('%s is an AsyncGenerator function', name => {
    const fn = (hooks as Record<string, unknown>)[name] as Function
    expect(fn.constructor.name).toBe('AsyncGeneratorFunction')
  })

  const ASYNC_FUNCTIONS = [
    'executeNotificationHooks',
    'executeStopFailureHooks',
    'executePreCompactHooks',
    'executePostCompactHooks',
    'executeSessionEndHooks',
    'executeConfigChangeHooks',
    'executeInstructionsLoadedHooks',
    'executeElicitationHooks',
    'executeElicitationResultHooks',
    'executeStatusLineCommand',
    'executeFileSuggestionCommand',
    'executeWorktreeCreateHook',
    'executeWorktreeRemoveHook',
    'getMatchingHooks',
  ]

  test.each(ASYNC_FUNCTIONS)('%s is an AsyncFunction', name => {
    const fn = (hooks as Record<string, unknown>)[name] as Function
    expect(fn.constructor.name).toBe('AsyncFunction')
  })

  const SYNC_FUNCTIONS = [
    'getSessionEndHookTimeoutMs',
    'shouldSkipHookDueToTrust',
    'createBaseHookInput',
    'getPreToolHookBlockingMessage',
    'getStopHookMessage',
    'getTeammateIdleHookMessage',
    'getTaskCreatedHookMessage',
    'getTaskCompletedHookMessage',
    'getUserPromptSubmitHookBlockingMessage',
    'hasBlockingResult',
    'executeCwdChangedHooks',
    'executeFileChangedHooks',
    'hasInstructionsLoadedHook',
    'hasWorktreeCreateHook',
  ]

  test.each(SYNC_FUNCTIONS)('%s is a synchronous Function', name => {
    const fn = (hooks as Record<string, unknown>)[name] as Function
    expect(fn.constructor.name).toBe('Function')
  })
})

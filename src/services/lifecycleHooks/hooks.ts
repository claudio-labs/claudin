// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
/**
 * Hooks are user-defined shell commands that can be executed at various points
 * in Claude Code's lifecycle.
 *
 * This module is now a thin barrel that preserves the legacy import surface
 * (~60 call sites import from `src/services/lifecycleHooks/hooks.js`). The actual code lives in
 * `./hooks/`:
 *
 *   - types.ts          shared discriminated types + zod schemas
 *   - shared.ts         constants, trust check, base input, hook-chain dispatch
 *   - parsing.ts        hook output parsing + JSON post-processing
 *   - matching.ts       hook discovery + matcher predicates
 *   - runners.ts        execCommandHook + background subprocess pipeline
 *   - executors.ts      executeHooksOutsideREPL orchestrator + telemetry helpers
 *   - events.ts         lifecycle event dispatchers (notification, stop-failure,
 *                       pre/post-compact, session-end, config-change, env,
 *                       cwd/file-changed, instructions-loaded, elicitation,
 *                       worktree create/remove)
 *   - executeHooks.ts   private executeHooks generator + executeFunctionHook +
 *                       executeHookCallback (core hook fan-out)
 *   - replHooks.ts      REPL/tool-driven dispatchers (pre/post-tool,
 *                       permission-denied, stop, teammate-idle, task
 *                       created/completed, user-prompt-submit, session-start,
 *                       setup, subagent-start, permission-request,
 *                       status-line, file-suggestion) + message formatters
 */
export { getSessionEndHookTimeoutMs } from './shared.js'
export { getMatchingHooks } from './matching.js'
export { hasBlockingResult } from './executors.js'
export {
  executeNotificationHooks,
  executeStopFailureHooks,
  executePreCompactHooks,
  executePostCompactHooks,
  executeSessionEndHooks,
  executeConfigChangeHooks,
  executeCwdChangedHooks,
  executeFileChangedHooks,
  hasInstructionsLoadedHook,
  executeInstructionsLoadedHooks,
  executeElicitationHooks,
  executeElicitationResultHooks,
  hasWorktreeCreateHook,
  executeWorktreeCreateHook,
  executeWorktreeRemoveHook,
} from './events.js'
export type {
  ConfigChangeSource,
  ElicitationHookResult,
  ElicitationResultHookResult,
  InstructionsLoadReason,
  InstructionsMemoryType,
} from './types.js'
export {
  shouldSkipHookDueToTrust,
  createBaseHookInput,
} from './shared.js'
export type {
  HookBlockingError,
  ElicitationResponse,
  HookResult,
  AggregatedHookResult,
  HookOutsideReplResult,
} from './types.js'
export {
  getPreToolHookBlockingMessage,
  getStopHookMessage,
  getTeammateIdleHookMessage,
  getTaskCreatedHookMessage,
  getTaskCompletedHookMessage,
  getUserPromptSubmitHookBlockingMessage,
  executePreToolHooks,
  executePostToolHooks,
  executePostToolUseFailureHooks,
  executePermissionDeniedHooks,
  executeStopHooks,
  executeTeammateIdleHooks,
  executeTaskCreatedHooks,
  executeTaskCompletedHooks,
  executeUserPromptSubmitHooks,
  executeSessionStartHooks,
  executeSetupHooks,
  executeSubagentStartHooks,
  executePermissionRequestHooks,
  executeStatusLineCommand,
  executeFileSuggestionCommand,
} from './replHooks.js'
export { executeHooks } from './executeHooks.js'

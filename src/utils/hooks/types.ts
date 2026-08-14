import type { ElicitResult } from '@modelcontextprotocol/sdk/types.js'
import type { HookResultMessage } from 'src/types/message.js'
import type {
  HookCallback,
  PermissionRequestResult,
} from 'src/types/hooks.js'
import type { HookCommand } from 'src/utils/settings/types.js'
import type { PermissionResult } from 'src/utils/permissions/PermissionResult.js'
import type { FunctionHook } from './sessionHooks.js'

export interface HookBlockingError {
  blockingError: string
  command: string
}

/** Re-export ElicitResult from MCP SDK as ElicitationResponse for backward compat. */
export type ElicitationResponse = ElicitResult

export interface HookResult {
  message?: HookResultMessage
  systemMessage?: string
  blockingError?: HookBlockingError
  outcome: 'success' | 'blocking' | 'non_blocking_error' | 'cancelled'
  preventContinuation?: boolean
  stopReason?: string
  /**
   * /goal stop-condition judge verdict: the condition can never be satisfied
   * in this session. Surfaced as outcome 'success' (the stop is allowed)
   * with this flag set so callers can distinguish it from "met".
   */
  impossible?: boolean
  permissionBehavior?: 'ask' | 'deny' | 'allow' | 'passthrough'
  hookPermissionDecisionReason?: string
  additionalContext?: string
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  elicitationResponse?: ElicitationResponse
  watchPaths?: string[]
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
  hook: HookCommand | HookCallback | FunctionHook
}

export type AggregatedHookResult = {
  message?: HookResultMessage
  blockingError?: HookBlockingError
  /**
   * The blocking error came from the /goal stop-condition judge (hook branded
   * by markStopConditionJudge — see stopConditionJudge.ts). Lets the stop
   * pipeline count goal iterations and keep judge blocks out of "Stop hook
   * error" surfacing without pattern-matching on the error text.
   */
  fromStopConditionJudge?: boolean
  preventContinuation?: boolean
  stopReason?: string
  /** See HookResult.impossible — stop-condition judged unachievable. */
  impossible?: boolean
  hookPermissionDecisionReason?: string
  hookSource?: string
  permissionBehavior?: PermissionResult['behavior']
  additionalContexts?: string[]
  initialUserMessage?: string
  updatedInput?: Record<string, unknown>
  updatedMCPToolOutput?: unknown
  permissionRequestResult?: PermissionRequestResult
  watchPaths?: string[]
  elicitationResponse?: ElicitationResponse
  elicitationResultResponse?: ElicitationResponse
  retry?: boolean
}

export type HookOutsideReplResult = {
  command: string
  succeeded: boolean
  output: string
  blocked: boolean
  watchPaths?: string[]
  systemMessage?: string
}

export type ConfigChangeSource =
  | 'user_settings'
  | 'project_settings'
  | 'local_settings'
  | 'policy_settings'
  | 'skills'

export type InstructionsLoadReason =
  | 'session_start'
  | 'nested_traversal'
  | 'path_glob_match'
  | 'include'
  | 'compact'

export type InstructionsMemoryType = 'User' | 'Project' | 'Local' | 'Managed'

/** Result of an elicitation hook execution (non-REPL path). */
export type ElicitationHookResult = {
  elicitationResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

/** Result of an elicitation-result hook execution (non-REPL path). */
export type ElicitationResultHookResult = {
  elicitationResultResponse?: ElicitationResponse
  blockingError?: HookBlockingError
}

/** Hook matched against an event, annotated with its provenance. */
export type MatchedHook = {
  hook: HookCommand | HookCallback | FunctionHook
  pluginRoot?: string
  pluginId?: string
  skillRoot?: string
  hookSource?: string
}

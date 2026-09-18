/**
 * Shared helpers extracted from src/platform/lifecycleHooks/hooks.ts (refactor 11d, step 2).
 *
 * Pure / low-dependency utilities used across hook execution paths:
 * - Constants: TOOL_HOOK_EXECUTION_TIMEOUT_MS, SessionEnd timeout
 * - Trust / interactivity gate: shouldSkipHookDueToTrust
 * - Common payload builder: createBaseHookInput
 * - Hook identity helpers: isInternalHook, hookDedupKey
 */
import { getCwd } from 'src/shared/fs/cwd.js'
import {
  getSessionId,
  getIsNonInteractiveSession,
  getMainThreadAgentType,
} from 'src/platform/bootstrap/state.js'
import { checkHasTrustDialogAccepted } from 'src/platform/config/config.js'
import { getTranscriptPathForSession } from 'src/sessions/sessionStorage.js'
import type { MatchedHook } from 'src/platform/lifecycleHooks/types.js'

export const TOOL_HOOK_EXECUTION_TIMEOUT_MS = 10 * 60 * 1000

/**
 * SessionEnd hooks run during shutdown/clear and need a much tighter bound
 * than TOOL_HOOK_EXECUTION_TIMEOUT_MS. This value is used by callers as both
 * the per-hook default timeout AND the overall AbortSignal cap (hooks run in
 * parallel, so one value suffices). Overridable via env var for users whose
 * teardown scripts need more time.
 */
const SESSION_END_HOOK_TIMEOUT_MS_DEFAULT = 1500

export function getSessionEndHookTimeoutMs(): number {
  const raw = process.env.CLAUDIN_SESSIONEND_HOOKS_TIMEOUT_MS
  const parsed = raw ? parseInt(raw, 10) : NaN
  return Number.isFinite(parsed) && parsed > 0
    ? parsed
    : SESSION_END_HOOK_TIMEOUT_MS_DEFAULT
}

export function shouldSkipHookDueToTrust(): boolean {
  // In non-interactive mode (SDK), trust is implicit - always execute
  const isInteractive = !getIsNonInteractiveSession()
  if (!isInteractive) {
    return false
  }

  // In interactive mode, ALL hooks require trust
  const hasTrust = checkHasTrustDialogAccepted()
  return !hasTrust
}

/**
 * Creates the base hook input that's common to all hook types
 */
export function createBaseHookInput(
  permissionMode?: string,
  sessionId?: string,
  // Typed narrowly (not ToolUseContext) so callers can pass toolUseContext
  // directly via structural typing without this function depending on Tool.ts.
  agentInfo?: { agentId?: string; agentType?: string },
): {
  session_id: string
  transcript_path: string
  cwd: string
  permission_mode?: string
  agent_id?: string
  agent_type?: string
} {
  const resolvedSessionId = sessionId ?? getSessionId()
  // agent_type: subagent's type (from toolUseContext) takes precedence over
  // the session's --agent flag. Hooks use agent_id presence to distinguish
  // subagent calls from main-thread calls in a --agent session.
  const resolvedAgentType = agentInfo?.agentType ?? getMainThreadAgentType()
  return {
    session_id: resolvedSessionId,
    transcript_path: getTranscriptPathForSession(resolvedSessionId),
    cwd: getCwd(),
    permission_mode: permissionMode,
    agent_id: agentInfo?.agentId,
    agent_type: resolvedAgentType,
  }
}

export function isInternalHook(matched: MatchedHook): boolean {
  return matched.hook.type === 'callback' && matched.hook.internal === true
}

/**
 * Build a dedup key for a matched hook, namespaced by source context.
 *
 * Settings-file hooks (no pluginRoot/skillRoot) share the '' prefix so the
 * same command defined in user/project/local still collapses to one — the
 * original intent of the dedup. Plugin/skill hooks get their root as the
 * prefix, so two plugins sharing an unexpanded `${CLAUDIN_PLUGIN_ROOT}/hook.sh`
 * template don't collapse: after expansion they point to different files.
 */
export function hookDedupKey(m: MatchedHook, payload: string): string {
  return `${m.pluginRoot ?? m.skillRoot ?? ''}\0${payload}`
}

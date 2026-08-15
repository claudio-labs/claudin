/**
 * Shared helpers extracted from src/platform/lifecycleHooks/hooks.ts (refactor 11d, step 2).
 *
 * Pure / low-dependency utilities used across hook execution paths:
 * - Constants: TOOL_HOOK_EXECUTION_TIMEOUT_MS, SessionEnd timeout
 * - Trust / interactivity gate: shouldSkipHookDueToTrust
 * - Common payload builder: createBaseHookInput
 * - Hook-chain dispatch + AgentTool fallback bridge
 * - Hook identity helpers: isInternalHook, hookDedupKey
 */
import { feature } from 'bun:bundle'
import { getCwd } from 'src/shared/fs/cwd.js'
import {
  getSessionId,
  getIsNonInteractiveSession,
  getMainThreadAgentType,
} from 'src/platform/bootstrap/state.js'
import { checkHasTrustDialogAccepted } from 'src/platform/config/config.js'
import { getTranscriptPathForSession } from 'src/sessions/sessionStorage.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import { createAssistantMessage } from 'src/agent/messages/messages.js'
import { getAgentName, getTeamName, getTeammateColor } from 'src/agent/coordinator/teammate.js'
import type { ToolUseContext } from 'src/tools/Tool.js'
import type { CanUseToolFn } from 'src/permissions/useCanUseTool.js'
import type {
  HookChainOutcome,
  HookChainRuntimeContext,
  SpawnFallbackAgentRequest,
  SpawnFallbackAgentResponse,
} from 'src/platform/lifecycleHooks/hookChains.js'
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

function normalizeFallbackAgentModel(
  model: string | undefined,
): 'sonnet' | 'opus' | 'haiku' | undefined {
  if (model === 'sonnet' || model === 'opus' || model === 'haiku') {
    return model
  }
  return undefined
}

async function launchFallbackAgentFromHookChains(
  request: SpawnFallbackAgentRequest,
  toolUseContext: ToolUseContext,
  canUseTool: CanUseToolFn,
): Promise<SpawnFallbackAgentResponse> {
  try {
    const { AgentTool } = await import('src/tools/AgentTool/AgentTool.js')
    const normalizedModel = normalizeFallbackAgentModel(request.model)
    const result = await AgentTool.call(
      {
        prompt: request.prompt,
        description: request.description,
        run_in_background: true,
        ...(request.agentType ? { subagent_type: request.agentType } : {}),
        ...(normalizedModel ? { model: normalizedModel } : {}),
      },
      toolUseContext,
      canUseTool,
      createAssistantMessage({ content: [] }),
    )

    const data = result.data as
      | {
          status?: string
          agentId?: string
          agent_id?: string
        }
      | undefined
    const status = data?.status

    if (
      status === 'async_launched' ||
      status === 'completed' ||
      status === 'remote_launched' ||
      status === 'teammate_spawned'
    ) {
      return {
        launched: true,
        agentId: data?.agentId ?? data?.agent_id,
      }
    }

    return {
      launched: true,
      reason:
        status !== undefined
          ? `Fallback launched with status ${status}`
          : undefined,
    }
  } catch (error) {
    return {
      launched: false,
      reason: `Fallback launch failed: ${errorMessage(error)}`,
    }
  }
}

export async function dispatchHookChainFromHookRuntime(args: {
  eventName: 'PostToolUseFailure' | 'TaskCompleted'
  outcome: HookChainOutcome
  payload: Record<string, unknown>
  signal?: AbortSignal
  toolUseContext?: ToolUseContext
}): Promise<void> {
  try {
    if (!feature('HOOK_CHAINS')) {
      return
    }

    const { dispatchHookChainsForEvent } = await import('src/platform/lifecycleHooks/hookChains.js')

    const runtime: HookChainRuntimeContext = {
      signal: args.signal,
      senderName: getAgentName() ?? undefined,
      senderColor: getTeammateColor() ?? undefined,
      teamName: getTeamName() ?? undefined,
    }

    const chainDepth = args.toolUseContext?.queryTracking?.depth
    if (typeof chainDepth === 'number' && Number.isFinite(chainDepth)) {
      runtime.chainDepth = chainDepth
    }

    const hookChainsCanUseTool = (
      args.toolUseContext as
        | (ToolUseContext & { hookChainsCanUseTool?: CanUseToolFn })
        | undefined
    )?.hookChainsCanUseTool

    if (args.toolUseContext) {
      runtime.onSpawnFallbackAgent = request => {
        if (!hookChainsCanUseTool) {
          return Promise.resolve({
            launched: false,
            reason:
              'Fallback action requires canUseTool in this hook runtime context',
          })
        }

        return launchFallbackAgentFromHookChains(
          request,
          args.toolUseContext!,
          hookChainsCanUseTool,
        )
      }
    }

    await dispatchHookChainsForEvent({
      event: {
        eventName: args.eventName,
        outcome: args.outcome,
        payload: args.payload,
      },
      runtime,
    })
  } catch (error) {
    logForDebugging(
      `[hook-chains] Dispatch failed for ${args.eventName}: ${errorMessage(error)}`,
    )
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

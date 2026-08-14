/**
 * Periodic background summarization for coordinator mode sub-agents.
 *
 * Forks the sub-agent's conversation every ~30s using runForkedAgent()
 * to generate a 1-2 sentence progress summary. The summary is stored
 * on AgentProgress for UI display.
 *
 * Cache sharing: uses the same CacheSafeParams as the parent agent
 * to share the prompt cache. Tools are kept in the request for cache
 * key matching but denied via canUseTool callback.
 */

import type { TaskContext } from 'src/Task.js'
import { updateAgentSummary } from 'src/tasks/LocalAgentTask/LocalAgentTask.js'
import { filterIncompleteToolCalls } from 'src/tools/AgentTool/runAgent.js'
import type { AgentId } from 'src/types/ids.js'
import { logForDebugging } from 'src/utils/debug.js'
import {
  type CacheSafeParams,
  runForkedAgent,
} from 'src/coordinator/forkedAgent.js'
import { logError } from 'src/utils/log.js'
import { createUserMessage } from 'src/services/messages/messages.js'
import { getAgentTranscript } from 'src/services/session/sessionStorage.js'

const SUMMARY_INTERVAL_MS = 30_000

const RESULT_SUMMARY_PROMPT = `Produce a concise, actionable summary of your final result above, for the agent that delegated this task. Preserve: files touched (with paths), key decisions, and any next steps or caveats. Drop step-by-step narration and intermediate exploration. Do not use tools. Respond with the summary only.`

// Deny all tools via callback (NOT tools:[]) so the fork keeps the same cache
// key as the parent agent — an empty tools array would bust the shared prompt
// cache. Shared by both the periodic progress fork and the result fork.
const denySummaryTools = async () => ({
  behavior: 'deny' as const,
  message: 'No tools needed for summary',
  decisionReason: { type: 'other' as const, reason: 'summary only' },
})

// Return the first non-error assistant text block (trimmed), or null.
// onSkipApiError, if given, fires for each API-error message skipped (the
// periodic fork logs a debug breadcrumb here; the result fork never did).
function extractSummaryText(
  messages: Awaited<ReturnType<typeof runForkedAgent>>['messages'],
  onSkipApiError?: () => void,
): string | null {
  for (const msg of messages) {
    if (msg.type !== 'assistant') continue
    if (msg.isApiErrorMessage) {
      onSkipApiError?.()
      continue
    }
    const textBlock = msg.message.content.find(b => b.type === 'text')
    if (textBlock?.type === 'text' && textBlock.text.trim()) {
      return textBlock.text.trim()
    }
  }
  return null
}

/**
 * Summarize a foreground subagent's final result before it is returned to the
 * parent, to reduce the tokens the result occupies in the parent's context.
 *
 * Forks the subagent's conversation with runForkedAgent() — the same cache-safe
 * mechanism startAgentSummarization() uses — so the summary call shares the
 * subagent's prompt cache (system, tools, model, messages prefix) and the
 * incremental cost is mostly the summary's output tokens. The subagent's own
 * messages (already in memory) are used as the fork context; no transcript read.
 *
 * Opt-in and lossy: callers must fall back to the raw result on null/throw.
 * Returns the summary text, or null if no usable summary was produced.
 */
export async function summarizeAgentResult(
  cacheSafeParams: CacheSafeParams,
  agentMessages: CacheSafeParams['forkContextMessages'],
  abortSignal: AbortSignal,
): Promise<string | null> {
  if (abortSignal.aborted) return null
  const cleanMessages = filterIncompleteToolCalls(agentMessages)
  if (cleanMessages.length === 0) return null

  // Drop the original forkContextMessages from cacheSafeParams (same reason as
  // startAgentSummarization) and rebuild from the subagent's clean messages.
  const { forkContextMessages: _drop, ...baseParams } = cacheSafeParams
  const forkParams: CacheSafeParams = {
    ...baseParams,
    forkContextMessages: cleanMessages,
  }

  // Abort the fork if the parent aborts (e.g. user hits ESC during the summary).
  const summaryAbortController = new AbortController()
  const onParentAbort = () => summaryAbortController.abort()
  abortSignal.addEventListener('abort', onParentAbort, { once: true })

  try {
    // DO NOT set maxOutputTokens — it would clamp budget_tokens and invalidate
    // the shared prompt cache (thinking config is part of the cache key).
    const result = await runForkedAgent({
      promptMessages: [createUserMessage({ content: RESULT_SUMMARY_PROMPT })],
      cacheSafeParams: forkParams,
      canUseTool: denySummaryTools,
      querySource: 'agent_summary',
      forkLabel: 'agent_result_summary',
      overrides: { abortController: summaryAbortController },
      skipTranscript: true,
    })

    if (abortSignal.aborted) return null

    return extractSummaryText(result.messages)
  } catch (e) {
    if (e instanceof Error) logError(e)
    return null
  } finally {
    abortSignal.removeEventListener('abort', onParentAbort)
  }
}

function buildSummaryPrompt(previousSummary: string | null): string {
  const prevLine = previousSummary
    ? `\nPrevious: "${previousSummary}" — say something NEW.\n`
    : ''

  return `Describe your most recent action in 3-5 words using present tense (-ing). Name the file or function, not the branch. Do not use tools.
${prevLine}
Good: "Reading runAgent.ts"
Good: "Fixing null check in validate.ts"
Good: "Running auth module tests"
Good: "Adding retry logic to fetchUser"

Bad (past tense): "Analyzed the branch diff"
Bad (too vague): "Investigating the issue"
Bad (too long): "Reviewing full branch diff and AgentTool.tsx integration"
Bad (branch name): "Analyzed adam/background-summary branch diff"`
}

export function startAgentSummarization(
  taskId: string,
  agentId: AgentId,
  cacheSafeParams: CacheSafeParams,
  setAppState: TaskContext['setAppState'],
): { stop: () => void } {
  // Drop forkContextMessages from the closure — runSummary rebuilds it each
  // tick from getAgentTranscript(). Without this, the original fork messages
  // (passed from AgentTool.tsx) are pinned for the lifetime of the timer.
  const { forkContextMessages: _drop, ...baseParams } = cacheSafeParams
  let summaryAbortController: AbortController | null = null
  let timeoutId: ReturnType<typeof setTimeout> | null = null
  let stopped = false
  let previousSummary: string | null = null

  async function runSummary(): Promise<void> {
    if (stopped) return

    logForDebugging(`[AgentSummary] Timer fired for agent ${agentId}`)

    try {
      // Read current messages from transcript
      const transcript = await getAgentTranscript(agentId)
      if (!transcript || transcript.messages.length < 3) {
        // Not enough context yet — finally block will schedule next attempt
        logForDebugging(
          `[AgentSummary] Skipping summary for ${taskId}: not enough messages (${transcript?.messages.length ?? 0})`,
        )
        return
      }

      // Filter to clean message state
      const cleanMessages = filterIncompleteToolCalls(transcript.messages)

      // Build fork params with current messages
      const forkParams: CacheSafeParams = {
        ...baseParams,
        forkContextMessages: cleanMessages,
      }

      logForDebugging(
        `[AgentSummary] Forking for summary, ${cleanMessages.length} messages in context`,
      )

      // Create abort controller for this summary
      summaryAbortController = new AbortController()

      // DO NOT set maxOutputTokens here. The fork piggybacks on the main
      // thread's prompt cache by sending identical cache-key params (system,
      // tools, model, messages prefix, thinking config). Setting maxOutputTokens
      // would clamp budget_tokens, creating a thinking config mismatch that
      // invalidates the cache.
      //
      // ContentReplacementState is cloned by default in createSubagentContext
      // from forkParams.toolUseContext (the subagent's LIVE state captured at
      // onCacheSafeParams time). No explicit override needed.
      const result = await runForkedAgent({
        promptMessages: [
          createUserMessage({ content: buildSummaryPrompt(previousSummary) }),
        ],
        cacheSafeParams: forkParams,
        canUseTool: denySummaryTools,
        querySource: 'agent_summary',
        forkLabel: 'agent_summary',
        overrides: { abortController: summaryAbortController },
        skipTranscript: true,
      })

      if (stopped) return

      // Extract summary text from result
      const summaryText = extractSummaryText(result.messages, () =>
        logForDebugging(
          `[AgentSummary] Skipping API error message for ${taskId}`,
        ),
      )
      if (summaryText) {
        logForDebugging(
          `[AgentSummary] Summary result for ${taskId}: ${summaryText}`,
        )
        previousSummary = summaryText
        updateAgentSummary(taskId, summaryText, setAppState)
      }
    } catch (e) {
      if (!stopped && e instanceof Error) {
        logError(e)
      }
    } finally {
      summaryAbortController = null
      // Reset timer on completion (not initiation) to prevent overlapping summaries
      if (!stopped) {
        scheduleNext()
      }
    }
  }

  function scheduleNext(): void {
    if (stopped) return
    timeoutId = setTimeout(runSummary, SUMMARY_INTERVAL_MS)
  }

  function stop(): void {
    logForDebugging(`[AgentSummary] Stopping summarization for ${taskId}`)
    stopped = true
    if (timeoutId) {
      clearTimeout(timeoutId)
      timeoutId = null
    }
    if (summaryAbortController) {
      summaryAbortController.abort()
      summaryAbortController = null
    }
  }

  // Start the first timer
  scheduleNext()

  return { stop }
}

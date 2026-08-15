import { randomUUID } from 'crypto'
import type { HookEvent } from 'src/platform/entrypoints/agentSdkTypes.js'
import { queryModelWithoutStreaming } from 'src/services/api/claude.js'
import type { ToolUseContext } from 'src/Tool.js'
import type { Message } from 'src/types/message.js'
import { createAttachmentMessage } from 'src/services/attachments/attachments.js'
import { createCombinedAbortSignal } from 'src/shared/combinedAbortSignal.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage } from 'src/shared/errors.js'
import type { HookResult } from 'src/platform/lifecycleHooks/types.js'
import { safeParseJSON } from 'src/shared/data/json.js'
import { createUserMessage, extractTextContent } from 'src/services/messages/messages.js'
import { getSmallFastModel } from 'src/utils/model/model.js'
import type { PromptHook } from 'src/platform/settings/types.js'
import { asSystemPrompt } from 'src/utils/systemPromptType.js'
import { addArgumentsToPrompt, hookResponseSchema } from 'src/platform/lifecycleHooks/hookHelpers.js'
import { isStopConditionJudge } from 'src/platform/lifecycleHooks/stopConditionJudge.js'
import { truncateTranscriptForHookEvaluator } from 'src/platform/lifecycleHooks/transcriptTruncation.js'

/**
 * System prompt for the generic prompt-hook evaluator (every prompt hook
 * except the /goal stop-condition judge).
 */
const GENERIC_HOOK_SYSTEM_PROMPT = `You are evaluating a hook in Claude Code.

Your response must be a JSON object matching one of the following schemas:
1. If the condition is met, return: {"ok": true}
2. If the condition is not met, return: {"ok": false, "reason": "Reason for why it is not met"}`

/**
 * System prompt for the /goal stop-condition judge — only used for hooks
 * branded by markStopConditionJudge (see stopConditionJudge.ts), never for
 * user-defined prompt Stop hooks. Verbatim from upstream Claude Code.
 */
const STOP_CONDITION_SYSTEM_PROMPT = `You are evaluating a stop-condition hook in Claude Code. Read the conversation transcript carefully, then judge whether the user-provided condition is satisfied.

Your response must be a JSON object with one of these shapes:
- {"ok": true, "reason": "<quote evidence from the transcript that satisfies the condition>"}
- {"ok": false, "reason": "<quote what is missing or what blocks the condition>"}
- {"ok": false, "impossible": true, "reason": "<explain why the condition can never be satisfied>"}

Always include a "reason" field, quoting specific text from the transcript whenever possible. If the transcript does not contain clear evidence that the condition is satisfied, return {"ok": false, "reason": "insufficient evidence in transcript"}.

Only use {"ok": false, "impossible": true} when the condition is genuinely unachievable in this session — for example: the condition is self-contradictory, it depends on a resource or capability that is unavailable, or the assistant has explicitly tried, exhausted reasonable approaches, and stated it cannot be done. Apply your own judgment when deciding this — the assistant claiming the goal is impossible is evidence, not proof; independently confirm the condition is genuinely unachievable rather than deferring to the assistant's self-assessment. Do not use it just because the goal has not been reached yet or because progress is slow. When in doubt, return {"ok": false} without "impossible".`

/**
 * Wraps a stop-condition prompt for the judge. Exported for tests.
 */
export function buildStopConditionJudgePrompt(condition: string): string {
  return `Based on the conversation transcript above, has the following stopping condition been satisfied? Answer based on transcript evidence only.\n\nCondition: ${condition}`
}

/**
 * Execute a prompt-based hook using an LLM
 */
export async function execPromptHook(
  hook: PromptHook,
  hookName: string,
  hookEvent: HookEvent,
  jsonInput: string,
  signal: AbortSignal,
  toolUseContext: ToolUseContext,
  messages?: Message[],
  toolUseID?: string,
): Promise<HookResult> {
  // Use provided toolUseID or generate a new one
  const effectiveToolUseID = toolUseID || `hook-${randomUUID()}`
  // Judge semantics are keyed on hook IDENTITY (the session-only marker set
  // by buildGoalHook), never on the event: user-defined prompt Stop hooks
  // from settings.json or agent/skill frontmatter keep the legacy behavior.
  const isJudge = isStopConditionJudge(hook)
  try {
    // Goal judge: wrap the condition verbatim. Everything else: replace
    // $ARGUMENTS with the JSON input (or append it) — legacy behavior.
    const processedPrompt = isJudge
      ? buildStopConditionJudgePrompt(hook.prompt)
      : addArgumentsToPrompt(hook.prompt, jsonInput)
    logForDebugging(
      `Hooks: Processing prompt hook with prompt: ${processedPrompt}`,
    )

    const evaluatorModel = hook.model ?? getSmallFastModel()

    // Create user message directly - no need for processUserInput which would
    // trigger UserPromptSubmit hooks and cause infinite recursion
    const userMessage = createUserMessage({ content: processedPrompt })

    // Prepend conversation history if provided, truncated to fit the
    // evaluator model's context window (oldest messages dropped first).
    let transcriptMessages = messages
    if (messages && messages.length > 0) {
      const truncated = truncateTranscriptForHookEvaluator(
        messages,
        evaluatorModel,
      )
      if (truncated.omittedCount > 0) {
        logForDebugging(
          `Hooks: truncated transcript for prompt hook evaluator — ${truncated.omittedCount} earlier messages omitted`,
        )
      }
      transcriptMessages = truncated.messages
    }
    const messagesToQuery =
      transcriptMessages && transcriptMessages.length > 0
        ? [...transcriptMessages, userMessage]
        : [userMessage]

    logForDebugging(
      `Hooks: Querying model with ${messagesToQuery.length} messages`,
    )

    // Query the model with Haiku
    const hookTimeoutMs = hook.timeout ? hook.timeout * 1000 : 30000

    // Combined signal: aborts if either the hook signal or timeout triggers
    const { signal: combinedSignal, cleanup: cleanupSignal } =
      createCombinedAbortSignal(signal, { timeoutMs: hookTimeoutMs })

    try {
      const response = await queryModelWithoutStreaming({
        messages: messagesToQuery,
        systemPrompt: asSystemPrompt([
          isJudge ? STOP_CONDITION_SYSTEM_PROMPT : GENERIC_HOOK_SYSTEM_PROMPT,
        ]),
        thinkingConfig: { type: 'disabled' as const },
        tools: toolUseContext.options.tools,
        signal: combinedSignal,
        options: {
          async getToolPermissionContext() {
            const appState = toolUseContext.getAppState()
            return appState.toolPermissionContext
          },
          model: evaluatorModel,
          // The judge must answer with the JSON verdict, never a tool call.
          // tools stays populated (the Anthropic API requires tool definitions
          // when the transcript contains tool_use/tool_result blocks), but
          // tool_choice:none forbids new tool calls — without it the evaluator
          // model sometimes "verifies" the condition by calling Read/Bash,
          // which yields an empty text body and a spurious "JSON validation
          // failed" non-blocking error (observed live with haiku-4-5).
          toolChoice: isJudge ? { type: 'none' } : undefined,
          isNonInteractiveSession: true,
          hasAppendSystemPrompt: false,
          agents: [],
          querySource: 'hook_prompt',
          mcpTools: [],
          agentId: toolUseContext.agentId,
          outputFormat: {
            type: 'json_schema',
            schema: {
              type: 'object',
              properties: {
                ok: { type: 'boolean' },
                reason: { type: 'string' },
                // The impossible verdict only exists for the goal judge
                ...(isJudge && { impossible: { type: 'boolean' } }),
              },
              required: isJudge ? ['ok', 'reason'] : ['ok'],
              additionalProperties: false,
            },
          },
        },
      })

      cleanupSignal()

      // Extract text content from response
      const content = extractTextContent(response.message.content)

      // Update response length for spinner display
      toolUseContext.setResponseLength(length => length + content.length)

      const fullResponse = content.trim()
      logForDebugging(`Hooks: Model response: ${fullResponse}`)

      const json = safeParseJSON(fullResponse)
      if (!json) {
        logForDebugging(
          `Hooks: error parsing response as JSON: ${fullResponse}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: 'JSON validation failed',
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      const parsed = hookResponseSchema().safeParse(json)
      if (!parsed.success) {
        logForDebugging(
          `Hooks: model response does not conform to expected schema: ${parsed.error.message}`,
        )
        return {
          hook,
          outcome: 'non_blocking_error',
          message: createAttachmentMessage({
            type: 'hook_non_blocking_error',
            hookName,
            toolUseID: effectiveToolUseID,
            hookEvent,
            stderr: `Schema validation failed: ${parsed.error.message}`,
            stdout: fullResponse,
            exitCode: 1,
          }),
        }
      }

      // Failed to meet condition
      if (!parsed.data.ok) {
        // Goal judge ruled the condition unachievable: allow the stop
        // (success outcome) and surface the verdict via `impossible`.
        if (isJudge && parsed.data.impossible) {
          logForDebugging(
            `Hooks: Stop condition judged impossible: ${parsed.data.reason}`,
          )
          return {
            hook,
            outcome: 'success',
            impossible: true,
            stopReason: parsed.data.reason,
            message: createAttachmentMessage({
              type: 'hook_success',
              hookName,
              toolUseID: effectiveToolUseID,
              hookEvent,
              content: `Stop condition judged impossible: ${parsed.data.reason ?? 'no reason given'}`,
            }),
          }
        }

        logForDebugging(
          `Hooks: Prompt hook condition was not met: ${parsed.data.reason}`,
        )
        return {
          hook,
          outcome: 'blocking',
          blockingError: {
            blockingError: isJudge
              ? `[${hook.prompt}]: ${parsed.data.reason ?? 'Condition not met'}`
              : `Prompt hook condition was not met: ${parsed.data.reason}`,
            command: hook.prompt,
          },
          // Goal judge: blocking feedback must be fed back so the model
          // keeps working toward the condition — preventContinuation would
          // halt the session instead (see src/query/stopHooks.ts). All other
          // prompt hooks keep the legacy halting behavior.
          preventContinuation: !isJudge,
          stopReason: parsed.data.reason,
        }
      }

      // Condition was met
      logForDebugging(`Hooks: Prompt hook condition was met`)
      return {
        hook,
        outcome: 'success',
        // The judge's ok:true reason becomes the goal's "achieved" notice
        ...(isJudge && { stopReason: parsed.data.reason }),
        message: createAttachmentMessage({
          type: 'hook_success',
          hookName,
          toolUseID: effectiveToolUseID,
          hookEvent,
          content: '',
        }),
      }
    } catch (error) {
      cleanupSignal()

      if (combinedSignal.aborted) {
        return {
          hook,
          outcome: 'cancelled',
        }
      }
      throw error
    }
  } catch (error) {
    const errorMsg = errorMessage(error)
    logForDebugging(`Hooks: Prompt hook error: ${errorMsg}`)
    return {
      hook,
      outcome: 'non_blocking_error',
      message: createAttachmentMessage({
        type: 'hook_non_blocking_error',
        hookName,
        toolUseID: effectiveToolUseID,
        hookEvent,
        stderr: `Error executing prompt hook: ${errorMsg}`,
        stdout: '',
        exitCode: 1,
      }),
    }
  }
}

import { z } from 'zod/v4'
import {
  clearPendingSessionWakeup,
  getPendingSessionWakeup,
  setPendingSessionWakeup,
  setScheduledTasksEnabled,
} from '../../bootstrap/state.js'
import type { ToolUseContext, ValidationResult } from '../../Tool.js'
import { buildTool, type ToolDef } from '../../Tool.js'
import { logEvent } from '../../services/analytics/index.js'
import { lazySchema } from '../../utils/lazySchema.js'
import { semanticBoolean } from '../../utils/semanticBoolean.js'
import { getTeammateContext } from '../../utils/teammateContext.js'
import { isKairosCronEnabled } from '../ScheduleCronTool/prompt.js'
import {
  clampWakeupDelaySeconds,
  SCHEDULE_WAKEUP_DESCRIPTION,
  SCHEDULE_WAKEUP_PROMPT,
  SCHEDULE_WAKEUP_TOOL_NAME,
  WAKEUP_MAX_DELAY_SECONDS,
  WAKEUP_MIN_DELAY_SECONDS,
} from './prompt.js'
import { renderWakeupResultMessage, renderWakeupToolUseMessage } from './UI.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    delaySeconds: z
      .number()
      .optional()
      .describe(
        `Seconds until the wakeup fires. Clamped by the runtime to [${WAKEUP_MIN_DELAY_SECONDS}, ${WAKEUP_MAX_DELAY_SECONDS}] — out-of-range values are clamped, not rejected. Required unless cancel is true.`,
      ),
    reason: z
      .string()
      .optional()
      .describe(
        'One short sentence on what delay you chose and why — shown to the user. Required unless cancel is true.',
      ),
    prompt: z
      .string()
      .optional()
      .describe(
        'The /loop prompt to enqueue when the wakeup fires (e.g. "/loop <original prompt>" verbatim, or the <<autonomous-loop-dynamic>> sentinel for maintenance loops). Required unless cancel is true.',
      ),
    cancel: semanticBoolean(z.boolean().optional()).describe(
      'true = cancel the pending wakeup without scheduling a new one, ending the loop immediately (e.g. the user asked to stop while a wakeup was still armed). All other fields are ignored.',
    ),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    action: z.enum(['scheduled', 'cancelled']),
    /** Set when action === 'scheduled'. */
    fireAtMs: z.number().optional(),
    fireAt: z.string().optional(),
    delaySeconds: z.number().optional(),
    reason: z.string().optional(),
    replaced: z.boolean().optional(),
    /** Set when action === 'cancelled': whether a wakeup was actually pending. */
    hadPending: z.boolean().optional(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type WakeupOutput = z.infer<OutputSchema>

export const ScheduleWakeupTool = buildTool({
  name: SCHEDULE_WAKEUP_TOOL_NAME,
  searchHint: 'schedule a one-shot self-paced wakeup for /loop dynamic mode',
  maxResultSizeChars: 100_000,
  shouldDefer: true,
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  isEnabled() {
    // Wakeups ride the session cron delivery machinery, so they share the
    // cron killswitch (CLAUDE_CODE_DISABLE_CRON).
    return isKairosCronEnabled()
  },
  toAutoClassifierInput(input) {
    if (input.cancel) return 'cancel'
    return `${input.delaySeconds}s: ${input.prompt ?? ''}`
  },
  async description() {
    return SCHEDULE_WAKEUP_DESCRIPTION
  },
  async prompt() {
    return SCHEDULE_WAKEUP_PROMPT
  },
  async validateInput(
    input,
    context?: ToolUseContext,
  ): Promise<ValidationResult> {
    // The pending-wakeup slot is process-global and fires into the lead's
    // conversation — a teammate calling this would silently clobber the
    // lead's loop and misdeliver the prompt. Mirrors CronCreate's teammate
    // restriction on durable crons.
    if (getTeammateContext()) {
      return {
        result: false,
        message: `${SCHEDULE_WAKEUP_TOOL_NAME} is not available to teammates — schedule a session cron with CronCreate instead.`,
        errorCode: 1,
      }
    }
    // Same clobber risk for Task/fork subagents: they get this tool via the
    // shared pool but the slot fires into the lead conversation's queue.
    // Subagents always carry context.agentId; the lead thread does not (see
    // ToolUseContext.agentId in Tool.ts).
    if (context?.agentId) {
      return {
        result: false,
        message: `${SCHEDULE_WAKEUP_TOOL_NAME} is not available to subagents — the pending-wakeup slot belongs to the main conversation. Schedule a session cron with CronCreate instead.`,
        errorCode: 5,
      }
    }
    if (input.cancel) return { result: true }
    if (typeof input.delaySeconds !== 'number') {
      return {
        result: false,
        message: 'delaySeconds is required when scheduling a wakeup.',
        errorCode: 2,
      }
    }
    if (!input.reason?.trim()) {
      return {
        result: false,
        message:
          'reason is required when scheduling a wakeup — one short sentence shown to the user.',
        errorCode: 3,
      }
    }
    if (!input.prompt?.trim()) {
      return {
        result: false,
        message: `prompt is required when scheduling — it is what fires on wake-up. To end the loop, simply do not call ${SCHEDULE_WAKEUP_TOOL_NAME} (or pass cancel: true to kill an already-pending wakeup).`,
        errorCode: 4,
      }
    }
    return { result: true }
  },
  async call({ delaySeconds, reason, prompt, cancel = false }) {
    if (cancel) {
      const hadPending = getPendingSessionWakeup() !== null
      clearPendingSessionWakeup()
      logEvent('tengu_schedule_wakeup_cancelled', { hadPending })
      return { data: { action: 'cancelled' as const, hadPending } }
    }
    // validateInput guarantees these on the non-cancel path; the fallbacks
    // only matter for direct programmatic callers.
    const clamped = clampWakeupDelaySeconds(delaySeconds ?? NaN)
    const fireAtMs = Date.now() + clamped * 1000
    const replaced = setPendingSessionWakeup({
      fireAtMs,
      prompt: prompt ?? '',
      reason: reason ?? '',
    })
    // Start the scheduler tick loop if it isn't running yet — same flag
    // CronCreateTool flips; useScheduledTasks/runHeadless poll it.
    setScheduledTasksEnabled(true)
    logEvent('tengu_schedule_wakeup_created', {
      delaySeconds: clamped,
      replaced,
    })
    return {
      data: {
        action: 'scheduled' as const,
        fireAtMs,
        fireAt: new Date(fireAtMs).toLocaleTimeString(),
        delaySeconds: clamped,
        reason: reason ?? '',
        replaced,
      },
    }
  },
  mapToolResultToToolResultBlockParam(output, toolUseID) {
    if (output.action === 'cancelled') {
      return {
        tool_use_id: toolUseID,
        type: 'tool_result',
        content: output.hadPending
          ? 'Cancelled the pending wakeup. The loop will not resume on its own.'
          : 'No wakeup was pending — nothing to cancel.',
      }
    }
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `Wakeup scheduled for ${output.fireAt} (in ${output.delaySeconds}s) — ${output.reason}.${
        output.replaced ? ' Replaced the previously pending wakeup.' : ''
      } Session-only; it fires once while the REPL is idle. Calling ${SCHEDULE_WAKEUP_TOOL_NAME} again replaces it; omit the next call (or pass cancel: true) to end the loop.`,
    }
  },
  renderToolUseMessage: renderWakeupToolUseMessage,
  renderToolResultMessage: renderWakeupResultMessage,
} satisfies ToolDef<InputSchema, WakeupOutput>)

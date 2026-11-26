import React from 'react'
import { z } from 'zod/v4'
import { pauseActiveGoal } from 'src/agent/goal/goal.js'
import { MessageResponse } from 'src/agent/ui/MessageResponse.js'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { lazySchema } from 'src/shared/data/lazySchema.js'
import { Text } from 'src/terminal/ink.js'
import { buildTool, type Tool, type ToolDef } from 'src/tools/Tool.js'
import { PAUSE_GOAL_TOOL_NAME, PAUSE_REASON_MAX_CHARS } from 'src/tools/PauseGoalTool/constants.js'
import { DESCRIPTION, PROMPT, REASON_DESCRIPTION } from 'src/tools/PauseGoalTool/prompt.js'

const inputSchema = lazySchema(() =>
  z.strictObject({
    reason: z.string().min(1).max(PAUSE_REASON_MAX_CHARS).describe(REASON_DESCRIPTION),
  }),
)
type InputSchema = ReturnType<typeof inputSchema>

const outputSchema = lazySchema(() =>
  z.object({
    outcome: z.enum(['paused', 'already-paused']),
    reason: z.string(),
  }),
)
type OutputSchema = ReturnType<typeof outputSchema>
export type Output = z.infer<OutputSchema>

export const PauseGoalTool: Tool<InputSchema, Output> = buildTool({
  name: PAUSE_GOAL_TOOL_NAME,
  searchHint: 'pause the session goal when only the user can unblock it',
  maxResultSizeChars: 10_000,
  userFacingName: () => 'Pause goal',
  get inputSchema(): InputSchema {
    return inputSchema()
  },
  get outputSchema(): OutputSchema {
    return outputSchema()
  },
  shouldDefer: true,
  callForm: `${PAUSE_GOAL_TOOL_NAME}({"reason": "<what you need from the user>"})`,
  // Session state only: no file, no shell, nothing outside this process.
  isReadOnly() {
    return true
  },
  isConcurrencySafe() {
    return true
  },
  toAutoClassifierInput(input) {
    return input.reason
  },
  async checkPermissions(input) {
    return { behavior: 'allow', updatedInput: input }
  },
  async validateInput(_input, { agentId, getAppState }) {
    // The goal's stop check runs for the main conversation only
    // (stopHooks.ts reads activeGoal when there is no agentId).
    if (agentId) {
      return {
        result: false,
        message: 'The session goal belongs to the main conversation; a subagent cannot pause it.',
        errorCode: 1,
      }
    }
    if (!getAppState().activeGoal) {
      return {
        result: false,
        message: 'No session goal is active (the user sets one with /goal), so there is nothing to pause.',
        errorCode: 2,
      }
    }
    return { result: true }
  },
  async description() {
    return DESCRIPTION
  },
  async prompt() {
    return PROMPT
  },
  async call({ reason }, { setAppState }) {
    const outcome = pauseActiveGoal(setAppState, getSessionId(), reason)
    if (outcome === 'no-goal') {
      throw new Error('No session goal is active, so there is nothing to pause.')
    }
    return { data: { outcome, reason } }
  },
  mapToolResultToToolResultBlockParam({ outcome }, toolUseID) {
    const already = outcome === 'already-paused' ? 'The goal was already paused; its reason is updated. ' : ''
    return {
      tool_use_id: toolUseID,
      type: 'tool_result',
      content: `${already}The goal is paused. The stop check will not send you back until the user sends a message. Tell them what blocks you and what you need, then end your turn.`,
    }
  },
  renderToolUseMessage() {
    return ''
  },
  renderToolResultMessage({ reason }) {
    return (
      <MessageResponse>
        <Text>Goal paused · {reason}</Text>
      </MessageResponse>
    )
  },
} satisfies ToolDef<InputSchema, Output>)

import type { ContentBlockParam } from '@anthropic-ai/sdk/resources/messages.mjs'
import {
  REJECT_MESSAGE,
  REJECT_MESSAGE_WITH_REASON_PREFIX,
  SUBAGENT_REJECT_MESSAGE,
  SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX,
} from 'src/agent/messages/messages.js'
import type {
  PermissionAllowDecision,
  PermissionAskDecision,
  PermissionDecisionReason,
  PermissionDenyDecision,
} from 'src/shared/types/permissions.js'

type Input = Record<string, unknown>

export type AllowOptions = {
  userModified?: boolean
  decisionReason?: PermissionDecisionReason
  acceptFeedback?: string
  contentBlocks?: ContentBlockParam[]
}

export function allowDecision(input: Input, opts: AllowOptions = {}): PermissionAllowDecision {
  return {
    behavior: 'allow',
    updatedInput: input,
    userModified: opts.userModified ?? false,
    ...(opts.decisionReason ? { decisionReason: opts.decisionReason } : {}),
    ...(opts.acceptFeedback ? { acceptFeedback: opts.acceptFeedback } : {}),
    ...(opts.contentBlocks?.length ? { contentBlocks: opts.contentBlocks } : {}),
  }
}

export function denyDecision(message: string, reason: PermissionDecisionReason): PermissionDenyDecision {
  return { behavior: 'deny', message, decisionReason: reason }
}

export type CancelRequest = {
  feedback?: string
  contentBlocks?: ContentBlockParam[]
  /** Abort the turn whatever else the cancel carries. */
  abort?: boolean
  forSubAgent: boolean
}

/** The text the model reads when a call is refused, worded for who asked. */
function rejectMessage(feedback: string | undefined, forSubAgent: boolean): string {
  if (feedback) {
    return (forSubAgent ? SUBAGENT_REJECT_MESSAGE_WITH_REASON_PREFIX : REJECT_MESSAGE_WITH_REASON_PREFIX) + feedback
  }
  return forSubAgent ? SUBAGENT_REJECT_MESSAGE : REJECT_MESSAGE
}

/**
 * Whether a cancel ends the turn. Feedback or attached blocks give the model
 * something to go on, and a sub-agent's bare reject ends only the sub-agent's
 * call, so those keep the turn unless an abort is asked for.
 */
export function cancelEndsTurn(request: CancelRequest): boolean {
  if (request.abort) return true
  const saidSomething = Boolean(request.feedback) || Boolean(request.contentBlocks?.length)
  return !saidSomething && !request.forSubAgent
}

export function cancelDecision(request: CancelRequest): PermissionAskDecision {
  return {
    behavior: 'ask',
    message: rejectMessage(request.feedback, request.forSubAgent),
    contentBlocks: request.contentBlocks,
  }
}

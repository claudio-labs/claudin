/**
 * SendMessage's `await_reply`: keep the call open until the agent written to
 * answers, so an agent that needs the answer to go on does not have to end its
 * turn — for a sub-agent, ending the turn is finishing the task.
 *
 * No registry of waiters: each poll reads state that already exists — the
 * waiter's own queue (a sub-agent's `pendingMessages`, main's command queue)
 * and the target's task — the way WaitFor polls a command.
 */
import {
  dequeueAllMatching,
  getCommandQueueSnapshot,
} from 'src/agent/messageQueueManager.js'
import { isAgentAuthored, pendingMessageOrigin } from 'src/agent/messages/interAgentMessages.js'
import {
  isLocalAgentTask,
  takePendingMessages,
} from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

export const AWAIT_REPLY_TIMEOUT_MS = 10 * 60_000
const POLL_MS = 250

export type AwaitReplyOutcome =
  /** Agent-written messages addressed to the waiter, from anyone. */
  | { kind: 'replied'; messages: string[] }
  /** The target stopped. `unread`: it never took the waiter's message. */
  | { kind: 'ended'; status: string; result?: string; unread: boolean }
  /** The user wrote to the waiter; their message is left for its normal path. */
  | { kind: 'user-wrote' }
  | { kind: 'timed-out' }
  | { kind: 'aborted' }

/** What each poll reads — injected, so the loop runs without a live session. */
export type AwaitReplyProbe = {
  takeReplies(): string[]
  userWrote(): boolean
  /** The target's end, or null while it runs (and always, for "main"). */
  targetEnded(): { status: string; result?: string; unread: boolean } | null
}

function delay(ms: number, signal: AbortSignal): Promise<void> {
  return new Promise(resolve => {
    if (signal.aborted) return resolve()
    const timer = setTimeout(done, ms)
    function done(): void {
      clearTimeout(timer)
      signal.removeEventListener('abort', done)
      resolve()
    }
    signal.addEventListener('abort', done, { once: true })
  })
}

export async function awaitReply(
  probe: AwaitReplyProbe,
  {
    signal,
    timeoutMs = AWAIT_REPLY_TIMEOUT_MS,
    pollMs = POLL_MS,
    now = Date.now,
  }: { signal: AbortSignal; timeoutMs?: number; pollMs?: number; now?: () => number },
): Promise<AwaitReplyOutcome> {
  const deadline = now() + timeoutMs
  for (;;) {
    if (signal.aborted) return { kind: 'aborted' }
    // A reply outranks the end it may have come with: an agent that answered
    // and then finished has answered.
    const messages = probe.takeReplies()
    if (messages.length > 0) return { kind: 'replied', messages }
    if (probe.userWrote()) return { kind: 'user-wrote' }
    const ended = probe.targetEnded()
    if (ended) return { kind: 'ended', ...ended }
    const left = deadline - now()
    if (left <= 0) return { kind: 'timed-out' }
    await delay(Math.min(pollMs, left), signal)
  }
}

const isAgentLetter = (text: string): boolean => pendingMessageOrigin(text).kind === 'agent'

/**
 * The probe for a waiter in this conversation (`context.agentId`, or main)
 * waiting on `targetAgentId` — an agent of this conversation — or on main
 * (undefined), which never ends. `letter` is what the waiter sent, if
 * anything, so an ended target can be told apart from one that never read it.
 */
export function inSessionProbe(
  context: ToolUseContext,
  targetAgentId: string | undefined,
  letter: string | undefined,
): AwaitReplyProbe {
  const waiterId = context.agentId
  const setAppState = context.setAppStateForTasks ?? context.setAppState
  const inbox =
    waiterId === undefined
      ? {
          takeReplies: () =>
            dequeueAllMatching(
              cmd =>
                cmd.agentId === undefined &&
                isAgentAuthored(cmd.origin) &&
                typeof cmd.value === 'string',
            ).map(cmd => cmd.value as string),
          userWrote: () =>
            getCommandQueueSnapshot().some(
              cmd =>
                cmd.agentId === undefined &&
                cmd.mode === 'prompt' &&
                cmd.origin === undefined &&
                !cmd.isMeta,
            ),
        }
      : {
          takeReplies: () =>
            takePendingMessages(waiterId, isAgentLetter, context.getAppState, setAppState),
          userWrote: () => {
            const task = context.getAppState().tasks[waiterId]
            return isLocalAgentTask(task) && task.pendingMessages.some(msg => !isAgentLetter(msg))
          },
        }
  return {
    ...inbox,
    targetEnded: () => {
      if (targetAgentId === undefined) return null
      const task = context.getAppState().tasks[targetAgentId]
      // Gone from state: an inline agent, which unregisters when it returns,
      // or one evicted after finishing. Its report went to whoever launched it.
      if (task === undefined) return { status: 'finished', unread: false }
      if (!isLocalAgentTask(task) || task.status === 'running' || task.status === 'pending') {
        return null
      }
      const result =
        task.result?.content.map(block => block.text).join('\n') || task.error || undefined
      return {
        status: task.status,
        result,
        unread: letter !== undefined && task.pendingMessages.includes(letter),
      }
    },
  }
}

/** The tool-result line for how a wait ended; `to` is the address waited on. */
export function describeAwaitOutcome(to: string, outcome: AwaitReplyOutcome, isMain: boolean): string {
  const again = `call SendMessage with to: ${JSON.stringify(to)}, await_reply: true and no message to wait again`
  switch (outcome.kind) {
    case 'replied':
      return outcome.messages.length === 1
        ? 'This arrived while you waited — check who sent it: it may not be the reply:'
        : `${outcome.messages.length} messages arrived while you waited — check who sent each:`
    case 'ended': {
      const unread = outcome.unread
        ? ` It stopped without reading your message; send it again to resume ${to}.`
        : ''
      // Main also gets the task's completion notice, which carries the report.
      const report =
        outcome.result && !isMain ? ` Its final report:\n${outcome.result}` : ''
      const how =
        outcome.status === 'completed' || outcome.status === 'finished'
          ? 'finished'
          : `stopped (${outcome.status})`
      return `${to} ${how} without messaging you.${unread}${report}`
    }
    case 'user-wrote':
      return `Stopped waiting: the user wrote to you — answer them first. A reply from ${to} still arrives at a later tool round, or ${again}.`
    case 'timed-out':
      return `No reply from ${to} within ${AWAIT_REPLY_TIMEOUT_MS / 60_000} minutes. It arrives at a later tool round when it comes, or ${again}.`
    case 'aborted':
      return 'Stopped waiting: interrupted.'
  }
}

import type {
  ElicitRequestParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { ElicitationRequestEvent } from 'src/mcp/elicitationHandler.js'

export type ElicitationMode = 'form' | 'url'

/** A server that omits the mode is asking for a form. */
export function modeOf(params: ElicitRequestParams): ElicitationMode {
  return params.mode === 'url' ? 'url' : 'form'
}

export function urlElicitationIdOf(params: ElicitRequestParams): string | undefined {
  return params.mode === 'url' ? params.elicitationId : undefined
}

export type NewElicitationEvent = {
  serverName: string
  requestId: string | number
  params: ElicitRequestParams
  signal: AbortSignal
  respond: (response: ElicitResult) => void
}

/** The only place an event's waiting state is decided. */
export function createElicitationEvent(
  fields: NewElicitationEvent,
): ElicitationRequestEvent {
  const event: ElicitationRequestEvent = { ...fields }
  if (modeOf(fields.params) === 'url') {
    event.waitingState = { actionLabel: 'Skip confirmation' }
  }
  return event
}

export function appendElicitation(
  queue: ElicitationRequestEvent[],
  event: ElicitationRequestEvent,
): ElicitationRequestEvent[] {
  return [...queue, event]
}

/**
 * Marks the first URL event of `serverName` waiting on `elicitationId`.
 * The queue comes back as the same array when nothing matches.
 */
export function markElicitationCompleted(
  queue: ElicitationRequestEvent[],
  serverName: string,
  elicitationId: string,
): ElicitationRequestEvent[] {
  const position = queue.findIndex(
    event =>
      event.serverName === serverName &&
      urlElicitationIdOf(event.params) === elicitationId,
  )
  if (position === -1) return queue
  return queue.map((event, index) =>
    index === position ? { ...event, completed: true } : event,
  )
}

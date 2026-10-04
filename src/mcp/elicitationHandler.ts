import type { Client } from '@modelcontextprotocol/sdk/client/index.js'
import {
  ElicitationCompleteNotificationSchema,
  type ElicitRequestParams,
  ElicitRequestSchema,
  type ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import { logMCPDebug, logMCPError } from 'src/shared/log.js'
import {
  answerElicitation,
  type ElicitationRequest,
  waitForAnswer,
} from 'src/mcp/elicitation/answerPipeline.js'
import {
  announceCompletion,
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/mcp/elicitation/hookRunners.js'
import {
  appendElicitation,
  createElicitationEvent,
  markElicitationCompleted,
} from 'src/mcp/elicitation/queue.js'

export { runElicitationHooks, runElicitationResultHooks }

export type ElicitationWaitingState = {
  actionLabel: string
  showCancel?: boolean
}

export type ElicitationRequestEvent = {
  serverName: string
  requestId: string | number
  params: ElicitRequestParams
  signal: AbortSignal
  respond: (response: ElicitResult) => void
  waitingState?: ElicitationWaitingState
  onWaitingDismiss?: (action: 'dismiss' | 'retry' | 'cancel') => void
  completed?: boolean
}

type SetAppState = (f: (prevState: AppState) => AppState) => void

/** Keeps the state object itself when the queue did not change. */
function withQueue(state: AppState, queue: ElicitationRequestEvent[]): AppState {
  if (queue === state.elicitation.queue) return state
  return { ...state, elicitation: { ...state.elicitation, queue } }
}

function queueForUser(
  request: ElicitationRequest,
  setAppState: SetAppState,
): Promise<ElicitResult> {
  return waitForAnswer(request.signal, respond => {
    const event = createElicitationEvent({ ...request, respond })
    setAppState(state =>
      withQueue(state, appendElicitation(state.elicitation.queue, event)),
    )
  })
}

export function registerElicitationHandler(
  client: Client,
  serverName: string,
  setAppState: (f: (prevState: AppState) => AppState) => void,
): void {
  try {
    client.setRequestHandler(ElicitRequestSchema, (request, extra) =>
      answerElicitation(
        {
          serverName,
          requestId: extra.requestId,
          params: request.params,
          signal: extra.signal,
        },
        {
          runRequestHooks: runElicitationHooks,
          askUser: pending => queueForUser(pending, setAppState),
          runResultHooks: runElicitationResultHooks,
          onError: logMCPError,
        },
      ),
    )
  } catch (error) {
    // The SDK refuses the handler on a client that did not declare elicitation.
    logMCPDebug(serverName, `Elicitation is not enabled: ${String(error)}`)
    return
  }

  client.setNotificationHandler(
    ElicitationCompleteNotificationSchema,
    notification => {
      const { elicitationId } = notification.params
      setAppState(state =>
        withQueue(
          state,
          markElicitationCompleted(
            state.elicitation.queue,
            serverName,
            elicitationId,
          ),
        ),
      )
      announceCompletion(serverName, elicitationId)
    },
  )
}

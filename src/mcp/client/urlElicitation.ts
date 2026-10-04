// A server that answers -32042 needs the user to open URLs before the call can
// succeed. This module reads those URLs from the error and settles each one,
// through a hook, the SDK host, or the REPL's dialog queue.
import {
  type ElicitRequestURLParams,
  type ElicitResult,
  ErrorCode,
  McpError,
} from '@modelcontextprotocol/sdk/types.js'
import type { AppState } from 'src/terminal/state/AppState.js'
import {
  runElicitationHooks,
  runElicitationResultHooks,
} from 'src/mcp/elicitationHandler.js'
import type { ElicitationEnding } from 'src/mcp/client/modelTexts.js'

function isRecord(value: unknown): value is Record<string, unknown> {
  return typeof value === 'object' && value !== null
}

function isUrlElicitation(value: unknown): value is ElicitRequestURLParams {
  return (
    isRecord(value) &&
    value.mode === 'url' &&
    typeof value.url === 'string' &&
    typeof value.elicitationId === 'string' &&
    typeof value.message === 'string'
  )
}

/** The well-formed URL elicitations of a -32042 error; undefined for any other error. Form-mode and malformed entries are ignored. */
export function urlElicitationsOf(error: unknown): ElicitRequestURLParams[] | undefined {
  if (!(error instanceof McpError) || error.code !== ErrorCode.UrlElicitationRequired) return undefined
  const listed = isRecord(error.data) ? error.data.elicitations : undefined
  return Array.isArray(listed) ? listed.filter(isUrlElicitation) : []
}

/** `undefined` means accepted: go on. */
export type CallOutcome = ElicitationEnding | undefined

export type UrlElicitationDeps = {
  serverName: string
  signal: AbortSignal
  setAppState: (f: (prev: AppState) => AppState) => void
  handleElicitation?: (
    serverName: string,
    params: ElicitRequestURLParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult>
  runHooks?: typeof runElicitationHooks
  runResultHooks?: typeof runElicitationResultHooks
}

function endingFor(action: ElicitResult['action'], by: ElicitationEnding['by']): CallOutcome {
  if (action === 'accept') return undefined
  return { action, by }
}

const RETRY_WAITING_STATE = { actionLabel: 'Retry now', showCancel: true } as const

/**
 * Queues the elicitation for the REPL dialog. Accepting in the dialog is only
 * consent (the user still has to open the URL); the wait's "retry" is what
 * accepts.
 */
function askThroughQueue(params: ElicitRequestURLParams, deps: UrlElicitationDeps): Promise<ElicitResult> {
  const { serverName, signal, setAppState } = deps
  return new Promise(resolve => {
    const settle = (result: ElicitResult) => {
      signal.removeEventListener('abort', onAbort)
      resolve(result)
    }
    const onAbort = () => settle({ action: 'cancel' })
    if (signal.aborted) {
      onAbort()
      return
    }
    signal.addEventListener('abort', onAbort, { once: true })
    setAppState(prev => ({
      ...prev,
      elicitation: {
        ...prev.elicitation,
        queue: [
          ...prev.elicitation.queue,
          {
            serverName,
            requestId: `error-elicit-${params.elicitationId}`,
            params,
            signal,
            waitingState: RETRY_WAITING_STATE,
            respond: result => {
              if (result.action !== 'accept') settle(result)
            },
            onWaitingDismiss: action => settle({ action: action === 'retry' ? 'accept' : 'cancel' }),
          },
        ],
      },
    }))
  })
}

export async function resolveUrlElicitation(
  params: ElicitRequestURLParams,
  deps: UrlElicitationDeps,
): Promise<CallOutcome> {
  const { serverName, signal } = deps
  const runHooks = deps.runHooks ?? runElicitationHooks
  const runResultHooks = deps.runResultHooks ?? runElicitationResultHooks

  const fromHook = await runHooks(serverName, params, signal)
  if (fromHook) return endingFor(fromHook.action, 'hook')

  const answer = deps.handleElicitation
    ? await deps.handleElicitation(serverName, params, signal)
    : await askThroughQueue(params, deps)
  const settled = await runResultHooks(serverName, answer, signal, 'url', params.elicitationId)
  return endingFor(settled.action, 'user')
}

export const MAX_URL_ELICITATION_ROUNDS = 3

export type ElicitedCall<T> = { kind: 'done'; result: T } | { kind: 'ended'; ending: ElicitationEnding }

/**
 * Makes the call; on -32042 settles each URL in order and calls again, at
 * most MAX_URL_ELICITATION_ROUNDS times. The next -32042 is thrown.
 */
export async function callWithUrlElicitation<T>(
  attempt: () => Promise<T>,
  resolve: (params: ElicitRequestURLParams) => Promise<CallOutcome>,
  signal: AbortSignal,
): Promise<ElicitedCall<T>> {
  for (let round = 0; ; round++) {
    if (signal.aborted) throw new Error('Tool call aborted during URL elicitation')
    try {
      return { kind: 'done', result: await attempt() }
    } catch (error) {
      const elicitations = urlElicitationsOf(error)
      if (!elicitations?.length || round >= MAX_URL_ELICITATION_ROUNDS) throw error
      for (const params of elicitations) {
        const ending = await resolve(params)
        if (ending) return { kind: 'ended', ending }
      }
    }
  }
}

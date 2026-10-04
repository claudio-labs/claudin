import type {
  ElicitRequestParams,
  ElicitResult,
} from '@modelcontextprotocol/sdk/types.js'
import { modeOf, urlElicitationIdOf } from 'src/mcp/elicitation/queue.js'

export type ElicitationRequest = {
  serverName: string
  requestId: string | number
  params: ElicitRequestParams
  /** Aborts when the server cancels the request. */
  signal: AbortSignal
}

export type AnswerPipelineDeps = {
  runRequestHooks: (
    serverName: string,
    params: ElicitRequestParams,
    signal: AbortSignal,
  ) => Promise<ElicitResult | undefined>
  askUser: (request: ElicitationRequest) => Promise<ElicitResult>
  runResultHooks: (
    serverName: string,
    result: ElicitResult,
    signal: AbortSignal,
    mode: 'form' | 'url',
    elicitationId: string | undefined,
  ) => Promise<ElicitResult>
  onError: (serverName: string, error: unknown) => void
}

const CANCELLED: ElicitResult = { action: 'cancel' }

/**
 * Request hooks first; when they leave the request open, the user answers and
 * the result hooks (which also announce the outcome) have the last word.
 * Any failure on the way answers `cancel`.
 */
export async function answerElicitation(
  request: ElicitationRequest,
  deps: AnswerPipelineDeps,
): Promise<ElicitResult> {
  const { serverName, params, signal } = request
  try {
    const fromHooks = await deps.runRequestHooks(serverName, params, signal)
    if (fromHooks) return fromHooks
    const fromUser = await deps.askUser(request)
    return await deps.runResultHooks(
      serverName,
      fromUser,
      signal,
      modeOf(params),
      urlElicitationIdOf(params),
    )
  } catch (error) {
    deps.onError(serverName, error)
    return { ...CANCELLED }
  }
}

/**
 * Settles with the first answer given through `present`'s `respond`, or with
 * `cancel` once the signal aborts. Later answers are ignored, as a promise
 * settles only once.
 */
export function waitForAnswer(
  signal: AbortSignal,
  present: (respond: (answer: ElicitResult) => void) => void,
): Promise<ElicitResult> {
  return new Promise((resolve, reject) => {
    if (signal.aborted) {
      resolve({ ...CANCELLED })
      return
    }
    const settle = (answer: ElicitResult) => {
      signal.removeEventListener('abort', onAbort)
      resolve(answer)
    }
    const onAbort = () => settle({ ...CANCELLED })
    signal.addEventListener('abort', onAbort)
    try {
      present(settle)
    } catch (error) {
      signal.removeEventListener('abort', onAbort)
      reject(error)
    }
  })
}

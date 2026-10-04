/**
 * The same question asked of the web app over the bridge. Whoever answers
 * first wins; the other side is told, or has its prompt withdrawn.
 */
import { randomUUID } from 'crypto'
import type {
  BridgePermissionCallbacks,
  BridgePermissionResponse,
} from 'src/platform/bridge/bridgePermissionCallbacks.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { RemoteAnswer } from 'src/permissions/toolPermission/remoteAnswer.js'

export type RemoteQuestion = {
  toolName: string
  input: Record<string, unknown>
  toolUseID: string
  description: string
  suggestions: PermissionUpdate[] | undefined
  blockedPath: string | undefined
}

export type RemotePrompt = {
  /** Tells the web app how the terminal answered, then withdraws its prompt. */
  report(response: BridgePermissionResponse): void
  /** Withdraws the prompt without an answer: somebody else decided. */
  withdraw(): void
  /** Stops listening, once the web app's own answer was taken. */
  close(): void
}

function toRemoteAnswer(response: BridgePermissionResponse): RemoteAnswer {
  if (response.behavior === 'allow') {
    return { behavior: 'allow', updatedInput: response.updatedInput, updatedPermissions: response.updatedPermissions ?? [] }
  }
  return { behavior: 'deny', message: response.message }
}

export function openRemotePrompt(
  callbacks: BridgePermissionCallbacks,
  signal: AbortSignal,
  question: RemoteQuestion,
  onAnswer: (answer: RemoteAnswer) => void,
): RemotePrompt {
  const requestId = randomUUID()
  callbacks.sendRequest(
    requestId,
    question.toolName,
    question.input,
    question.toolUseID,
    question.description,
    question.suggestions,
    question.blockedPath,
  )
  const unsubscribe = callbacks.onResponse(requestId, response => onAnswer(toRemoteAnswer(response)))
  let listening = true
  const close = (): void => {
    if (!listening) return
    listening = false
    signal.removeEventListener('abort', close)
    unsubscribe()
  }
  signal.addEventListener('abort', close, { once: true })
  return {
    report(response) {
      callbacks.sendResponse(requestId, response)
      callbacks.cancelRequest(requestId)
      close()
    },
    withdraw() {
      callbacks.cancelRequest(requestId)
      close()
    },
    close,
  }
}

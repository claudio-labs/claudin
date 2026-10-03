import { useCallback, useEffect, useRef } from 'react'
import { isLocalAgentTask } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import {
  type MirroredMessages,
  releaseForeground,
  shouldMirror,
} from 'src/sessions/hooks/sessionBackgrounding/foreground.js'
import type { Message } from 'src/shared/types/message.js'
import { useAppState, useSetAppState } from 'src/terminal/state/AppState.js'

type UseSessionBackgroundingProps = {
  setMessages: (messages: Message[] | ((prev: Message[]) => Message[])) => void
  setIsLoading: (loading: boolean) => void
  resetLoadingState: () => void
  setAbortController: (controller: AbortController | null) => void
  onBackgroundQuery: () => void
}

type UseSessionBackgroundingResult = {
  handleBackgroundSession: () => void
}

/**
 * The REPL's side of an agent task brought to the foreground: its messages
 * and loading state are mirrored into the main view until it ends, is
 * aborted, or is sent back with `handleBackgroundSession`.
 */
export function useSessionBackgrounding(props: UseSessionBackgroundingProps): UseSessionBackgroundingResult {
  const setAppState = useSetAppState()
  const foregroundedId = useAppState(state => state.foregroundedTaskId)
  const foregrounded = useAppState(state => (state.foregroundedTaskId ? state.tasks[state.foregroundedTaskId] : undefined))
  const mirrored = useRef<MirroredMessages | null>(null)
  // The REPL's setters change identity between renders; the effect should follow the task, not them.
  const view = useRef(props)
  view.current = props

  useEffect(() => {
    const { setMessages, setIsLoading, resetLoadingState, setAbortController } = view.current
    // Every way out of the foreground clears foregroundedTaskId, so the count restarts here alone.
    if (!foregroundedId) {
      mirrored.current = null
      return
    }
    if (!foregrounded || !isLocalAgentTask(foregrounded)) {
      setAppState(state => ({ ...state, foregroundedTaskId: undefined }))
      resetLoadingState()
      return
    }
    if (foregrounded.status !== 'running' || foregrounded.abortController?.signal.aborted) {
      setAppState(state => releaseForeground(state, foregroundedId))
      resetLoadingState()
      setAbortController(null)
      return
    }
    const messages = foregrounded.messages ?? []
    if (shouldMirror(mirrored.current, foregroundedId, messages.length)) {
      mirrored.current = { taskId: foregroundedId, count: messages.length }
      setMessages([...messages])
    }
    setIsLoading(true)
    if (foregrounded.abortController) setAbortController(foregrounded.abortController)
  }, [foregroundedId, foregrounded, setAppState])

  const handleBackgroundSession = useCallback(() => {
    const { setMessages, resetLoadingState, setAbortController, onBackgroundQuery } = view.current
    if (!foregroundedId) {
      onBackgroundQuery()
      return
    }
    setAppState(state => releaseForeground(state, foregroundedId))
    setMessages([])
    resetLoadingState()
    setAbortController(null)
  }, [foregroundedId, setAppState])

  return { handleBackgroundSession }
}

import { useCallback, useMemo, useState } from 'react'
import { setTeleportedSessionInfo } from 'src/platform/bootstrap/state.js'
import type { CodeSession } from 'src/platform/teleport/api.js'
import { teleportResumeCodeSession } from 'src/platform/teleport/teleport.js'
import type { TeleportRemoteResponse } from 'src/sessions/conversationRecovery.js'
import { logForDebugging } from 'src/shared/debug.js'
import { errorMessage, TeleportOperationError } from 'src/shared/errors.js'

export type TeleportSource = 'cliArg' | 'localCommand'

/** What the picker shows when a resume fails. */
type ResumeFailure = {
  message: string
  /** Set only for a teleport operation error, which carries its own rendering. */
  formattedMessage: string | undefined
  isOperationError: boolean
}

type PickerState = {
  isResuming: boolean
  error: ResumeFailure | null
  selectedSession: CodeSession | null
}

const NOTHING_PICKED: PickerState = { isResuming: false, error: null, selectedSession: null }

function toResumeFailure(thrown: unknown): ResumeFailure {
  if (thrown instanceof TeleportOperationError) {
    return { message: thrown.message, formattedMessage: thrown.formattedMessage, isOperationError: true }
  }
  return { message: errorMessage(thrown), formattedMessage: undefined, isOperationError: false }
}

/** State behind the `--teleport` picker: resume a claude.ai session into this process. */
export function useTeleportResume(source: TeleportSource) {
  const [state, setState] = useState<PickerState>(NOTHING_PICKED)

  const resumeSession = useCallback(
    async (session: CodeSession): Promise<TeleportRemoteResponse | null> => {
      setState({ isResuming: true, error: null, selectedSession: session })
      logForDebugging(`Teleport resume of ${session.id} (from ${source})`)
      try {
        const resumed = await teleportResumeCodeSession(session.id)
        setTeleportedSessionInfo({ sessionId: session.id })
        setState(prev => ({ ...prev, isResuming: false }))
        return resumed
      } catch (thrown) {
        const failure = toResumeFailure(thrown)
        setState(prev => ({ ...prev, isResuming: false, error: failure }))
        return null
      }
    },
    [source],
  )

  const clearError = useCallback(() => {
    setState(prev => (prev.error === null ? prev : { ...prev, error: null }))
  }, [])

  // The wrapper's effects depend on this object, so it changes only with its parts.
  return useMemo(
    () => ({ ...state, resumeSession, clearError }),
    [state, resumeSession, clearError],
  )
}

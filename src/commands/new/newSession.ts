/**
 * What `/new` asks and what each answer does to the session being left.
 * Apart from new.tsx so a test can drive it without the machinery that
 * clears a conversation.
 */
export type NewSessionChoice = 'end' | 'keep' | 'background'

export type RunningWork = { turnActive: boolean; runningAgents: number }

export type NewSessionDeps = {
  sessionId: () => string
  /** Read again when the answer arrives: the turn may have ended while the dialog was open. */
  running: () => RunningWork
  backgroundTurn?: () => Promise<void>
  stopForegroundWork?: (keepRunning?: boolean) => void
  clear: () => Promise<void>
  close: (sessionId: string) => void
}

type NewSessionOption = {
  label: string
  value: NewSessionChoice
  description: string
}

/** `work` is what a new session would stop, in words, or undefined when nothing runs. */
export function newSessionOptions(work: string | undefined): NewSessionOption[] {
  if (!work) {
    return [
      {
        label: 'End this session',
        value: 'end',
        description: 'It moves to the inactive sessions',
      },
      {
        label: 'Keep this session open',
        value: 'keep',
        description: 'It stays green under ← for agents, to switch back to',
      },
    ]
  }
  return [
    {
      label: 'Keep it running in the background',
      value: 'background',
      description: `${work} carries on and this session stays open; a finished turn reports back as a notification`,
    },
    {
      label: 'Stop it, keep this session open',
      value: 'keep',
      description: `Stops ${work}; the session stays green under ← to switch back to`,
    },
    {
      label: 'Stop it and end this session',
      value: 'end',
      description: `Stops ${work}; the session moves to the inactive sessions`,
    },
  ]
}

/**
 * Start a new session. Kept open, the one being left stays in this
 * instance's "open here" group of the session list; ended, it reads as
 * inactive — its transcript is kept either way. `/clear` ends it without
 * asking.
 *
 * A turn still running would write into the fresh session, so it is either
 * stopped or handed to a background task first — and that hand-over is
 * awaited: the task takes the conversation as it is when it starts, and a
 * conversation cleared sooner would give it an empty one.
 */
export async function startNewSession(
  choice: NewSessionChoice,
  deps: NewSessionDeps,
): Promise<void> {
  const previous = deps.sessionId()
  const work = deps.running()
  if (work.turnActive || work.runningAgents > 0) {
    if (choice === 'background') {
      if (work.turnActive) await deps.backgroundTurn?.()
      deps.stopForegroundWork?.(true)
    } else {
      deps.stopForegroundWork?.()
    }
  }
  await deps.clear()
  if (choice === 'end') deps.close(previous)
}

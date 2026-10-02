import * as React from 'react'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { clearConversation } from 'src/commands/clear/conversation.js'
import {
  newSessionOptions,
  startNewSession,
  type NewSessionChoice,
  type NewSessionDeps,
} from 'src/commands/new/newSession.js'
import { closeInstanceSession } from 'src/sessions/instanceSessions.js'
import { readSessionPresence } from 'src/sessions/sessionPresence.js'
import { describeRunningWork } from 'src/sessions/ui/sessionRows.js'
import type { LocalJSXCommandCall } from 'src/shared/types/command.js'
import { logError } from 'src/shared/log.js'
import { Select } from 'src/terminal/custom-select/select.js'
import { Pane } from 'src/terminal/design-system/Pane.js'
import { Box, Text } from 'src/terminal/ink.js'

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const deps: NewSessionDeps = {
    sessionId: getSessionId,
    running: () => readSessionPresence(context.getAppState().tasks),
    backgroundTurn: context.backgroundTurn,
    stopForegroundWork: context.stopForegroundWork,
    clear: () => clearConversation(context),
    close: closeInstanceSession,
  }
  const finish = (choice: NewSessionChoice): void => {
    startNewSession(choice, deps).then(
      () => onDone(undefined, { display: 'skip' }),
      (error: unknown) => {
        logError(error)
        onDone('Failed to start a new session')
      },
    )
  }
  // Nothing said yet: there is nothing to keep open.
  if (context.messages.length === 0) {
    finish('end')
    return null
  }
  const { turnActive, runningAgents } = deps.running()
  const work = describeRunningWork({ busy: turnActive, runningAgents })
  return (
    <Pane>
      <Box flexDirection="column" gap={1}>
        <Text bold>Start a new session</Text>
        <Select
          options={newSessionOptions(work)}
          onChange={finish}
          onCancel={() => onDone(undefined, { display: 'skip' })}
        />
      </Box>
    </Pane>
  )
}

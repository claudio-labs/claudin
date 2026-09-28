import * as React from 'react'
import { getSessionId } from 'src/platform/bootstrap/state.js'
import { clearConversation } from 'src/commands/clear/conversation.js'
import { closeInstanceSession } from 'src/sessions/instanceSessions.js'
import type { LocalJSXCommandCall, LocalJSXCommandContext } from 'src/shared/types/command.js'
import { logError } from 'src/shared/log.js'
import { Select } from 'src/terminal/custom-select/select.js'
import { Pane } from 'src/terminal/design-system/Pane.js'
import { Box, Text } from 'src/terminal/ink.js'

type Choice = 'end' | 'keep'

const OPTIONS = [
  {
    label: 'End this session',
    value: 'end' as const,
    description: 'It moves to the inactive sessions',
  },
  {
    label: 'Keep this session open',
    value: 'keep' as const,
    description: 'It stays green under ← for agents, to switch back to',
  },
]

/**
 * Start a new session. Kept open, the one being left stays in this
 * instance's "open here" group of the session list; ended, it reads as
 * inactive — its transcript is kept either way. `/clear` ends it without
 * asking.
 */
async function startNewSession(
  choice: Choice,
  context: LocalJSXCommandContext,
): Promise<void> {
  const previous = getSessionId()
  await clearConversation(context)
  if (choice === 'end') closeInstanceSession(previous)
}

export const call: LocalJSXCommandCall = async (onDone, context) => {
  const finish = (choice: Choice): void => {
    startNewSession(choice, context).then(
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
  return (
    <Pane>
      <Box flexDirection="column" gap={1}>
        <Text bold>Start a new session</Text>
        <Select
          options={OPTIONS}
          onChange={finish}
          onCancel={() => onDone(undefined, { display: 'skip' })}
        />
      </Box>
    </Pane>
  )
}

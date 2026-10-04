import React from 'react'
import { getOriginalCwd } from 'src/platform/bootstrap/state.js'
import { Text } from 'src/terminal/ink.js'

type Props = {
  /** What the saved rule covers, shown bold. */
  subject: string
  /** Read after the subject: `commands` for the tool and shell dialogs. */
  noun?: string
  /** Name the directory the session started in, where the rule is saved. */
  inCwd?: boolean
}

/** "Yes, and don't ask again for <subject> [noun] [in <cwd>]", as one paragraph. */
export function DontAskAgainLabel({ subject, noun, inCwd = true }: Props): React.ReactNode {
  return (
    <Text>
      Yes, and don't ask again for <Text bold>{subject}</Text>
      {noun ? ` ${noun}` : ''}
      {inCwd && (
        <>
          {' in '}
          <Text bold>{getOriginalCwd()}</Text>
        </>
      )}
    </Text>
  )
}

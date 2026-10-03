import { homedir } from 'os'
import React from 'react'

import { shortenMemoryPath } from 'src/memory/ui/shortMemoryPath.js'
import { getCwd } from 'src/shared/fs/cwd.js'
import { Box, Text } from 'src/terminal/ink.js'

/** Read fresh on every call: the working directory moves during a session. */
export function getRelativeMemoryPath(path: string): string {
  return shortenMemoryPath(path, { cwd: getCwd(), home: homedir() })
}

type MemoryUpdateNotificationProps = {
  memoryPath: string
}

export function MemoryUpdateNotification({ memoryPath }: MemoryUpdateNotificationProps): React.ReactNode {
  return (
    <Box flexDirection="column" flexGrow={1}>
      <Text>
        Memory updated in {getRelativeMemoryPath(memoryPath)} · /memory to edit
      </Text>
    </Box>
  )
}

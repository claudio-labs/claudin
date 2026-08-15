import * as React from 'react'

import { Box } from 'src/terminal/ink.js'
import { shouldShowMigrationBanner } from 'src/platform/config/claudinMigration.js'
import { Pane } from 'src/terminal/design-system/Pane.js'
import { WelcomeV2 } from 'src/terminal/logo/WelcomeV2.js'
import { MigrationBanner } from 'src/platform/MigrationBanner.js'

type Props = {
  onDone: () => void
}

export function MigrationDialog({ onDone }: Props): React.ReactNode {
  const enabled = React.useMemo(() => shouldShowMigrationBanner(), [])

  React.useEffect(() => {
    if (!enabled) onDone()
  }, [enabled, onDone])

  return (
    <Box flexDirection="column">
      <WelcomeV2 />
      <Box marginTop={1}>
        <Pane color="permission">
          <Box flexDirection="column">
            <MigrationBanner enabled={enabled} onDismiss={() => onDone()} />
          </Box>
        </Pane>
      </Box>
    </Box>
  )
}

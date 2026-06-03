import * as React from 'react'

import { Box } from '../ink.js'
import { shouldShowMigrationBanner } from '../utils/claudinMigration.js'
import { Pane } from './design-system/Pane.js'
import { WelcomeV2 } from './LogoV2/WelcomeV2.js'
import { MigrationBanner } from './MigrationBanner.js'

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

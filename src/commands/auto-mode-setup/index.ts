import { feature } from 'bun:bundle'

import type { Command } from 'src/shared/types/command.js'
import { isClassifierBundled } from 'src/permissions/yoloClassifier.js'

const command = {
  type: 'local-jsx',
  name: 'auto-mode-setup',
  description:
    'Analyze this environment and propose auto mode classifier rules for it',
  isEnabled: () => {
    if (!feature('TRANSCRIPT_CLASSIFIER')) {
      return false
    }
    // Without the bundled prompts the classifier auto-allows, so tailoring it
    // would be theatre.
    return isClassifierBundled()
  },
  load: () => import('src/commands/auto-mode-setup/autoModeSetup.js'),
} satisfies Command

export default command

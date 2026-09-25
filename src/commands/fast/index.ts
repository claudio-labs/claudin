import type { Command } from 'src/commands/commands.js'
import {
  FAST_MODE_MODEL_DISPLAY,
  isFastModeEnabled,
} from 'src/providers/fastMode.js'

const fast = {
  type: 'local-jsx',
  name: 'fast',
  get description() {
    return `Toggle fast mode (${FAST_MODE_MODEL_DISPLAY} only)`
  },
  availability: ['claude-ai', 'console'],
  isEnabled: () => isFastModeEnabled(),
  get isHidden() {
    return !isFastModeEnabled()
  },
  argumentHint: '[on|off]',
  load: () => import('src/commands/fast/fast.js'),
} satisfies Command

export default fast

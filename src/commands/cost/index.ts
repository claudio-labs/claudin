/**
 * Cost command - minimal metadata only.
 * Implementation is lazy-loaded from cost.ts to reduce startup time.
 */
import type { Command } from 'src/commands.js'
import { isClaudeAISubscriber } from 'src/providers/auth/auth.js'

const cost = {
  type: 'local',
  name: 'cost',
  description: 'Show the total cost and duration of the current session',
  get isHidden() {
    return isClaudeAISubscriber()
  },
  supportsNonInteractive: true,
  load: () => import('src/commands/cost/cost.js'),
} satisfies Command

export default cost

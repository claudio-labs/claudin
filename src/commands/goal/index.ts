/**
 * /goal — set a session-scoped stopping condition.
 * Implementation is lazy-loaded from goal.ts to reduce startup time.
 */
import type { Command } from 'src/commands/commands.js'

const goal = {
  type: 'local-jsx',
  // call() always resolves via onDone (never renders JSX), so /goal works in
  // headless -p / SDK mode — where a stopping condition is most valuable,
  // since there is no user around to steer the session.
  supportsNonInteractive: true,
  name: 'goal',
  description:
    'Set a session-scoped stopping condition — an LLM judge blocks stopping until it is met',
  argumentHint: '<condition> | clear',
  load: () => import('src/commands/goal/goal.js'),
} satisfies Command

export default goal

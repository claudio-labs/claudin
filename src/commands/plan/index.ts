import type { Command } from 'src/commands/commands.js'

const plan = {
  type: 'local-jsx',
  name: 'plan',
  description: 'Enable plan mode or view the current session plan',
  argumentHint: '[open|<description>]',
  load: () => import('src/commands/plan/plan.js'),
} satisfies Command

export default plan

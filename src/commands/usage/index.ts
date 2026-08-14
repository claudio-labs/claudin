import type { Command } from 'src/commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show plan usage limits',
  load: () => import('./usage.js'),
} satisfies Command

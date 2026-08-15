import type { Command } from 'src/commands/commands.js'

export default {
  type: 'local-jsx',
  name: 'usage',
  description: 'Show plan usage limits',
  load: () => import('src/commands/usage/usage.js'),
} satisfies Command

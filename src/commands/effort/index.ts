import type { Command } from 'src/commands/commands.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  argumentHint: '[low|medium|high|max|auto]',
  load: () => import('src/commands/effort/effort.js'),
} satisfies Command

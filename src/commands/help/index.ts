import type { Command } from 'src/commands/commands.js'

const help = {
  type: 'local-jsx',
  name: 'help',
  description: 'Show help and available commands',
  load: () => import('src/commands/help/help.js'),
} satisfies Command

export default help

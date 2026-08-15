import type { Command } from 'src/commands/commands.js'

const config = {
  aliases: ['settings'],
  type: 'local-jsx',
  name: 'config',
  description: 'Open config panel',
  load: () => import('src/commands/config/config.js'),
} satisfies Command

export default config

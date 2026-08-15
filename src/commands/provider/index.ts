import type { Command } from 'src/commands/commands.js'

const provider = {
  type: 'local-jsx',
  name: 'provider',
  description: 'Manage API provider profiles',
  load: () => import('src/commands/provider/provider.js'),
} satisfies Command

export default provider

import type { Command } from 'src/commands/commands.js'

const stats = {
  type: 'local-jsx',
  name: 'stats',
  description: 'Show your Claudin usage statistics and activity',
  load: () => import('src/commands/stats/stats.js'),
} satisfies Command

export default stats

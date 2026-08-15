import type { Command } from 'src/commands.js'

const hooks = {
  type: 'local-jsx',
  name: 'hooks',
  description: 'View hook configurations for tool events',
  immediate: true,
  load: () => import('src/commands/hooks/hooks.js'),
} satisfies Command

export default hooks

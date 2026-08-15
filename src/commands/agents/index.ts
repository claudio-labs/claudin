import type { Command } from 'src/commands.js'

const agents = {
  type: 'local-jsx',
  name: 'agents',
  description: 'Manage agent configurations',
  load: () => import('src/commands/agents/agents.js'),
} satisfies Command

export default agents

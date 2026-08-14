import type { Command } from 'src/commands.js'

const workflows = {
  type: 'local-jsx',
  name: 'workflows',
  description: 'Manage and run agent workflows',
  load: () => import('./workflows.js'),
} satisfies Command

export default workflows

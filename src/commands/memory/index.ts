import type { Command } from '../../commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: 'Edit memory files; /memory tidy merges duplicate memories',
  load: () => import('./memory.js'),
}

export default memory

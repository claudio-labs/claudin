import type { Command } from 'src/commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description: 'Edit memory files; /memory tidy merges duplicate memories',
  load: () => import('src/commands/memory/memory.js'),
}

export default memory

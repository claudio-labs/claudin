import type { Command } from 'src/commands/commands.js'

const memory: Command = {
  type: 'local-jsx',
  name: 'memory',
  description:
    'Browse and edit memory files; /memory private|team opens a directory, /memory tidy merges duplicates, /memory sort files team memories into decisions/bugs/docs',
  argumentHint: '[tidy|sort|private|team]',
  load: () => import('src/commands/memory/memory.js'),
}

export default memory

import type { Command } from 'src/commands/commands.js'

const exit = {
  type: 'local-jsx',
  name: 'exit',
  aliases: ['quit'],
  description: 'Exit the REPL',
  immediate: true,
  load: () => import('src/commands/exit/exit.js'),
} satisfies Command

export default exit

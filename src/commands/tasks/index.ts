import type { Command } from 'src/commands/commands.js'

const tasks = {
  type: 'local-jsx',
  name: 'tasks',
  aliases: ['bashes'],
  description: 'List and manage background tasks',
  load: () => import('src/commands/tasks/tasks.js'),
} satisfies Command

export default tasks

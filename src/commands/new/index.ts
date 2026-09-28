import type { Command } from 'src/commands/commands.js'

const newSession = {
  type: 'local-jsx',
  name: 'new',
  description: 'Start a new session, keeping this one open or ending it',
  load: () => import('src/commands/new/new.js'),
} satisfies Command

export default newSession

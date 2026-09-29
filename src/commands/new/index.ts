import type { Command } from 'src/commands/commands.js'

const newSession = {
  type: 'local-jsx',
  name: 'new',
  description: 'Start a new session, keeping this one open or ending it',
  // It asks before it starts. Queued behind a running turn it would be asked
  // only once that turn was over, when nothing is left to keep running.
  immediate: true,
  load: () => import('src/commands/new/new.js'),
} satisfies Command

export default newSession

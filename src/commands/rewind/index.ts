import type { Command } from 'src/commands/commands.js'

const rewind = {
  description: `Restore the code and/or conversation to a previous point`,
  name: 'rewind',
  aliases: ['checkpoint'],
  argumentHint: '',
  type: 'local',
  supportsNonInteractive: false,
  load: () => import('src/commands/rewind/rewind.js'),
} satisfies Command

export default rewind

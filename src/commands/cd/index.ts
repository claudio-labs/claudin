import type { Command } from 'src/commands/commands.js'

const cd = {
  type: 'local',
  name: 'cd',
  description: 'Move this session to a new working directory',
  argumentHint: '<path>',
  supportsNonInteractive: true,
  load: () => import('src/commands/cd/cd.js'),
} satisfies Command

export default cd

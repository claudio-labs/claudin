import type { Command } from 'src/commands/commands.js'

const recap = {
  type: 'local',
  name: 'recap',
  description: 'Generate a one-line session recap now',
  supportsNonInteractive: true,
  load: () => import('src/commands/recap/recap.js'),
} satisfies Command

export default recap

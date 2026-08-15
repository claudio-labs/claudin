import type { Command } from 'src/commands.js'

const command = {
  name: 'vim',
  description: 'Toggle between Vim and Normal editing modes',
  supportsNonInteractive: false,
  type: 'local',
  load: () => import('src/commands/vim/vim.js'),
} satisfies Command

export default command

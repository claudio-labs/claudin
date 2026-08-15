import type { Command } from 'src/commands.js'

const stickers = {
  type: 'local',
  name: 'stickers',
  description: 'Order Claude Code stickers',
  supportsNonInteractive: false,
  load: () => import('src/commands/stickers/stickers.js'),
} satisfies Command

export default stickers

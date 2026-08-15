import type { Command } from 'src/commands.js'

const rename = {
  type: 'local-jsx',
  name: 'rename',
  description: 'Rename the current conversation',
  immediate: true,
  argumentHint: '[name]',
  load: () => import('src/commands/rename/rename.js'),
} satisfies Command

export default rename

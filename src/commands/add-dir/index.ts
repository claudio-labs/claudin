import type { Command } from 'src/commands.js'

const addDir = {
  type: 'local-jsx',
  name: 'add-dir',
  description: 'Add a new working directory',
  argumentHint: '<path>',
  load: () => import('src/commands/add-dir/add-dir.js'),
} satisfies Command

export default addDir

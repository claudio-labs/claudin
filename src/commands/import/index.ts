import type { Command } from 'src/commands/commands.js'

const importCommand = {
  type: 'local-jsx',
  name: 'import',
  description: 'Import config from another AI coding agent',
  argumentHint: '[agent]',
  load: () => import('src/commands/import/import.js'),
} satisfies Command

export default importCommand

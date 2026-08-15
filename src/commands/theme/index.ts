import type { Command } from 'src/commands.js'

const theme = {
  type: 'local-jsx',
  name: 'theme',
  description: 'Change the theme',
  load: () => import('src/commands/theme/theme.js'),
} satisfies Command

export default theme

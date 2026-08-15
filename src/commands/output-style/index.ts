import type { Command } from 'src/commands.js'

const outputStyle = {
  type: 'local-jsx',
  name: 'output-style',
  description: 'Deprecated: use /config to change output style',
  isHidden: true,
  load: () => import('src/commands/output-style/output-style.js'),
} satisfies Command

export default outputStyle

import type { Command } from '../../commands.js'

const lsp = {
  type: 'local-jsx',
  name: 'lsp',
  description: 'Manage LSP language servers',
  load: () => import('./lsp.js'),
} satisfies Command

export default lsp

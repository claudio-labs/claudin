import type { Command } from 'src/commands.js'

const btw = {
  type: 'local-jsx',
  name: 'btw',
  description:
    'Ask a quick side question without interrupting the main conversation',
  immediate: true,
  argumentHint: '<question>',
  load: () => import('src/commands/btw/btw.js'),
} satisfies Command

export default btw

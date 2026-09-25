import type { Command } from 'src/commands/commands.js'
import { getMainLoopModel, renderModelName } from 'src/providers/model/model.js'

export default {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return `Set the AI model for Claudin (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint: '[model]',
  load: () => import('src/commands/model/model.js'),
} satisfies Command

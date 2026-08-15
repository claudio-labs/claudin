import type { Command } from 'src/commands/commands.js'
import { shouldInferenceConfigCommandBeImmediate } from 'src/commands/immediateCommand.js'
import { getMainLoopModel, renderModelName } from 'src/utils/model/model.js'

export default {
  type: 'local-jsx',
  name: 'model',
  get description() {
    return `Set the AI model for Claude Code (currently ${renderModelName(getMainLoopModel())})`
  },
  argumentHint: '[model]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('src/commands/model/model.js'),
} satisfies Command

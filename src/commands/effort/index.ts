import type { Command } from 'src/commands/commands.js'
import { shouldInferenceConfigCommandBeImmediate } from 'src/commands/immediateCommand.js'

export default {
  type: 'local-jsx',
  name: 'effort',
  description: 'Set effort level for model usage',
  argumentHint: '[low|medium|high|max|auto]',
  get immediate() {
    return shouldInferenceConfigCommandBeImmediate()
  },
  load: () => import('src/commands/effort/effort.js'),
} satisfies Command

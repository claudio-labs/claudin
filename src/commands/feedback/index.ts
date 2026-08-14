import type { Command } from 'src/commands.js'
import { tryGetActiveProvider } from 'src/services/api/activeProvider.js'
import { isPolicyAllowed } from 'src/services/policyLimits/index.js'
import { isEnvTruthy } from 'src/utils/envUtils.js'
import { isEssentialTrafficOnly } from 'src/utils/privacyLevel.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about Claude Code`,
  argumentHint: '[report]',
  isEnabled: () => {
    const transport = tryGetActiveProvider()?.transport
    return !(
      transport === 'bedrock' ||
      transport === 'vertex' ||
      transport === 'foundry' ||
      isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) ||
      isEnvTruthy(process.env.DISABLE_BUG_COMMAND) ||
      isEssentialTrafficOnly() ||
      !isPolicyAllowed('allow_product_feedback')
    )
  },
  load: () => import('./feedback.js'),
} satisfies Command

export default feedback

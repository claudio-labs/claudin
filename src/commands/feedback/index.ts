import type { Command } from 'src/commands/commands.js'
import { tryGetActiveProvider } from 'src/providers/presets/activeProvider.js'
import { isPolicyAllowed } from 'src/platform/policyLimits/index.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getExplicitEssentialTrafficOnlyReason } from 'src/platform/config/privacyLevel.js'

const feedback = {
  aliases: ['bug'],
  type: 'local-jsx',
  name: 'feedback',
  description: `Submit feedback about Claudin`,
  argumentHint: '[report]',
  // The essential-traffic check is deliberately the EXPLICIT one. Claudin
  // defaults to `essential-traffic`, so gating on `isEssentialTrafficOnly()`
  // hid this command from every default-config user — and it was gated that way
  // because the old implementation POSTed the report to api.anthropic.com. It
  // does not any more: the flow ends at a GitHub issue draft the user opens
  // themselves, so the default level has nothing left to suppress. An
  // explicitly set *_DISABLE_NONESSENTIAL_TRAFFIC still hides it.
  isEnabled: () => {
    const transport = tryGetActiveProvider()?.transport
    return !(
      transport === 'bedrock' ||
      transport === 'vertex' ||
      transport === 'foundry' ||
      isEnvTruthy(process.env.DISABLE_FEEDBACK_COMMAND) ||
      isEnvTruthy(process.env.DISABLE_BUG_COMMAND) ||
      getExplicitEssentialTrafficOnlyReason() !== null ||
      !isPolicyAllowed('allow_product_feedback')
    )
  },
  load: () => import('src/commands/feedback/feedback.js'),
} satisfies Command

export default feedback

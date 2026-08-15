import type { Command } from 'src/commands.js'
import { getSubscriptionType } from 'src/services/auth/auth.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'

const upgrade = {
  type: 'local-jsx',
  name: 'upgrade',
  description: 'Upgrade to Max for higher rate limits and more Opus',
  availability: ['claude-ai'],
  isEnabled: () =>
    !isEnvTruthy(process.env.DISABLE_UPGRADE_COMMAND) &&
    getSubscriptionType() !== 'enterprise',
  load: () => import('src/commands/upgrade/upgrade.js'),
} satisfies Command

export default upgrade

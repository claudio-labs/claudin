import type { Command } from 'src/commands.js'
import {
  checkCachedPassesEligibility,
  getCachedReferrerReward,
} from 'src/services/api/referral.js'

export default {
  type: 'local-jsx',
  name: 'passes',
  get description() {
    const reward = getCachedReferrerReward()
    if (reward) {
      return 'Share a free week of Claude Code with friends and earn extra usage'
    }
    return 'Share a free week of Claude Code with friends'
  },
  get isHidden() {
    const { eligible, hasCache } = checkCachedPassesEligibility()
    return !eligible || !hasCache
  },
  load: () => import('src/commands/passes/passes.js'),
} satisfies Command

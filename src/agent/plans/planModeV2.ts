import { getRateLimitTier, getSubscriptionType } from 'src/providers/auth/auth.js'
import { isEnvDefinedFalsy } from 'src/shared/envUtils.js'

export function getPlanModeV2AgentCount(): number {
  // Environment variable override takes precedence
  if (process.env.CLAUDIN_PLAN_V2_AGENT_COUNT) {
    const count = parseInt(process.env.CLAUDIN_PLAN_V2_AGENT_COUNT, 10)
    if (!isNaN(count) && count > 0 && count <= 10) {
      return count
    }
  }

  const subscriptionType = getSubscriptionType()
  const rateLimitTier = getRateLimitTier()

  if (
    subscriptionType === 'max' &&
    rateLimitTier === 'default_claude_max_20x'
  ) {
    return 3
  }

  if (subscriptionType === 'enterprise' || subscriptionType === 'team') {
    return 3
  }

  return 1
}

/**
 * Check if plan mode interview phase is enabled.
 *
 * On unless CLAUDIN_PLAN_MODE_INTERVIEW_PHASE is set falsy, which restores the
 * 5-phase workflow.
 */
export function isPlanModeInterviewPhaseEnabled(): boolean {
  return !isEnvDefinedFalsy(process.env.CLAUDIN_PLAN_MODE_INTERVIEW_PHASE)
}

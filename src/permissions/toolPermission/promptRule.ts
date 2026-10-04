/**
 * The decision reason a Bash prompt-rule match carries, and the rule read
 * back out of it. The reason text reaches the model as part of the result.
 */
import type { PermissionDecisionReason } from 'src/shared/types/permissions.js'
import type { ClassifierResult } from 'src/permissions/bashClassifier.js'

export type PromptRuleReason = Extract<PermissionDecisionReason, { type: 'classifier' }>

const PROMPT_RULE_REASON = /^Allowed by prompt rule: "([\s\S]*)"$/

export function promptRuleReason(rule: string): PromptRuleReason {
  return { type: 'classifier', classifier: 'bash_allow', reason: `Allowed by prompt rule: "${rule}"` }
}

/** The rule a prompt-rule reason names, or undefined for any other reason. */
export function ruleOf(reason: PermissionDecisionReason): string | undefined {
  if (reason.type !== 'classifier' || reason.classifier !== 'bash_allow') return undefined
  return PROMPT_RULE_REASON.exec(reason.reason)?.[1]
}

/** Only a high-confidence match may allow a call. */
export function isConfidentMatch(result: ClassifierResult): result is ClassifierResult & { matchedDescription: string } {
  return result.matches && result.confidence === 'high' && result.matchedDescription !== undefined
}

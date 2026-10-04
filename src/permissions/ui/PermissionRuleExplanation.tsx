import { feature } from 'bun:bundle'
import React from 'react'
import type { PermissionDecision, PermissionDecisionReason } from 'src/permissions/PermissionResult.js'
import { permissionRuleValueToString } from 'src/permissions/permissionRuleParser.js'
import { BaseText, Box, Text } from 'src/terminal/ink.js'
import { useAppState } from 'src/terminal/state/AppState.js'
import type { PermissionMode } from 'src/shared/types/permissions.js'
import type { Theme } from 'src/terminal/theme/theme.js'

export type PermissionRuleExplanationProps = {
  permissionResult: PermissionDecision
  toolType: 'tool' | 'command' | 'edit' | 'read'
}

type ToolKind = PermissionRuleExplanationProps['toolType']

/** What the explanation shows: one sentence (it may hold line breaks), an optional hint, an optional colour. */
type Explanation = {
  sentence: React.ReactNode
  hint?: string
  color?: keyof Theme
}

type ExplainContext = { kind: ToolKind; mode: PermissionMode }

type ReasonOf<K extends PermissionDecisionReason['type']> = Extract<PermissionDecisionReason, { type: K }>

type Explainers = {
  [K in PermissionDecisionReason['type']]?: (reason: ReasonOf<K>, context: ExplainContext) => Explanation | null
}

const RULES_HINT = '/permissions to update rules'
const HOOKS_HINT = '/hooks to update'

// A flag check must be the whole condition of a ternary for the build to fold it.
const CLASSIFIER_EXPLAINED: boolean = feature('TRANSCRIPT_CLASSIFIER') ? true : feature('BASH_CLASSIFIER') ? true : false

const EXPLAINERS: Explainers = {
  rule: ({ rule }, { kind }) => ({
    sentence: (
      <>
        Permission rule <Text bold>{permissionRuleValueToString(rule.ruleValue)}</Text> requires confirmation for this{' '}
        {kind}.
      </>
    ),
    // A managed rule cannot be changed from /permissions, so pointing there would mislead.
    hint: rule.source === 'policySettings' ? undefined : RULES_HINT,
  }),
  hook: ({ hookName, reason, hookSource }, { kind, mode }) => ({
    sentence: (
      <>
        Hook <Text bold>{hookName}</Text> requires confirmation for this {kind}
        {reason ? `:\n${reason}` : '.'}
        {hookSource && (
          <>
            {' '}
            <BaseText dim>[{hookSource}]</BaseText>
          </>
        )}
      </>
    ),
    hint: HOOKS_HINT,
    color: mode === 'auto' ? 'warning' : undefined,
  }),
  classifier: ({ classifier, reason }, { kind }) => {
    if (!CLASSIFIER_EXPLAINED) return null
    if (classifier === 'auto-mode') {
      return { sentence: `Auto mode classifier requires confirmation for this ${kind}.\n${reason}`, color: 'error' }
    }
    return {
      sentence: (
        <>
          Classifier <Text bold>{classifier}</Text> requires confirmation for this {kind}.{'\n'}
          {reason}
        </>
      ),
    }
  },
  safetyCheck: ({ reason }) => ({ sentence: reason }),
  other: ({ reason }) => ({ sentence: reason }),
  workingDir: ({ reason }) => ({ sentence: reason, hint: RULES_HINT }),
}

function explain(reason: PermissionDecisionReason | undefined, context: ExplainContext): Explanation | null {
  if (!reason) return null
  const explainer = EXPLAINERS[reason.type] as ((reason: PermissionDecisionReason, context: ExplainContext) => Explanation | null) | undefined
  return explainer ? explainer(reason, context) : null
}

function selectMode(state: { toolPermissionContext: { mode: PermissionMode } }): PermissionMode {
  return state.toolPermissionContext.mode
}

/** Says which rule, hook or check asked for this prompt, then leaves a blank line. Reasons with nothing to say draw nothing. */
export function PermissionRuleExplanation({ permissionResult, toolType }: PermissionRuleExplanationProps): React.ReactNode {
  const mode = useAppState(selectMode)
  const explanation = explain(permissionResult?.decisionReason, { kind: toolType, mode })
  if (!explanation) return null
  return (
    <Box flexDirection="column" marginBottom={1}>
      <Text color={explanation.color}>{explanation.sentence}</Text>
      {explanation.hint && <Text dimColor>{explanation.hint}</Text>}
    </Box>
  )
}

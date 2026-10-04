import { describe, expect, test } from 'bun:test'
import type { PermissionRuleValue } from 'src/permissions/PermissionRule.js'
import type { PermissionUpdate } from 'src/permissions/PermissionUpdateSchema.js'
import type { UnreachableRule } from 'src/permissions/shadowedRuleDetection.js'
import { relevantUnreachableRules } from 'src/permissions/ui/decisionDebug/unreachableRules.js'

function unreachable(ruleValue: PermissionRuleValue): UnreachableRule {
  const shadow = { source: 'localSettings' as const, ruleBehavior: 'deny' as const, ruleValue: { toolName: ruleValue.toolName } }
  return {
    rule: { source: 'userSettings', ruleBehavior: 'allow', ruleValue },
    reason: 'r',
    shadowedBy: shadow,
    shadowType: 'deny',
    fix: 'f',
  }
}

const LS = unreachable({ toolName: 'Bash', ruleContent: 'ls:*' })
const ETC = unreachable({ toolName: 'Read', ruleContent: '/etc/**' })
const CAT = unreachable({ toolName: 'Bash', ruleContent: 'cat:*' })
const ALL = [LS, ETC, CAT]

const suggest = (...rules: PermissionRuleValue[]): PermissionUpdate[] => [
  { type: 'addRules', destination: 'localSettings', behavior: 'allow', rules },
]

describe('relevantUnreachableRules', () => {
  const cases: Array<[string, PermissionUpdate[] | undefined, string | undefined, UnreachableRule[]]> = [
    ['nothing to narrow by: all', undefined, undefined, ALL],
    ['a tool name', undefined, 'Bash', [LS, CAT]],
    ['an empty suggestion list falls back to the tool', [], 'Read', [ETC]],
    ['suggested rules beat the tool name', suggest({ toolName: 'Bash', ruleContent: 'cat:*' }), 'Read', [CAT]],
    ['content must match too', suggest({ toolName: 'Bash', ruleContent: 'ls' }), undefined, []],
    ['a tool-wide suggestion matches no specific rule', suggest({ toolName: 'Bash' }), 'Bash', []],
    [
      'rule-less updates fall back to the tool',
      [{ type: 'addDirectories', destination: 'session', directories: ['/x'] }],
      'Read',
      [ETC],
    ],
  ]
  for (const [label, suggestions, toolName, expected] of cases) {
    test(label, () => expect(relevantUnreachableRules(ALL, suggestions, toolName)).toEqual(expected))
  }

  test('the input list is left as it was', () => {
    const rules = [...ALL]
    relevantUnreachableRules(rules, undefined, 'Bash')
    expect(rules).toEqual(ALL)
  })
})

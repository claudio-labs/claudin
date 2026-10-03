import { describe, expect, test } from 'bun:test'
import { canonicalRuleString } from 'src/permissions/permissionRuleParser.js'
import {
  canonicalRuleList,
  withRulesAppended,
  withRulesRemoved,
} from 'src/permissions/ruleSettings/ruleLists.js'

const r = String.raw

describe('canonicalRuleString', () => {
  const forms: Array<[raw: string, canonical: string]> = [
    ['Bash(*)', 'Bash'],
    ['Task(x)', 'Agent(x)'],
    ['Bash(print(1))', r`Bash(print\(1\))`],
    ['Bash(foo) bar', 'Bash(foo) bar'],
  ]
  test.each(forms)('%p → %p', (raw, canonical) => {
    expect(canonicalRuleString(raw)).toBe(canonical)
  })
})

describe('withRulesAppended', () => {
  const cases: Array<[why: string, list: unknown[], additions: Array<{ toolName: string; ruleContent?: string }>, expected: unknown[] | null]> = [
    ['appends what is new, canonical', ['Read'], [{ toolName: 'KillShell' }], ['Read', 'TaskStop']],
    ['skips what is there under any spelling', ['Bash(*)', 'Task(a)'], [{ toolName: 'Bash' }, { toolName: 'Agent', ruleContent: 'a' }], null],
    ['de-duplicates the batch', [], [{ toolName: 'Glob' }, { toolName: 'Glob' }], ['Glob']],
    ['keeps non-string entries in place', [3, 'Read'], [{ toolName: 'Edit' }], [3, 'Read', 'Edit']],
  ]
  test.each(cases)('%s', (_why, list, additions, expected) => {
    expect(withRulesAppended(list, additions)).toEqual(expected)
  })
})

describe('withRulesRemoved', () => {
  const cases: Array<[why: string, list: unknown[], rules: Array<{ toolName: string; ruleContent?: string }>, expected: unknown[] | null]> = [
    ['removes every spelling', ['Bash', 'Bash(*)', 'Read'], [{ toolName: 'Bash' }], ['Read']],
    ['a scoped rule leaves the tool-wide one', ['Bash', 'Bash(ls)'], [{ toolName: 'Bash', ruleContent: 'ls' }], ['Bash']],
    ['null when nothing matches', ['Read'], [{ toolName: 'Bash' }], null],
    ['non-string entries survive', [null, 'Bash'], [{ toolName: 'Bash' }], [null]],
  ]
  test.each(cases)('%s', (_why, list, rules, expected) => {
    expect(withRulesRemoved(list, rules)).toEqual(expected)
  })
})

test('canonicalRuleList keeps the first of each rule, in order', () => {
  expect(canonicalRuleList([{ toolName: 'B' }, { toolName: 'A' }, { toolName: 'B', ruleContent: '*' }])).toEqual(['B', 'A'])
})

import { describe, expect, test } from 'bun:test'
import type { RuleMapTaskState } from 'src/agent/tasks/RuleMapTask/RuleMapTask.js'
import { ruleMapRowLabel } from 'src/agent/ui/tasks/ruleMapRowLabel.js'
import { taskFixture } from 'src/agent/ui/tasks/__testutils__/taskFixtures.js'

function notice(over: Record<string, unknown>): RuleMapTaskState {
  return taskFixture('rule_map', over) as unknown as RuleMapTaskState
}

describe('ruleMapRowLabel', () => {
  test('names the file, then the clause every surface shares', () => {
    expect(
      ruleMapRowLabel(
        notice({
          status: 'completed',
          result: {
            status: 'healed',
            path: '.claudin/rules/search-strategy.md',
            changes: [{ path: 'src/tools/', from: 682, to: 751 }],
          },
        }),
      ),
    ).toBe('search-strategy.md · updated · src/tools/ 682→751')
  })

  test('says it is mapping only while the sync runs', () => {
    expect(ruleMapRowLabel(notice({}))).toBe('Navigation map · mapping…')
    // A view pinned it while it ran, and the sync then wrote nothing.
    expect(ruleMapRowLabel(notice({ status: 'completed' }))).toBe(
      'Navigation map · nothing to write',
    )
  })
})

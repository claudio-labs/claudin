// The row label for a navigation-map notice (RuleMapTask): the file, then the
// clause describeRuleMapWrite gives every surface. Split out like
// containerRowLabel/mcpRowLabel.

import { basename } from 'path'
import type { RuleMapTaskState } from 'src/agent/tasks/RuleMapTask/RuleMapTask.js'
import { describeRuleMapWrite } from 'src/memory/instructions/rulesMapSync.js'
import type { DeepImmutable } from 'src/shared/types/utils.js'

/** What the notice says beside its name, before and after the sync ends. */
export function ruleMapRowState(task: DeepImmutable<RuleMapTaskState>): string {
  if (task.result !== null) return describeRuleMapWrite(task.result)
  // A row with no result outlives its sync only when a view pinned it.
  return task.status === 'running' ? 'mapping…' : 'nothing to write'
}

/** `search-strategy.md · updated · src/tools/ 682→751`. */
export function ruleMapRowLabel(task: DeepImmutable<RuleMapTaskState>): string {
  const name = task.result === null ? task.description : basename(task.result.path)
  return `${name} · ${ruleMapRowState(task)}`
}

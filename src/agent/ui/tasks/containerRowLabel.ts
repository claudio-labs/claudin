// The one-line label for a container row in the footer tree.
//
// Returns ONE string on purpose. The tree paints each row as a single `<Text>`,
// and splitting a status line into sibling `<Text>`s turns it into independently
// wrapping columns rather than one flowing line (see .claudin/rules/ink-tui.md
// §10). Anything that needs its own colour has to be a nested `<Text>` inside
// that one, not a sibling.

import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import type { DeepImmutable } from 'src/shared/types/utils.js'
import {
  formatContainerState,
  portSummary,
  shortContainerName,
} from 'src/containers/format.js'

const SEP = ' · '

// The formatting itself lives in src/containers/format.ts so the Container
// tool's result renderer spells a container the same way this row does.
export { portSummary, shortContainerName }

export function containerRowLabel(task: DeepImmutable<ContainerTaskState>): string {
  const parts = [
    shortContainerName(task.container),
    formatContainerState(task.container, task.restartCount),
  ]
  // Ports only matter while something is listening on them.
  if (task.container.state === 'running') {
    const ports = portSummary(task.container)
    if (ports) parts.push(ports)
  }
  return parts.join(SEP)
}

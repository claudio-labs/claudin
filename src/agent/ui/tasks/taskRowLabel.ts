// The one-line label for a background task, wherever it is listed.
//
// There used to be two of these — `labelFor` in BackgroundTaskGroupTree (the
// footer tree) and the label arm of `toListItem` in BackgroundTasksDialog —
// each carrying its own switch over `task.type`, with a comment on the first
// saying it "mirrors" the second. PR #145 added the `container` type, updated
// the tree, and missed the dialog; the dialog's `default` arm throws, so a
// running container turned every route into the background-tasks dialog into a
// fatal error screen. One switch, so the next task type cannot be half-wired.
//
// Takes DeepImmutable because BackgroundTask.tsx renders from the immutable
// AppState view. A mutable task is assignable to it, so the footer tree and
// the dialog pass theirs unchanged.

import type { BackgroundTaskState } from 'src/agent/tasks/types.js'
import type { DeepImmutable } from 'src/shared/types/utils.js'
import { containerRowLabel } from 'src/agent/ui/tasks/containerRowLabel.js'

export function taskRowLabel(task: DeepImmutable<BackgroundTaskState>): string {
  switch (task.type) {
    case 'local_bash':
      return task.kind === 'monitor' ? task.description : task.command
    case 'remote_agent':
      return task.title
    case 'local_agent':
      return task.description
    case 'local_workflow':
      return task.summary ?? task.description
    case 'monitor_mcp':
      return task.description
    case 'dream':
      return task.description
    case 'in_process_teammate':
      return `@${task.identity.agentName}`
    case 'container':
      return containerRowLabel(task)
    default:
      // LocalWorkflowTaskState resolves to `any` through the stub module this
      // fork ships, which defeats switch exhaustiveness even though every real
      // variant is handled above.
      return ''
  }
}

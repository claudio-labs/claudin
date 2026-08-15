// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import { feature } from 'bun:bundle';
import { stopUltraplan } from 'src/commands/ultraplan.js';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import { DreamTask } from 'src/tasks/DreamTask/DreamTask.js';
import { InProcessTeammateTask } from 'src/tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { LocalAgentTask } from 'src/tasks/LocalAgentTask/LocalAgentTask.js';
import { LocalShellTask } from 'src/tasks/LocalShellTask/LocalShellTask.js';
import { MonitorMcpTask } from 'src/tasks/MonitorMcpTask/MonitorMcpTask.js';
import { RemoteAgentTask } from 'src/tasks/RemoteAgentTask/RemoteAgentTask.js';
import type { BackgroundTaskState } from 'src/tasks/types.js';
import { logForDebugging } from 'src/shared/debug.js';

type SetAppState = (updater: (prev: AppState) => AppState) => void;

// WORKFLOW_SCRIPTS is internal-only (build_flags.yaml) and its module isn't
// mirrored in the open build. Gate the kill helper behind feature() + require so
// external builds dead-code-eliminate it (mirrors BackgroundTasksDialog.tsx).
/* eslint-disable @typescript-eslint/no-require-imports */
const workflowTaskModule = feature('WORKFLOW_SCRIPTS')
  ? (require('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js') as typeof import('src/tasks/LocalWorkflowTask/LocalWorkflowTask.js'))
  : null;
const killWorkflowTask = workflowTaskModule?.killWorkflowTask ?? null;
/* eslint-enable @typescript-eslint/no-require-imports */

/**
 * Stop a running background task, dispatching on its type. Shared by
 * BackgroundTasksDialog (x key) and the inline footer tree so the kill switch
 * lives in exactly one place. No-op if the task is not running.
 */
export function killBackgroundTask(
  task: BackgroundTaskState,
  setAppState: SetAppState,
): void {
  if (task.status !== 'running') return;
  switch (task.type) {
    case 'local_bash':
      void LocalShellTask.kill(task.id, setAppState);
      return;
    case 'local_agent':
      void LocalAgentTask.kill(task.id, setAppState);
      return;
    case 'in_process_teammate':
      void InProcessTeammateTask.kill(task.id, setAppState);
      return;
    case 'local_workflow':
      killWorkflowTask?.(task.id, setAppState);
      return;
    case 'monitor_mcp':
      void MonitorMcpTask.kill(task.id, setAppState);
      return;
    case 'dream':
      void DreamTask.kill(task.id, setAppState);
      return;
    case 'remote_agent':
      if (task.isUltraplan) {
        void stopUltraplan(task.id, task.sessionId, setAppState);
      } else {
        void RemoteAgentTask.kill(task.id, setAppState);
      }
      return;
    default: {
      // Surface unhandled task types instead of silently no-op'ing the x key
      // in the footer tree. (Compile-time exhaustiveness `never` assignment
      // is bypassed because LocalWorkflowTaskState resolves to `any` in the
      // open build — see the require() above.)
      logForDebugging(`killBackgroundTask: unhandled task type ${(task as BackgroundTaskState).type}`);
      return;
    }
  }
}

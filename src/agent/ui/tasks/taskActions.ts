// biome-ignore-all assist/source/organizeImports: internal-only import markers must not be reordered
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import { DreamTask } from 'src/agent/tasks/DreamTask/DreamTask.js';
import { InProcessTeammateTask } from 'src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js';
import { LocalAgentTask } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js';
import { LocalShellTask } from 'src/agent/tasks/LocalShellTask/LocalShellTask.js';
import { MonitorMcpTask } from 'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js';
import { RemoteAgentTask } from 'src/agent/tasks/RemoteAgentTask/RemoteAgentTask.js';
import type { BackgroundTaskState } from 'src/agent/tasks/types.js';
import { shortContainerName } from 'src/agent/ui/tasks/containerRowLabel.js';
import { footerRowAction } from 'src/agent/ui/tasks/footerRowAction.js';
import type { DeepImmutable } from 'src/shared/types/utils.js';
import { logForDebugging } from 'src/shared/debug.js';

type SetAppState = (updater: (prev: AppState) => AppState) => void;

/**
 * Stop a running background task, dispatching on its type. Shared by
 * BackgroundTasksDialog (x key) and the inline footer tree so the kill switch
 * lives in exactly one place. No-op if the task is not running.
 */
export function killBackgroundTask(
  task: DeepImmutable<BackgroundTaskState>,
  setAppState: SetAppState,
): void {
  // ONE guard for the key and for the byline that advertises it:
  // PromptInputFooterLeftSide asks `footerRowAction` the same question to decide
  // whether to name `x` at all, so the two cannot drift into offering a key that
  // no-ops. A plain `status === 'running'` is not enough — container and MCP
  // rows both keep that status with nothing left to act on.
  if (footerRowAction(task) === null) return;
  switch (task.type) {
    case 'container':
      // Deliberately does NOT stop anything. Every other arm here kills a
      // process this session spawned; a container can be the user's database,
      // and may predate the session entirely. Park the request and let
      // ContainerStopDialog confirm — that keeps this the single dispatch
      // point, so the `x` handler in PromptInput needs no container branch.
      setAppState(prev => ({
        ...prev,
        pendingContainerStop: {
          taskId: task.id,
          name: shortContainerName(task.container),
          startedByUs: task.startedByUs,
        },
      }));
      return;
    case 'mcp_server':
      // Same reasoning as `container` above, and the same shape: an MCP server
      // is the user's configuration rather than this session's subprocess, and
      // dropping one takes its tools away from the model mid-conversation.
      // McpDisconnectDialog is what actually disconnects.
      setAppState(prev => ({
        ...prev,
        pendingMcpDisconnect: {
          taskId: task.id,
          serverName: task.serverName,
          toolCount: task.toolCount,
        },
      }));
      return;
    case 'local_bash':
      void LocalShellTask.kill(task.id, setAppState);
      return;
    case 'local_agent':
      void LocalAgentTask.kill(task.id, setAppState);
      return;
    case 'in_process_teammate':
      void InProcessTeammateTask.kill(task.id, setAppState);
      return;
    case 'monitor_mcp':
      void MonitorMcpTask.kill(task.id, setAppState);
      return;
    case 'dream':
      void DreamTask.kill(task.id, setAppState);
      return;
    case 'remote_agent':
      void RemoteAgentTask.kill(task.id, setAppState);
      return;
    default: {
      // Surface unhandled task types instead of silently no-op'ing the x key
      // in the footer tree. (Compile-time exhaustiveness `never` assignment
      // is bypassed because LocalWorkflowTaskState resolves to `any` in this
      // fork — see src/agent/tasks/LocalWorkflowTask/LocalWorkflowTask.d.ts.)
      logForDebugging(`killBackgroundTask: unhandled task type ${String((task as { type?: unknown }).type)}`);
      return;
    }
  }
}

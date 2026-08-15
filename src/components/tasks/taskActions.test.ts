import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppState } from 'src/state/AppStateStore.js';
import type { BackgroundTaskState } from 'src/tasks/types.js';

// Capture the real LocalAgentTask module *before* the mocks below land. The
// mock factory replaces `isPanelAgentTask` with a stub that returns false,
// which leaks across test files via Bun's shape-locked mock.module — sibling
// tests like footerTaskGeometry.test.ts call getVisibleAgentTasks and see
// zero agents. Restore in afterAll keeps the suite clean.
const realLocalAgentTask = { ...(await import('src/tasks/LocalAgentTask/LocalAgentTask.js')) };

// killBackgroundTask dispatches to each task class's static .kill — mock
// every callee at the module boundary so we can assert "right kill fired,
// for the right id" without booting the whole task framework.
const localShellKill = mock(() => Promise.resolve());
const localAgentKill = mock(() => Promise.resolve());
const teammateKill = mock(() => Promise.resolve());
const monitorMcpKill = mock(() => Promise.resolve());
const dreamKill = mock(() => Promise.resolve());
const remoteAgentKill = mock(() => Promise.resolve());
const stopUltraplanMock = mock(() => Promise.resolve());
const debugMock = mock((_msg: string) => {});

mock.module('src/tasks/LocalShellTask/LocalShellTask.js', () => ({
  LocalShellTask: { kill: localShellKill },
}));
mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  LocalAgentTask: { kill: localAgentKill },
  // isPanelAgentTask isn't called from taskActions, but other test files
  // share this module — keep the shape complete.
  isPanelAgentTask: () => false,
}));
mock.module('src/tasks/InProcessTeammateTask/InProcessTeammateTask.js', () => ({
  InProcessTeammateTask: { kill: teammateKill },
}));
mock.module('src/tasks/MonitorMcpTask/MonitorMcpTask.js', () => ({
  MonitorMcpTask: { kill: monitorMcpKill },
}));
mock.module('src/tasks/DreamTask/DreamTask.js', () => ({
  DreamTask: { kill: dreamKill },
}));
mock.module('src/tasks/RemoteAgentTask/RemoteAgentTask.js', () => ({
  RemoteAgentTask: { kill: remoteAgentKill },
}));
mock.module('src/commands/ultraplan.js', () => ({
  stopUltraplan: stopUltraplanMock,
}));
mock.module('src/utils/debug.js', () => ({
  logForDebugging: debugMock,
}));

const { killBackgroundTask } = await import('src/components/tasks/taskActions.js');

afterAll(() => {
  // Re-pin the real LocalAgentTask so the next file's getVisibleAgentTasks
  // (and any other consumer of isPanelAgentTask) sees the genuine guard.
  mock.module('src/tasks/LocalAgentTask/LocalAgentTask.js', () => realLocalAgentTask);
});

const setAppState = mock((_: (prev: AppState) => AppState) => {});

function makeTask<T extends BackgroundTaskState['type']>(
  type: T,
  extra: Record<string, unknown> = {},
): BackgroundTaskState {
  return {
    id: `task-${type}`,
    type,
    status: 'running',
    ...extra,
  } as unknown as BackgroundTaskState;
}

describe('killBackgroundTask', () => {
  beforeEach(() => {
    localShellKill.mockClear();
    localAgentKill.mockClear();
    teammateKill.mockClear();
    monitorMcpKill.mockClear();
    dreamKill.mockClear();
    remoteAgentKill.mockClear();
    stopUltraplanMock.mockClear();
    debugMock.mockClear();
    setAppState.mockClear();
  });

  test('no-op when task is not running', () => {
    const task = makeTask('local_bash', { status: 'completed' });
    killBackgroundTask(task, setAppState);
    expect(localShellKill).not.toHaveBeenCalled();
    expect(debugMock).not.toHaveBeenCalled();
  });

  test('local_bash routes to LocalShellTask.kill', () => {
    const task = makeTask('local_bash');
    killBackgroundTask(task, setAppState);
    expect(localShellKill).toHaveBeenCalledTimes(1);
    expect(localShellKill).toHaveBeenCalledWith(task.id, setAppState);
  });

  test('local_agent routes to LocalAgentTask.kill', () => {
    const task = makeTask('local_agent');
    killBackgroundTask(task, setAppState);
    expect(localAgentKill).toHaveBeenCalledTimes(1);
    expect(localAgentKill).toHaveBeenCalledWith(task.id, setAppState);
  });

  test('in_process_teammate routes to InProcessTeammateTask.kill', () => {
    const task = makeTask('in_process_teammate');
    killBackgroundTask(task, setAppState);
    expect(teammateKill).toHaveBeenCalledTimes(1);
  });

  test('monitor_mcp routes to MonitorMcpTask.kill', () => {
    const task = makeTask('monitor_mcp');
    killBackgroundTask(task, setAppState);
    expect(monitorMcpKill).toHaveBeenCalledTimes(1);
  });

  test('dream routes to DreamTask.kill', () => {
    const task = makeTask('dream');
    killBackgroundTask(task, setAppState);
    expect(dreamKill).toHaveBeenCalledTimes(1);
  });

  test('remote_agent (non-ultraplan) routes to RemoteAgentTask.kill', () => {
    const task = makeTask('remote_agent', { isUltraplan: false });
    killBackgroundTask(task, setAppState);
    expect(remoteAgentKill).toHaveBeenCalledTimes(1);
    expect(stopUltraplanMock).not.toHaveBeenCalled();
  });

  test('remote_agent (ultraplan) routes to stopUltraplan with sessionId', () => {
    const task = makeTask('remote_agent', {
      isUltraplan: true,
      sessionId: 'sess-42',
    });
    killBackgroundTask(task, setAppState);
    expect(stopUltraplanMock).toHaveBeenCalledTimes(1);
    expect(stopUltraplanMock).toHaveBeenCalledWith(
      task.id,
      'sess-42',
      setAppState,
    );
    expect(remoteAgentKill).not.toHaveBeenCalled();
  });

  test('unknown task type logs via logForDebugging instead of silently no-op', () => {
    // Cast through unknown — we are intentionally constructing a type that
    // would only show up if a new BackgroundTaskState variant were added
    // without wiring it here. This is the regression the default branch
    // guards against.
    const task = {
      id: 'task-mystery',
      type: 'future_invented_type',
      status: 'running',
    } as unknown as BackgroundTaskState;
    killBackgroundTask(task, setAppState);
    expect(debugMock).toHaveBeenCalledTimes(1);
    const arg = debugMock.mock.calls[0]?.[0] ?? '';
    expect(arg).toContain('future_invented_type');
  });
});

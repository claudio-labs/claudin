import { afterAll, beforeEach, describe, expect, mock, test } from 'bun:test';
import type { AppState } from 'src/terminal/state/AppStateStore.js';
import type { BackgroundTaskState } from 'src/agent/tasks/types.js';

// Capture every real module *before* the mocks below land, and put them all
// back in afterAll: Bun never reverts a mock.module, so a stub left behind
// reaches every later file in the run. footerTaskGeometry.test.ts saw zero
// agents through the isPanelAgentTask stub, and the headless control loop saw
// LocalShellTask.type as undefined ("Unsupported task type: local_bash").
const realModules = {
  'src/agent/tasks/LocalShellTask/LocalShellTask.js': { ...(await import('src/agent/tasks/LocalShellTask/LocalShellTask.js')) },
  'src/agent/tasks/LocalAgentTask/LocalAgentTask.js': { ...(await import('src/agent/tasks/LocalAgentTask/LocalAgentTask.js')) },
  'src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js': { ...(await import('src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js')) },
  'src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js': { ...(await import('src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js')) },
  'src/agent/tasks/DreamTask/DreamTask.js': { ...(await import('src/agent/tasks/DreamTask/DreamTask.js')) },
  'src/shared/debug.js': { ...(await import('src/shared/debug.js')) },
};

// killBackgroundTask dispatches to each task class's static .kill — mock
// every callee at the module boundary so we can assert "right kill fired,
// for the right id" without booting the whole task framework.
const localShellKill = mock(() => Promise.resolve());
const localAgentKill = mock(() => Promise.resolve());
const teammateKill = mock(() => Promise.resolve());
const monitorMcpKill = mock(() => Promise.resolve());
const dreamKill = mock(() => Promise.resolve());
const debugMock = mock((_msg: string) => {});

mock.module('src/agent/tasks/LocalShellTask/LocalShellTask.js', () => ({
  LocalShellTask: { kill: localShellKill },
}));
mock.module('src/agent/tasks/LocalAgentTask/LocalAgentTask.js', () => ({
  LocalAgentTask: { kill: localAgentKill },
  // isPanelAgentTask isn't called from taskActions, but other test files
  // share this module — keep the shape complete.
  isPanelAgentTask: () => false,
}));
mock.module('src/agent/tasks/InProcessTeammateTask/InProcessTeammateTask.js', () => ({
  InProcessTeammateTask: { kill: teammateKill },
}));
mock.module('src/agent/tasks/MonitorMcpTask/MonitorMcpTask.js', () => ({
  MonitorMcpTask: { kill: monitorMcpKill },
}));
mock.module('src/agent/tasks/DreamTask/DreamTask.js', () => ({
  DreamTask: { kill: dreamKill },
}));
mock.module('src/shared/debug.js', () => ({
  logForDebugging: debugMock,
}));

const { killBackgroundTask } = await import('src/agent/ui/tasks/taskActions.js');

afterAll(() => {
  for (const [path, real] of Object.entries(realModules)) mock.module(path, () => real);
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

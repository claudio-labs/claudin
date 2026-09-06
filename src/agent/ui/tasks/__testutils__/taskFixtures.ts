// One fixture per BackgroundTaskState variant, shared by the label and the
// list-row tests.
//
// Why a hand-maintained table rather than a compile-time exhaustiveness check:
// `LocalWorkflowTaskState` resolves to `any` through the stub module this fork
// ships, which collapses the whole `BackgroundTaskState` union to `any`. So
// `BackgroundTaskState['type']` cannot drive an exhaustive Record, and neither
// can a `never` assignment in a switch default — which is exactly how PR #145
// managed to add `container` while leaving BackgroundTasksDialog's copy of the
// label switch throwing on it.
//
// ADD A FIXTURE HERE when you add a task type. The tests iterate this table, so
// a type missing from it is a type nobody checked.

import type { ContainerInfo } from 'src/containers/types.js'
import type { BackgroundTaskState } from 'src/agent/tasks/types.js'

export function containerInfo(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'c0ffee',
    name: 'shop-api-1',
    image: 'nginx:latest',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    exitCode: null,
    ports: [{ hostPort: 8080, containerPort: 80, protocol: 'tcp' }],
    project: 'shop',
    service: 'api',
    workingDir: '/repo',
    createdAt: 1,
    ...over,
  }
}

// Only the fields the label and row builders read. Cast through unknown so we
// don't have to satisfy every TaskStateBase field.
const RAW: Record<string, unknown> = {
  local_bash: { id: 'b1', type: 'local_bash', status: 'running', kind: 'bash', command: 'npm run dev', startTime: 1 },
  remote_agent: { id: 'r1', type: 'remote_agent', status: 'running', title: 'Remote review', startTime: 1 },
  local_agent: { id: 'a1', type: 'local_agent', status: 'running', description: 'Audit the parser', startTime: 1 },
  in_process_teammate: { id: 't1', type: 'in_process_teammate', status: 'running', identity: { agentName: 'ada', teamName: 'core' }, startTime: 1 },
  local_workflow: { id: 'w1', type: 'local_workflow', status: 'running', description: 'Nightly', summary: 'Nightly sweep', startTime: 1 },
  monitor_mcp: { id: 'm1', type: 'monitor_mcp', status: 'running', description: 'Tailing gateway', startTime: 1 },
  dream: { id: 'd1', type: 'dream', status: 'running', description: 'Reviewing sessions', phase: 'reading', filesTouched: [], sessionsReviewing: 2, startTime: 1 },
  container: { id: 'k1', type: 'container', status: 'running', container: containerInfo(), startedByUs: true, restartCount: 0, lastNotifiedSignature: null, diedAt: null, startTime: 1 },
}

/** Every background task type, keyed by its `type` discriminant. */
export const TASK_FIXTURES = RAW as Record<string, BackgroundTaskState>

/** The discriminants the tests iterate. */
export const TASK_TYPES = Object.keys(RAW)

export function taskFixture(type: string, over: Record<string, unknown> = {}): BackgroundTaskState {
  return { ...(RAW[type] as object), ...over } as unknown as BackgroundTaskState
}

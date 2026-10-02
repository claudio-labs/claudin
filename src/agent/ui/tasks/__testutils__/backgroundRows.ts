/**
 * Background task states for the row and dialog characterization suites,
 * with the fields their renderers and detail views read. Each builder takes
 * overrides, so a test states only what it is about.
 */
import type { BackgroundTaskState } from 'src/agent/tasks/types.js'

type Over = Record<string, unknown>

function base(id: string, type: string, over: Over): Over {
  return {
    id,
    type,
    status: 'running',
    description: `${type} ${id}`,
    startTime: 1_000,
    outputFile: '',
    outputOffset: 0,
    notified: false,
    ...over,
  }
}

const as = (state: Over) => state as unknown as BackgroundTaskState

export const shellRow = (id: string, over: Over = {}) =>
  as(base(id, 'local_bash', { command: `echo ${id}`, kind: 'bash', isBackgrounded: true, shellCommand: null, ...over }))

export const agentRow = (id: string, over: Over = {}) =>
  as(base(id, 'local_agent', {
    agentId: id,
    prompt: `investigate ${id}`,
    agentType: 'reviewer',
    isBackgrounded: true,
    pendingMessages: [],
    ...over,
  }))

export const teammateRow = (id: string, name: string, over: Over = {}) =>
  as(base(id, 'in_process_teammate', {
    identity: { agentId: `${name}@crew`, agentName: name, teamName: 'crew', color: 'blue', planModeRequired: false, parentSessionId: 's' },
    prompt: `help as ${name}`,
    ...over,
  }))

export const workflowRow = (id: string, over: Over = {}) =>
  as(base(id, 'local_workflow', { workflowName: undefined, summary: undefined, agentCount: 2, ...over }))

export const monitorRow = (id: string, over: Over = {}) => as(base(id, 'monitor_mcp', over))

export const dreamRow = (id: string, over: Over = {}) =>
  as(base(id, 'dream', { phase: 'starting', filesTouched: [], sessionsReviewing: 4, turns: [], ...over }))

export const containerRow = (id: string, over: Over = {}, container: Over = {}) =>
  as(base(id, 'container', {
    startedByUs: true,
    restartCount: 0,
    lastNotifiedSignature: null,
    diedAt: null,
    container: {
      id: `${id}-cid`,
      name: `stack-${id}-1`,
      image: 'redis:7',
      state: 'running',
      status: 'Up 5 minutes',
      health: 'none',
      exitCode: null,
      ports: [{ hostPort: 6379, containerPort: 6379, protocol: 'tcp' }],
      project: 'stack',
      service: id,
      workingDir: '/srv',
      createdAt: 1,
      ...container,
    },
    ...over,
  }))

export const mcpRow = (id: string, over: Over = {}) =>
  as(base(id, 'mcp_server', {
    serverName: `srv-${id}`,
    connectionType: 'connected',
    transport: 'stdio',
    scope: 'project',
    toolCount: 3,
    resourceCount: 0,
    serverInfo: { name: 'Server', version: '1.0.0' },
    error: null,
    ...over,
  }))

export function tasksById(...rows: BackgroundTaskState[]): Record<string, BackgroundTaskState> {
  return Object.fromEntries(rows.map(r => [r.id, r]))
}

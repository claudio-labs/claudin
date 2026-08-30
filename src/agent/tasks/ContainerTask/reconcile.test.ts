import { describe, expect, test } from 'bun:test'
import {
  containerSignature,
  containerTaskId,
  DEAD_ROW_GRACE_MS,
  reconcileContainers,
} from 'src/agent/tasks/ContainerTask/reconcile.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import type { TaskState } from 'src/agent/tasks/types.js'
import type { ContainerInfo } from 'src/containers/types.js'

const NOW = 1_700_000_000_000

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'aaaaaaaaaaaaaaaa',
    name: 'legendarr-legendarr-1',
    image: 'legendarr',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    exitCode: null,
    ports: [],
    project: 'legendarr',
    service: 'legendarr',
    workingDir: '/home/dev/projects/legendarr',
    createdAt: null,
    ...over,
  }
}

/** Build the AppState task map by running one reconcile from empty. */
function tasksFor(snapshot: ContainerInfo[], now = NOW): Record<string, TaskState> {
  const patch = reconcileContainers({}, snapshot, now)
  const out: Record<string, TaskState> = {}
  for (const t of patch.register) out[t.id] = t
  return out
}

function rowFor(
  tasks: Record<string, TaskState>,
  containerId: string,
): ContainerTaskState | undefined {
  return tasks[containerTaskId(containerId)] as ContainerTaskState | undefined
}

describe('reconcileContainers', () => {
  test('registers a row for a running container', () => {
    const patch = reconcileContainers({}, [container()], NOW)
    expect(patch.register).toHaveLength(1)
    expect(patch.register[0]?.type).toBe('container')
    expect(patch.register[0]?.status).toBe('running')
    expect(patch.register[0]?.description).toBe('legendarr')
  })

  test('a container that was already dead before we looked gets no row', () => {
    const patch = reconcileContainers(
      {},
      [container({ state: 'exited', status: 'Exited (0) 3 days ago', exitCode: 0 })],
      NOW,
    )
    expect(patch.register).toEqual([])
  })

  test('an unchanged snapshot produces no patch at all', () => {
    const snapshot = [container()]
    const tasks = tasksFor(snapshot)
    const patch = reconcileContainers(tasks, snapshot, NOW + 5_000)
    expect(patch.register).toEqual([])
    expect(patch.update).toEqual([])
    expect(patch.remove).toEqual([])
  })

  test('a health change updates the row', () => {
    const tasks = tasksFor([container({ status: 'Up 2 hours (healthy)', health: 'healthy' })])
    const patch = reconcileContainers(
      tasks,
      [container({ status: 'Up 2 hours (unhealthy)', health: 'unhealthy' })],
      NOW + 1_000,
    )
    expect(patch.update).toHaveLength(1)
    expect(patch.update[0]?.container.health).toBe('unhealthy')
  })

  test('recreate keeps one row and counts it as a restart', () => {
    // Compose recreates the service: same container NAME, new container ID.
    // Keying on the name would update in place and lose the identity change;
    // keying on the ID alone would leave two rows for one service.
    const tasks = tasksFor([container({ id: 'aaaaaaaaaaaaaaaa' })])
    const patch = reconcileContainers(
      tasks,
      [container({ id: 'bbbbbbbbbbbbbbbb' })],
      NOW + 1_000,
    )
    expect(patch.register).toHaveLength(1)
    expect(patch.register[0]?.restartCount).toBe(1)
    expect(patch.remove).toEqual([containerTaskId('aaaaaaaaaaaaaaaa')])
  })

  test('scaled replicas get one row each', () => {
    const patch = reconcileContainers(
      {},
      [
        container({ id: 'a1', name: 'legendarr-worker-1', service: 'worker' }),
        container({ id: 'a2', name: 'legendarr-worker-2', service: 'worker' }),
        container({ id: 'a3', name: 'legendarr-worker-3', service: 'worker' }),
      ],
      NOW,
    )
    expect(patch.register).toHaveLength(3)
    // They share one service, which is what the tree groups on.
    expect(new Set(patch.register.map(t => t.description))).toEqual(
      new Set(['worker']),
    )
  })

  test('a container that dies mid-session keeps its row through the grace period', () => {
    const tasks = tasksFor([container()])
    const dead = container({
      state: 'exited',
      status: 'Exited (137) 1 second ago',
      exitCode: 137,
    })

    const justDied = reconcileContainers(tasks, [dead], NOW + 1_000)
    expect(justDied.remove).toEqual([])
    expect(justDied.update[0]?.diedAt).toBe(NOW + 1_000)
    expect(justDied.update[0]?.container.exitCode).toBe(137)

    const afterGrace = reconcileContainers(
      { [justDied.update[0]!.id]: justDied.update[0]! },
      [dead],
      NOW + 1_000 + DEAD_ROW_GRACE_MS,
    )
    expect(afterGrace.remove).toEqual([containerTaskId('aaaaaaaaaaaaaaaa')])
  })

  test('a container gone from docker entirely is removed at once', () => {
    const tasks = tasksFor([container()])
    const patch = reconcileContainers(tasks, [], NOW + 1_000)
    expect(patch.remove).toEqual([containerTaskId('aaaaaaaaaaaaaaaa')])
  })

  test('counts a transition into restarting, not every poll while restarting', () => {
    const tasks = tasksFor([container()])
    const restarting = container({
      state: 'restarting',
      status: 'Restarting (1) 2 seconds ago',
      exitCode: 1,
    })

    const first = reconcileContainers(tasks, [restarting], NOW + 1_000)
    expect(first.update[0]?.restartCount).toBe(1)

    const stillRestarting = reconcileContainers(
      { [first.update[0]!.id]: first.update[0]! },
      [restarting],
      NOW + 2_000,
    )
    expect(stillRestarting.update).toEqual([])

    const backUp = reconcileContainers(
      { [first.update[0]!.id]: first.update[0]! },
      [container()],
      NOW + 3_000,
    )
    expect(backUp.update[0]?.restartCount).toBe(1)

    const secondCrash = reconcileContainers(
      { [backUp.update[0]!.id]: backUp.update[0]! },
      [restarting],
      NOW + 4_000,
    )
    expect(secondCrash.update[0]?.restartCount).toBe(2)
  })

  test('startedByUs is carried across a recreate', () => {
    const tasks = tasksFor([container()])
    const ours = rowFor(tasks, 'aaaaaaaaaaaaaaaa')!
    const withFlag: Record<string, TaskState> = {
      [ours.id]: { ...ours, startedByUs: true },
    }
    const patch = reconcileContainers(
      withFlag,
      [container({ id: 'bbbbbbbbbbbbbbbb' })],
      NOW + 1_000,
    )
    expect(patch.register[0]?.startedByUs).toBe(true)
  })

  test('a container we started is flagged on first sight', () => {
    const patch = reconcileContainers(
      {},
      [container()],
      NOW,
      new Set(['aaaaaaaaaaaaaaaa']),
    )
    expect(patch.register[0]?.startedByUs).toBe(true)
  })

  test('non-container tasks in AppState are left alone', () => {
    const foreign = {
      id: 'b12345678',
      type: 'local_bash',
      status: 'running',
    } as unknown as TaskState
    const patch = reconcileContainers({ b12345678: foreign }, [], NOW)
    expect(patch.remove).toEqual([])
  })
})

describe('containerSignature', () => {
  test('changes on a state, health or exit-code transition', () => {
    const base = containerSignature(container())
    expect(containerSignature(container({ health: 'unhealthy' }))).not.toBe(base)
    expect(containerSignature(container({ state: 'exited', exitCode: 1 }))).not.toBe(
      base,
    )
  })

  test('carries no relative time, so an idle turn cannot change it', () => {
    // A signature that moved with uptime would mutate bytes behind the
    // prompt-cache marker on every turn.
    const a = containerSignature(container({ status: 'Up 2 hours' }))
    const b = containerSignature(container({ status: 'Up 3 hours' }))
    expect(a).toBe(b)
  })
})

// Pure snapshot → patch reducer for the container rows.
//
// Deliberately free of AppState writes, of React and of any docker call, so the
// corner cases that actually bite — a service recreated under the same name
// with a new ID, a replica set, a container that dies mid-session — are
// testable with no daemon and no TUI.

import type { TaskState } from 'src/agent/tasks/types.js'
import type { ContainerInfo } from 'src/containers/types.js'
import type { ContainerTaskState } from 'src/agent/tasks/ContainerTask/types.js'
import { isContainerTask } from 'src/agent/tasks/ContainerTask/types.js'

/**
 * How long a container that died during this session keeps its row. Long
 * enough that the user sees it go red, short enough that the footer does not
 * accumulate history. A container that was ALREADY exited when the session
 * started never gets a row at all — the panel shows what is happening, not
 * what happened.
 */
export const DEAD_ROW_GRACE_MS = 30_000

/** States that count as "this container is up and worth a row". */
const LIVE_STATES: ReadonlySet<ContainerInfo['state']> = new Set([
  'running',
  'restarting',
  'paused',
  'created',
])

export function isLiveState(state: ContainerInfo['state']): boolean {
  return LIVE_STATES.has(state)
}

/** Deterministic task id, so the same container reconciles to the same row
 * across polls without keeping a side table. */
export function containerTaskId(containerId: string): string {
  return `c${containerId.slice(0, 12)}`
}

/**
 * What the model was last told about a container. Comparing signatures is what
 * makes the per-turn attachment fire on a transition and stay silent otherwise,
 * and it carries no relative time — a value that changed every turn would
 * mutate bytes behind the prompt-cache marker.
 */
export function containerSignature(c: ContainerInfo): string {
  return `${c.state}/${c.health}/${c.exitCode ?? ''}`
}

export type ReconcilePatch = {
  /** Rows that did not exist before. */
  register: ContainerTaskState[]
  /** Rows whose container changed. Only present when something actually moved. */
  update: ContainerTaskState[]
  /** Task ids to drop from AppState. */
  remove: string[]
}

export const EMPTY_PATCH: ReconcilePatch = {
  register: [],
  update: [],
  remove: [],
}

function newTask(
  container: ContainerInfo,
  now: number,
  startedByUs: boolean,
  restartCount: number,
): ContainerTaskState {
  return {
    id: containerTaskId(container.id),
    type: 'container',
    status: 'running',
    description: container.service ?? container.name,
    startTime: now,
    // No output spool: a container's logs are fetched on demand, never
    // streamed to disk per turn. The empty path is what
    // `taskSpoolsOutput` reads to skip the per-turn delta disk read.
    outputFile: '',
    outputOffset: 0,
    notified: false,
    container,
    startedByUs,
    restartCount,
    lastNotifiedSignature: null,
    diedAt: null,
  }
}

/**
 * Fold a fresh snapshot into the existing rows.
 *
 * `snapshot` is expected to be already scoped to the project (see
 * `filterToProject`) and to include non-running containers, so a service that
 * just died can be shown before it is dropped.
 */
export function reconcileContainers(
  tasks: Readonly<Record<string, TaskState>>,
  snapshot: readonly ContainerInfo[],
  now: number,
  startedByUs: ReadonlySet<string> = new Set(),
): ReconcilePatch {
  const existing = new Map<string, ContainerTaskState>()
  for (const t of Object.values(tasks)) {
    if (isContainerTask(t)) existing.set(t.id, t)
  }

  // Name → previous row, for the recreate case: compose reuses the service's
  // container name but the ID changes, and that is a restart, not a new row
  // beside the old one.
  const previousByName = new Map<string, ContainerTaskState>()
  for (const t of existing.values()) previousByName.set(t.container.name, t)

  const register: ContainerTaskState[] = []
  const update: ContainerTaskState[] = []
  const keptIds = new Set<string>()

  for (const container of snapshot) {
    const id = containerTaskId(container.id)
    const prior = existing.get(id)

    if (!prior) {
      // A container that was already dead before we ever saw it is history, not
      // an event. Skip it rather than opening the session with a red row.
      if (!isLiveState(container.state)) continue
      const sameName = previousByName.get(container.name)
      const recreated = sameName !== undefined && sameName.container.id !== container.id
      register.push(
        newTask(
          container,
          now,
          startedByUs.has(container.id) ||
            (recreated ? sameName.startedByUs : false),
          recreated ? sameName.restartCount + 1 : 0,
        ),
      )
      keptIds.add(id)
      continue
    }

    keptIds.add(id)
    const wasLive = isLiveState(prior.container.state)
    const isLive = isLiveState(container.state)

    // Docker's own restart counter is not in `ps` output, so a transition INTO
    // `restarting` is what we count. That is the crash-loop signal.
    const restartCount =
      container.state === 'restarting' && prior.container.state !== 'restarting'
        ? prior.restartCount + 1
        : prior.restartCount

    const diedAt = isLive ? null : (prior.diedAt ?? (wasLive ? now : null))

    if (
      prior.container.state === container.state &&
      prior.container.health === container.health &&
      prior.container.status === container.status &&
      prior.restartCount === restartCount &&
      prior.diedAt === diedAt
    ) {
      continue
    }

    update.push({ ...prior, container, restartCount, diedAt })
  }

  const remove: string[] = []
  for (const [id, task] of existing) {
    if (keptIds.has(id)) {
      // Present in the snapshot but dead past its grace period.
      const next = update.find(u => u.id === id) ?? task
      if (next.diedAt !== null && now - next.diedAt >= DEAD_ROW_GRACE_MS) {
        remove.push(id)
      }
      continue
    }
    // Gone from docker entirely — removed, pruned, or `docker rm`'d.
    remove.push(id)
  }

  if (register.length === 0 && update.length === 0 && remove.length === 0) {
    return EMPTY_PATCH
  }
  const removed = new Set(remove)
  return {
    register: register.filter(t => !removed.has(t.id)),
    update: update.filter(t => !removed.has(t.id)),
    remove,
  }
}

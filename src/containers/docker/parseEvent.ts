// Pure reducer for one line of `docker events --format '{{json .}}'`.
//
// The events stream is what makes the panel real time: docker pushes a record
// the moment a container starts, dies, or flips health, so nothing here polls.
// A snapshot is still needed to seed and to re-sync after a reconnect, which is
// why this only classifies — it never fabricates a ContainerInfo out of an
// event.

import { logError } from 'src/shared/log.js'

/** The container actions worth reacting to. Everything else docker emits
 * (`exec_create`, `attach`, image and network events) leaves the panel alone. */
export type ContainerEventAction =
  | 'start'
  | 'die'
  | 'stop'
  | 'kill'
  | 'destroy'
  | 'pause'
  | 'unpause'
  | 'restart'
  | 'rename'
  | 'health_status'
  | 'oom'

const INTERESTING: ReadonlySet<string> = new Set<ContainerEventAction>([
  'start',
  'die',
  'stop',
  'kill',
  'destroy',
  'pause',
  'unpause',
  'restart',
  'rename',
  'health_status',
  'oom',
])

export type ContainerEvent = {
  action: ContainerEventAction
  containerId: string
  name: string | null
  /** compose project, when the container carries the label. */
  project: string | null
  /** Present on `die`: the container's exit code. */
  exitCode: number | null
  /** Present on `health_status`: `healthy` / `unhealthy`. */
  health: string | null
  /** True for an `oom` event — the one signal that separates a real OOM kill
   * from a bare exit 137. */
  oomKilled: boolean
}

/** Docker spells the health verdict into the action: `health_status: healthy`. */
const HEALTH_ACTION_RE = /^health_status:\s*(\S+)$/

type RawEvent = {
  Type?: string
  Action?: string
  Actor?: { ID?: string; Attributes?: Record<string, string> }
  id?: string
  status?: string
}

/**
 * Parse one line. Returns null for anything that is not a container event we
 * act on — including a malformed line, which is logged and skipped rather than
 * throwing, since one bad record must not take the watcher down.
 */
export function parseEventLine(line: string): ContainerEvent | null {
  const trimmed = line.trim()
  if (!trimmed.startsWith('{')) return null
  let raw: RawEvent
  try {
    raw = JSON.parse(trimmed) as RawEvent
  } catch (e) {
    logError(new Error('docker events: skipping unparseable line', { cause: e }))
    return null
  }
  if (raw.Type !== undefined && raw.Type !== 'container') return null

  const rawAction = (raw.Action ?? raw.status ?? '').trim()
  if (!rawAction) return null

  let action: string = rawAction
  let health: string | null = null
  const healthMatch = HEALTH_ACTION_RE.exec(rawAction)
  if (healthMatch) {
    action = 'health_status'
    health = healthMatch[1] ?? null
  } else if (rawAction.includes(':')) {
    // `exec_create: /bin/sh -c …` and friends. Not panel-relevant.
    action = rawAction.slice(0, rawAction.indexOf(':'))
  }
  if (!INTERESTING.has(action)) return null

  const attrs = raw.Actor?.Attributes ?? {}
  const exitCodeRaw = attrs.exitCode
  const exitCode =
    exitCodeRaw === undefined ? null : Number.parseInt(exitCodeRaw, 10)

  return {
    action: action as ContainerEventAction,
    containerId: raw.Actor?.ID ?? raw.id ?? '',
    name: attrs.name ?? null,
    project: attrs['com.docker.compose.project'] ?? null,
    exitCode: exitCode !== null && Number.isFinite(exitCode) ? exitCode : null,
    health,
    oomKilled: action === 'oom',
  }
}

/**
 * Whether an event should trigger a re-snapshot.
 *
 * Every interesting event does — the snapshot is one `docker ps`, and deriving
 * the new state from the event alone would mean maintaining a second, divergent
 * model of what docker thinks. The event's job is to say *when* to look, not
 * *what* the answer is.
 */
export function shouldResnapshot(event: ContainerEvent): boolean {
  return event.containerId !== ''
}

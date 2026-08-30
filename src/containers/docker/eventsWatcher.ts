// One long-lived `docker events` child, plus the `docker ps` snapshot it tells
// us when to take.
//
// This is the whole reason the panel is real time rather than polled: docker
// pushes a record the instant a container starts, dies or flips health, so a
// row updates in about a second without a subprocess every tick. The snapshot
// remains the source of truth for WHAT the state is — the event only says when
// to look — because deriving state from events alone means maintaining a second
// model that drifts from docker's the first time a record is missed.
//
// Killswitch: CLAUDIN_DISABLE_CONTAINER_PANEL=1 stops this from ever starting.

import { spawn, type ChildProcess } from 'node:child_process'
import { logError } from 'src/shared/log.js'
import { logForDebugging } from 'src/shared/debug.js'
import { dockerBin, getDockerAvailability, runDocker } from 'src/containers/docker/dockerCli.js'
import { parseEventLine, shouldResnapshot } from 'src/containers/docker/parseEvent.js'
import { parsePsOutput } from 'src/containers/docker/parsePs.js'
import { filterToProject } from 'src/containers/project.js'
import type { ContainerInfo } from 'src/containers/types.js'

/** Reconnect backoff, doubling to the ceiling. A daemon restart is the common
 * case and comes back within seconds; a permanently broken stream must not
 * become a spawn loop. */
const RECONNECT_BASE_MS = 1_000
const RECONNECT_MAX_MS = 30_000

/**
 * Events arrive in bursts — `compose up` on a three-service stack emits a dozen
 * within a few hundred milliseconds. Coalesce them into one snapshot instead of
 * running `docker ps` a dozen times.
 */
const SNAPSHOT_DEBOUNCE_MS = 150

/** How much of the stream's stderr to keep for the log line when it dies. */
const STDERR_TAIL_CHARS = 2_000

export function isContainerPanelDisabled(): boolean {
  return process.env.CLAUDIN_DISABLE_CONTAINER_PANEL === '1'
}

/** Take one project-scoped snapshot. Exported so the tool's `ps` op and the
 * watcher share exactly one definition of what the project's containers are. */
export async function snapshotProjectContainers(
  cwd: string,
  abortSignal?: AbortSignal,
): Promise<{ containers: ContainerInfo[]; error: string | null }> {
  const result = await runDocker(
    ['ps', '--all', '--no-trunc', '--format', '{{json .}}'],
    { cwd, abortSignal },
  )
  if (result.code !== 0) {
    return {
      containers: [],
      error: result.stderr.trim() || `docker ps exited ${result.code}`,
    }
  }
  return {
    containers: filterToProject(parsePsOutput(result.stdout), cwd),
    error: null,
  }
}

export type ContainerWatcherOptions = {
  cwd: string
  /** Called with a fresh project-scoped snapshot whenever docker says something
   * moved, and once at start. */
  onSnapshot: (containers: ContainerInfo[]) => void
  /** Called once, with a human-readable line, when the watcher gives up. */
  onDisabled: (message: string) => void
}

export type ContainerWatcher = {
  stop: () => void
  /** Force a snapshot now — used after a lifecycle op so the panel does not
   * wait for the event to arrive. */
  refresh: () => void
}

/**
 * Start watching. Returns immediately; the first snapshot arrives async.
 *
 * The caller owns the lifetime and MUST call `stop()` — a leaked child would
 * outlive the session.
 */
export function startContainerWatcher({
  cwd,
  onSnapshot,
  onDisabled,
}: ContainerWatcherOptions): ContainerWatcher {
  let stopped = false
  let child: ChildProcess | null = null
  let reconnectTimer: NodeJS.Timeout | null = null
  let snapshotTimer: NodeJS.Timeout | null = null
  let backoff = RECONNECT_BASE_MS
  let snapshotInFlight = false
  let snapshotQueued = false

  function disable(message: string): void {
    if (stopped) return
    stopped = true
    cleanup()
    onDisabled(message)
  }

  async function takeSnapshot(): Promise<void> {
    if (stopped) return
    if (snapshotInFlight) {
      snapshotQueued = true
      return
    }
    snapshotInFlight = true
    try {
      const { containers, error } = await snapshotProjectContainers(cwd)
      if (stopped) return
      if (error !== null) {
        // A failing snapshot is not fatal on its own — the daemon may be
        // restarting. The stream's own failure path is what gives up.
        logForDebugging(`container snapshot failed: ${error}`)
        return
      }
      onSnapshot(containers)
    } finally {
      snapshotInFlight = false
      if (snapshotQueued && !stopped) {
        snapshotQueued = false
        void takeSnapshot()
      }
    }
  }

  function scheduleSnapshot(): void {
    if (stopped || snapshotTimer) return
    snapshotTimer = setTimeout(() => {
      snapshotTimer = null
      void takeSnapshot()
    }, SNAPSHOT_DEBOUNCE_MS)
  }

  function connect(): void {
    if (stopped) return
    // `--filter type=container` keeps image, network and volume chatter out of
    // the stream. Project scoping stays client-side: a compose label filter
    // would silently drop a container whose labels we could not predict.
    const proc = spawn(
      dockerBin(),
      ['events', '--filter', 'type=container', '--format', '{{json .}}'],
      { cwd, stdio: ['ignore', 'pipe', 'pipe'] },
    )
    child = proc

    let buffer = ''
    proc.stdout?.setEncoding('utf8')
    proc.stdout?.on('data', (chunk: string) => {
      // A stream is not line-aligned; hold the partial tail for the next chunk.
      buffer += chunk
      const lines = buffer.split('\n')
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        const event = parseEventLine(line)
        if (event && shouldResnapshot(event)) scheduleSnapshot()
      }
      // A healthy stream proves the connection is good.
      backoff = RECONNECT_BASE_MS
    })

    // Drained on purpose. An unconsumed stderr pipe fills at the OS buffer
    // (~64 KB) and blocks the child FOREVER — the stream then never exits, so
    // the reconnect below never fires and the panel silently freezes on a
    // stale row with no error anywhere. Only the tail is kept.
    let stderrTail = ''
    proc.stderr?.setEncoding('utf8')
    proc.stderr?.on('data', (chunk: string) => {
      stderrTail = (stderrTail + chunk).slice(-STDERR_TAIL_CHARS)
    })

    proc.on('error', e => {
      logError(new Error('docker events failed to spawn', { cause: e }))
      disable('the docker events stream could not be started')
    })

    proc.on('exit', code => {
      if (stopped) return
      child = null
      if (stderrTail.trim()) {
        logForDebugging(`docker events exited ${code}: ${stderrTail.trim()}`)
      }
      // The stream died — a daemon restart, or docker went away. Re-snapshot on
      // reconnect so a change that happened while we were disconnected is not
      // missed, which is the whole failure mode a stale row comes from.
      reconnectTimer = setTimeout(() => {
        reconnectTimer = null
        connect()
        void takeSnapshot()
      }, backoff)
      backoff = Math.min(backoff * 2, RECONNECT_MAX_MS)
    })
  }

  function cleanup(): void {
    if (reconnectTimer) {
      clearTimeout(reconnectTimer)
      reconnectTimer = null
    }
    if (snapshotTimer) {
      clearTimeout(snapshotTimer)
      snapshotTimer = null
    }
    child?.kill()
    child = null
  }

  void (async () => {
    const availability = await getDockerAvailability()
    if (stopped) return
    if (!availability.available) {
      disable(availability.message)
      return
    }
    await takeSnapshot()
    if (stopped) return
    connect()
  })()

  return {
    stop() {
      stopped = true
      cleanup()
    },
    refresh() {
      scheduleSnapshot()
    },
  }
}

/**
 * The file-system side of the detector: chokidar over the watched locations,
 * narrowed to one callback per regular file created, modified or deleted.
 */
import { watch } from 'chokidar'

import { isRunningWithBun } from 'src/platform/install/bundledMode.js'
import { isIgnoredPath } from 'src/skills/changeDetection/ignoredPaths.js'

/** Milliseconds. `chokidarInterval` keeps its name because callers pass it. */
export type WatchTimings = {
  /** How long a file must keep its size before its change counts. */
  stabilityThreshold: number
  /** How often that size is checked. */
  pollInterval: number
  /** How often each watched file and directory is statted, when polling. */
  chokidarInterval: number
}

export type FileWatcher = {
  /** Resolves once the watcher is closed; no change is reported after the call. */
  close: () => Promise<void>
}

export type WatchHandlers = {
  onChange: (path: string) => void
  onError: (error: unknown) => void
}

export type WatchFiles = (
  locations: readonly string[],
  timings: WatchTimings,
  handlers: WatchHandlers,
) => FileWatcher

/** `<location>/<a>/<b>/<file>` is the deepest change that counts. */
const DIRECTORIES_BELOW_LOCATION = 2

const NOTHING_WATCHED: FileWatcher = { close: async () => {} }

export const watchSkillFiles: WatchFiles = (locations, timings, { onChange, onError }) => {
  if (locations.length === 0) return NOTHING_WATCHED
  const watcher = watch([...locations], {
    // The watcher is never what keeps the process alive.
    persistent: false,
    // What is there at the start is watched from then on, not reported.
    ignoreInitial: true,
    depth: DIRECTORIES_BELOW_LOCATION,
    ignored: isIgnoredPath,
    // An unreadable subdirectory is skipped, not an error.
    ignorePermissionErrors: true,
    awaitWriteFinish: {
      stabilityThreshold: timings.stabilityThreshold,
      pollInterval: timings.pollInterval,
    },
    usePolling: mustPollFileSystem(),
    // Binary files would otherwise be statted on a shorter interval of their own.
    interval: timings.chokidarInterval,
    binaryInterval: timings.chokidarInterval,
  })
  // Directories count only through the files in them, so addDir and
  // unlinkDir are left out.
  watcher.on('add', onChange).on('change', onChange).on('unlink', onChange).on('error', onError)
  return { close: () => watcher.close() }
}

/**
 * Bun's native watcher can deadlock: closing it while its thread is still
 * delivering events can hang both threads, and a watcher over a large skill
 * tree during a git operation gets there
 * (https://github.com/oven-sh/bun/issues/27469,
 * https://github.com/oven-sh/bun/issues/26385). So whatever Bun runs, the
 * test suite included, polls the tree with stat() instead, while dist/cli.mjs
 * under Node keeps native events. Drop this once Bun ships the fix.
 */
function mustPollFileSystem(): boolean {
  return isRunningWithBun()
}

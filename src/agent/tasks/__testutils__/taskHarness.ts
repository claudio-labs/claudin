/**
 * What the task characterization suites share: an isolated environment per
 * test, and an app-state store driven the way the REPL drives its own — a
 * getter plus a setter that takes an updater.
 *
 * The env hooks are registered by the calling file at its own top level, so
 * each file restores what it changed when it finishes.
 */
import { afterAll, afterEach, beforeAll, beforeEach } from 'bun:test'
import { mkdtempSync, rmSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { getDefaultAppState } from 'src/terminal/state/AppStateStore.js'
import type { AppState } from 'src/terminal/state/AppStateStore.js'
import { getCommandQueueSnapshot, resetCommandQueue } from 'src/agent/messageQueueManager.js'

/**
 * Points the config dir at a fresh directory for every test, then puts the
 * variable back. Returns a getter for the current test's config dir.
 *
 * The task output directory is left where it is, under the system temp dir:
 * `getTaskOutputDir()` fixes it at its first call for the life of the process,
 * so a per-file `CLAUDIN_TMPDIR` would only hold for whichever file ran first,
 * and the later files of the run would recreate it after this one removed it.
 */
export function isolateTaskEnv(prefix: string): () => string {
  let saved: string | undefined
  let perTest = ''

  beforeAll(() => {
    saved = process.env.CLAUDIN_CONFIG_DIR
  })
  beforeEach(() => {
    perTest = mkdtempSync(join(tmpdir(), `${prefix}-cfg-`))
    process.env.CLAUDIN_CONFIG_DIR = perTest
    resetCommandQueue()
  })
  afterEach(() => {
    resetCommandQueue()
    rmSync(perTest, { recursive: true, force: true })
  })
  afterAll(() => {
    if (saved === undefined) delete process.env.CLAUDIN_CONFIG_DIR
    else process.env.CLAUDIN_CONFIG_DIR = saved
  })
  return () => perTest
}

export type TaskStore = {
  get: () => AppState
  set: (update: (prev: AppState) => AppState) => void
  task: <T = Record<string, unknown>>(id: string) => T
}

export function createTaskStore(tasks: Record<string, unknown> = {}): TaskStore {
  let current = { ...getDefaultAppState(), tasks } as unknown as AppState
  return {
    get: () => current,
    set: update => {
      current = update(current)
    },
    task: <T,>(id: string) => current.tasks[id] as unknown as T,
  }
}

/** The text of every queued notification, oldest first. */
export function queuedTexts(): string[] {
  return getCommandQueueSnapshot().map(entry => String(entry.value))
}

/**
 * Whether a task descriptor is the stub `src/agent/ui/tasks/taskActions.test.ts`
 * installs. That suite replaces `LocalShellTask`, `LocalAgentTask`,
 * `DreamTask`, … (and `isPanelAgentTask`) through `mock.module`, which bun
 * applies to every file of a run that includes it, whatever the order. The
 * stub has a `kill` and nothing else, so there is no real descriptor to pin;
 * the suites skip those few checks then, and run them in a targeted run.
 *
 * Loading a second, unstubbed instance under another specifier was tried and
 * dropped: bun's coverage keeps one record per file, and the second instance
 * replaced the first.
 */
export function isStubbedDescriptor(descriptor: { type?: unknown }): boolean {
  return typeof descriptor.type !== 'string'
}

/** Resolves once `check` holds, polling on the real clock. */
export async function until(check: () => boolean, label: string, ms = 10_000): Promise<void> {
  const stop = Date.now() + ms
  while (!check()) {
    if (Date.now() > stop) throw new Error(`timed out waiting for ${label}`)
    await Bun.sleep(10)
  }
}

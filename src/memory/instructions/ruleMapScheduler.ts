/**
 * Runs the navigation-map sync at the end of a main-thread turn, and only when
 * the tree it is derived from could have moved — so a heal lands in the
 * session, and the commit, that moved the tree.
 *
 * Writing mid-session is safe for the prompt cache: nothing here rewrites a
 * prefix. The map is a `paths:` rule on the `nested_memory` lane, read from
 * disk at injection time, so a session that has not loaded it yet loads the
 * new bytes; one that has is shown the change by the changed-file watcher, as
 * an `edited_text_file` diff appended to the next turn. A hand-written map
 * without `paths:` is memoized with the rest of the instructions and stays as
 * first loaded until the next compact or `/clear`.
 *
 * Two layers decide whether a turn does any work, cheapest first:
 *
 *  1. **Did anything change?** The fingerprint is a `stat` of `<gitdir>/index`
 *     — the file `git ls-files` reads, which git replaces on every write — and
 *     of the map itself. Equal to the last run's: no spawn at all.
 *  2. **Did it change enough?** That is `syncRuleMap`'s drift tolerance, which
 *     already returns null for a tree that moved inside it.
 *
 * Gates: main thread only, not `--bare` (both at the call site, stopHooks.ts),
 * `/map off` for this project, and `CLAUDIN_DISABLE_RULE_MAP_SYNC=1`
 * everywhere (in `syncProjectRuleMap`). No-op until `initRuleMapSync()` has
 * run, which is what keeps a test that drives `handleStopHooks` from writing
 * into the real checkout's map.
 */
import { stat } from 'fs/promises'
import { join } from 'path'
import { createSystemMessage } from 'src/agent/messages/messages.js'
import type { SetAppState } from 'src/agent/Task.js'
import { trackRuleMapSync } from 'src/agent/tasks/RuleMapTask/RuleMapTask.js'
import {
  describeRuleMapNotice,
  gitDirOf,
  RULE_MAP_RELATIVE_PATH,
  type RuleMapSyncOutcome,
  syncProjectRuleMap,
} from 'src/memory/instructions/ruleMapAutoSync.js'
import {
  getIsNonInteractiveSession,
  getProjectRoot,
} from 'src/platform/bootstrap/state.js'
import { getCurrentProjectConfig } from 'src/platform/config/config.js'
import { isENOENT } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'
import type { ToolUseContext } from 'src/tools/Tool.js'

type AppendSystemMessageFn = NonNullable<ToolUseContext['appendSystemMessage']>

/** What a caller hands over: where to announce, and where to list. */
export type RuleMapTurn = {
  appendSystemMessage?: AppendSystemMessageFn
  setAppState?: SetAppState
  /** False when the caller reports the outcome itself (`/map sync`). */
  announce?: boolean
}

/** The last sync this process ran, for `/map status`. */
export type RuleMapRun = {
  at: number
  outcome: RuleMapSyncOutcome
  trigger: 'turn' | 'command'
}

/**
 * What a turn compares. Kept in two parts so a write can take in the map's
 * new stat without also absorbing an index change made while it ran.
 */
type RuleMapFingerprint = { index: string; map: string }

export type RuleMapSchedulerDeps = {
  root: () => string
  sync: (root: string) => Promise<RuleMapSyncOutcome>
  /** Changes whenever the map could need a sync; null when unknowable. */
  fingerprint: (root: string) => Promise<RuleMapFingerprint | null>
  disabledForProject: () => boolean
  interactive: () => boolean
  now: () => number
  /** Lists a sync in the footer while it runs and after it wrote. */
  track: (
    setAppState: SetAppState,
    sync: Promise<RuleMapSyncOutcome>,
  ) => Promise<RuleMapSyncOutcome>
}

let deps: RuleMapSchedulerDeps | null = null
let inFlight: Promise<void> | null = null
let lastFingerprint: string | null = null
let lastRun: RuleMapRun | null = null
/**
 * Git dir per root. A miss is cached against the stat of `<root>/.git`, so a
 * project that is not a repo costs one stat per turn rather than a spawn — and
 * a `git init` mid-session is still noticed.
 */
const gitDirs = new Map<string, { dir: string | null; dotGit: string }>()

const fingerprintKey = (f: RuleMapFingerprint): string => `${f.index}|${f.map}`

async function statKey(path: string): Promise<string> {
  try {
    const s = await stat(path)
    return `${s.ino}:${s.size}:${s.mtimeMs}`
  } catch (e: unknown) {
    if (isENOENT(e)) return 'absent'
    throw e
  }
}

async function resolveGitDir(root: string): Promise<string | null> {
  const dotGit = await statKey(join(root, '.git'))
  const cached = gitDirs.get(root)
  if (cached && (cached.dir !== null || cached.dotGit === dotGit)) {
    return cached.dir
  }
  const dir = await gitDirOf(root)
  gitDirs.set(root, { dir, dotGit })
  return dir
}

async function fingerprintTree(root: string): Promise<RuleMapFingerprint> {
  const dir = await resolveGitDir(root)
  // Not a git repo: the sync would skip every time, so a constant lets the
  // first skip stand instead of re-asking git on every turn.
  if (dir === null) return { index: 'no-git', map: '' }
  const [index, map] = await Promise.all([
    statKey(join(dir, 'index')),
    statKey(join(root, RULE_MAP_RELATIVE_PATH)),
  ])
  return { index, map }
}

function defaultDeps(): RuleMapSchedulerDeps {
  return {
    root: getProjectRoot,
    sync: syncProjectRuleMap,
    fingerprint: fingerprintTree,
    disabledForProject: () =>
      getCurrentProjectConfig().ruleMapSyncDisabled === true,
    interactive: () => !getIsNonInteractiveSession(),
    now: Date.now,
    track: (setAppState, sync) => trackRuleMapSync(setAppState, sync),
  }
}

/**
 * One sync, with what the user sees of it: a footer row (interactive only —
 * headless has no footer, and `registerTask` would leave a dangling SDK
 * `task_started` there) and the one-line notice.
 */
async function syncAndReport(
  d: RuleMapSchedulerDeps,
  root: string,
  turn: RuleMapTurn,
  trigger: RuleMapRun['trigger'],
): Promise<RuleMapSyncOutcome> {
  const setAppState = d.interactive() ? turn.setAppState : undefined
  const outcome = setAppState
    ? await d.track(setAppState, d.sync(root))
    : await d.sync(root)
  lastRun = { at: d.now(), outcome, trigger }
  if (outcome.status === 'skipped' || turn.announce === false) return outcome

  const notice = describeRuleMapNotice(outcome)
  if (turn.appendSystemMessage) {
    // Not 'info': SystemTextMessage hides that level outside verbose mode,
    // and a write into a tracked file is exactly what the user must see.
    turn.appendSystemMessage(createSystemMessage(notice, 'suggestion'))
  } else if (!d.interactive()) {
    // stderr, not stdout: a `-p --output-format json|stream-json` run owns
    // stdout, and a line ahead of its payload breaks every parser.
    // biome-ignore lint/suspicious/noConsole:: intentional console output
    console.error(notice)
  }
  return outcome
}

/**
 * Records what the next turn compares against. A write moved the map's own
 * stat, so the map half is re-read; the index half stays the one read before
 * the run, so a change made while it ran still shows next turn. A failed run
 * records nothing, and the next turn retries.
 */
async function remember(
  d: RuleMapSchedulerDeps,
  root: string,
  before: RuleMapFingerprint | null,
  outcome: RuleMapSyncOutcome,
): Promise<void> {
  if (
    before === null ||
    (outcome.status === 'skipped' && outcome.reason === 'error')
  ) {
    lastFingerprint = null
    return
  }
  if (outcome.status === 'skipped') {
    lastFingerprint = fingerprintKey(before)
    return
  }
  const after = await d.fingerprint(root)
  lastFingerprint =
    after === null
      ? null
      : fingerprintKey({ index: before.index, map: after.map })
}

async function runTurn(
  d: RuleMapSchedulerDeps,
  turn: RuleMapTurn,
): Promise<void> {
  try {
    if (d.disabledForProject()) return
    const root = d.root()
    const before = await d.fingerprint(root)
    if (before !== null && fingerprintKey(before) === lastFingerprint) return
    const outcome = await syncAndReport(d, root, turn, 'turn')
    await remember(d, root, before, outcome)
  } catch (e: unknown) {
    logError(e)
  }
}

/**
 * Runs `work` once nothing else is syncing, and marks it in flight — set
 * before the first await, so a turn ending meanwhile joins it and a headless
 * drain sees it — rather than letting two writes race.
 */
async function exclusive<T>(work: () => Promise<T>): Promise<T> {
  while (inFlight !== null) await inFlight
  const run = work()
  const done = run.then(
    () => {},
    () => {},
  )
  inFlight = done
  try {
    return await run
  } finally {
    if (inFlight === done) inFlight = null
  }
}

/**
 * Call once per session (from backgroundHousekeeping, beside initAutoDream),
 * or per test with the deps it needs faked.
 */
export function initRuleMapSync(
  overrides: Partial<RuleMapSchedulerDeps> = {},
): void {
  deps = { ...defaultDeps(), ...overrides }
  inFlight = null
  lastFingerprint = null
  lastRun = null
  gitDirs.clear()
}

/**
 * Entry point from stopHooks. Fire-and-forget: the turn never waits on it.
 * A turn that ends while a sync is still running joins that one rather than
 * queueing another — the fingerprint it would compare is still moving.
 */
export function executeRuleMapSync(turn: RuleMapTurn): Promise<void> {
  const d = deps
  if (d === null) return Promise.resolve()
  if (inFlight === null) void exclusive(() => runTurn(d, turn))
  return inFlight ?? Promise.resolve()
}

/**
 * A sync a command asked for: whatever the fingerprint says, and works before
 * `initRuleMapSync()`, since a command can be the first thing a session runs.
 * Never throws — `/init` awaits this before it builds its prompt, and a map
 * that could not be synced must not cost the user the command.
 */
function syncOnDemand(
  turn: RuleMapTurn,
  respectSwitch: boolean,
): Promise<RuleMapSyncOutcome> {
  return exclusive(async (): Promise<RuleMapSyncOutcome> => {
    const d = deps ?? defaultDeps()
    let root: string
    let before: RuleMapFingerprint | null = null
    let outcome: RuleMapSyncOutcome
    try {
      if (respectSwitch && d.disabledForProject()) {
        return { status: 'skipped', reason: 'off for this project' }
      }
      root = d.root()
      if (deps !== null) before = await d.fingerprint(root)
      outcome = await syncAndReport(d, root, turn, 'command')
    } catch (e: unknown) {
      logError(e)
      lastFingerprint = null
      return { status: 'skipped', reason: 'error' }
    }
    // Apart from the sync: a write already announced is still a write, even
    // if reading the fingerprint after it fails.
    if (deps !== null) {
      try {
        await remember(d, root, before, outcome)
      } catch (e: unknown) {
        logError(e)
        lastFingerprint = null
      }
    }
    return outcome
  })
}

/**
 * Sync now, in spite of `/map off` — asking for a sync by name (`/map sync`,
 * `/map annotate`) is the user overriding the switch.
 */
export function syncRuleMapNow(
  turn: RuleMapTurn = {},
): Promise<RuleMapSyncOutcome> {
  return syncOnDemand(turn, false)
}

/**
 * Sync now unless the project turned the sync off — `/init`, which reads the
 * map before any turn has ended to write it, but was not asked to override
 * `/map off`.
 */
export function syncRuleMapIfEnabled(
  turn: RuleMapTurn = {},
): Promise<RuleMapSyncOutcome> {
  return syncOnDemand(turn, true)
}

/**
 * Waits until nothing is syncing — headless exit, so a `-p` run keeps its
 * write. A loop, not one await: a command's sync can be queued behind the
 * turn's.
 */
export async function drainPendingRuleMapSync(): Promise<void> {
  while (inFlight !== null) await inFlight
}

export function getLastRuleMapRun(): RuleMapRun | null {
  return lastRun
}

/** Back to "never initialized", so a test can pin the no-op before init. */
export function resetRuleMapSyncForTesting(): void {
  deps = null
  inFlight = null
  lastFingerprint = null
  lastRun = null
  gitDirs.clear()
}

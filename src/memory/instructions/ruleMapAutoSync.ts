/**
 * Creates a project's navigation map on first run, and keeps its derivable
 * claims true on later ones.
 *
 * Default ON, in every project. Killswitch: `CLAUDIN_DISABLE_RULE_MAP_SYNC=1`
 * turns off both the create and the heal; nothing else here is load-bearing, so
 * a session with it set behaves exactly as it did before this module existed.
 * `/map off` is the per-project switch, read by the scheduler.
 *
 * This writes a **git-tracked file into the user's repo**, which is why the
 * gates below matter more than the feature does. It runs at the end of a
 * main-thread turn when the tracked files may have changed
 * (`ruleMapScheduler.ts` decides when), and on demand from `/map sync` and
 * `/init`. It writes only when the content actually changes, so a run that
 * gets here is one `git ls-files` and, usually, no write.
 *
 * The pure half — what the file should contain — is `rulesMapSync.ts`.
 */
import { execFile } from 'child_process'
import { dirname, join, posix } from 'path'
import { promisify } from 'util'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { writeFileSyncAndFlush } from 'src/shared/fs/file.js'
import { listTrackedFiles } from 'src/memory/instructions/rulesLint.js'
import {
  type DirCountChange,
  describeRuleMapWrite,
  diffRuleMapCounts,
  isHealerOnlyDiff,
  syncRuleMap,
} from 'src/memory/instructions/rulesMapSync.js'

const execFileAsync = promisify(execFile)

/** Where the map lives, in every project. */
export const RULE_MAP_RELATIVE_PATH = join(
  '.claudin',
  'rules',
  'search-strategy.md',
)
/** The same path as git names it — forward slashes on every platform. */
const RULE_MAP_GIT_PATH = posix.join('.claudin', 'rules', 'search-strategy.md')

export const RULE_MAP_KILLSWITCH = 'CLAUDIN_DISABLE_RULE_MAP_SYNC'

const GIT_TIMEOUT_MS = 10_000

/**
 * Why a sync wrote nothing. `error` is the only transient one — the scheduler
 * retries it next turn; every other reason stands until the tree or the map
 * moves.
 */
export type RuleMapSkipReason =
  | 'killswitch'
  | 'off for this project'
  | 'not a git repo'
  | 'worktree'
  | 'nothing to map'
  | 'already current'
  | 'uncommitted changes'
  | 'error'

export type RuleMapSyncOutcome =
  | { status: 'created'; path: string; changes: DirCountChange[] }
  | { status: 'healed'; path: string; changes: DirCountChange[] }
  | { status: 'skipped'; reason: RuleMapSkipReason }

/** A sync that wrote — the only kind anybody is told about. */
export type RuleMapWriteOutcome = Exclude<RuleMapSyncOutcome, { status: 'skipped' }>

/** Git's stdout as printed, or null when the command failed. */
async function gitRaw(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    })
    return stdout
  } catch (e: unknown) {
    logForDebugging(`[ruleMapAutoSync] git ${args[0]} failed: ${String(e)}`)
    return null
  }
}

/** Git's stdout trimmed — for the one-line answers. */
async function git(root: string, args: string[]): Promise<string | null> {
  return (await gitRaw(root, args))?.trim() ?? null
}

/**
 * The repo's git dir, absolute — where the index the map is derived from
 * lives. Null outside a git repo.
 */
export async function gitDirOf(root: string): Promise<string | null> {
  return git(root, ['rev-parse', '--absolute-git-dir'])
}

/**
 * True when the map has edits in flight that are the user's to finish; null
 * when git could not say.
 *
 * Untracked (`??`) does not count: the first sync leaves the file untracked,
 * and that map must keep healing before anybody commits it. Nor does a
 * modification this module would have made itself (`isHealerOnlyDiff`), which
 * is what every heal after the first leaves behind. Any other modification is
 * the user's, and so is one that cannot be compared against anything.
 */
async function hasUncommittedEdits(
  root: string,
  working: string,
  trackedFiles: readonly string[],
): Promise<boolean | null> {
  const status = await git(root, ['status', '--porcelain', '--', RULE_MAP_GIT_PATH])
  if (status === null) return null
  if (status.length === 0) return false
  if (status.split('\n').every(line => line.startsWith('??'))) return false
  // A map staged but never committed (`A `) has no HEAD version; the staged
  // one is then the baseline the user signed off on. The `./` makes git read
  // the path from `root`: `HEAD:<path>` is relative to the top of the repo,
  // which a project rooted in a subdirectory is not.
  const committed =
    (await gitRaw(root, ['show', `HEAD:./${RULE_MAP_GIT_PATH}`])) ??
    (await gitRaw(root, ['show', `:./${RULE_MAP_GIT_PATH}`]))
  return committed === null || !isHealerOnlyDiff(committed, working, trackedFiles)
}

/**
 * Writes through a temp file so a crash — or a second session starting in the
 * same repo — cannot leave a half-written rule. The temp name carries the pid
 * because there is no lock on anything under a project's `.claudin/`, so two
 * concurrent sessions have to not collide on the way in.
 */
function writeAtomically(absPath: string, content: string): void {
  const fs = getFsImplementation()
  fs.mkdirSync(dirname(absPath))
  const temp = `${absPath}.${process.pid}.tmp`
  writeFileSyncAndFlush(temp, content, { encoding: 'utf8' })
  fs.renameSync(temp, absPath)
}

/**
 * Brings `<root>/.claudin/rules/search-strategy.md` in line with the tree.
 *
 * Never throws: a navigation map is a convenience, and a session that cannot
 * start because one could not be written is a much worse bug than a stale map.
 */
export async function syncProjectRuleMap(
  root: string,
): Promise<RuleMapSyncOutcome> {
  if (isEnvTruthy(process.env[RULE_MAP_KILLSWITCH])) {
    return { status: 'skipped', reason: 'killswitch' }
  }

  try {
    const gitDir = await git(root, ['rev-parse', '--git-dir'])
    if (gitDir === null) {
      return { status: 'skipped', reason: 'not a git repo' }
    }
    // Worktrees are shared scratch space here, and a sub-agent's worktree path
    // can canonicalize back to the main checkout (`.claudin/rules/agent-safety.md`
    // §2), so a write from one is a write into somebody else's tree. A linked
    // worktree's git dir sits under `…/.git/worktrees/<name>`.
    if (gitDir.includes('/worktrees/')) {
      return { status: 'skipped', reason: 'worktree' }
    }

    const trackedFiles = await listTrackedFiles(root)
    // A repo whose file list could not be read is a failure worth retrying;
    // one with nothing tracked yet simply has nothing to map.
    if (trackedFiles === null) return { status: 'skipped', reason: 'error' }
    if (trackedFiles.length === 0) {
      return { status: 'skipped', reason: 'nothing to map' }
    }

    const absPath = join(root, RULE_MAP_RELATIVE_PATH)
    const fs = getFsImplementation()
    const existed = fs.existsSync(absPath)
    const content = existed
      ? await fs.readFile(absPath, { encoding: 'utf8' })
      : ''
    const next = syncRuleMap({ content, trackedFiles })
    if (next === null || next === content) {
      // Distinguished because they debug differently: one means the map is
      // fine, the other means this repo has no tree to draw and never will
      // until its code groups into directories.
      return {
        status: 'skipped',
        reason: existed ? 'already current' : 'nothing to map',
      }
    }

    // A map the user is in the middle of editing is theirs. Healing it now
    // would mix generated numbers into an uncommitted diff they are about to
    // read, which is the fastest way to get an auto-updating file reverted.
    // Asked only once there is something to write: the two spawns it costs
    // would otherwise run on every turn that changed the index.
    if (existed) {
      const edited = await hasUncommittedEdits(root, content, trackedFiles)
      if (edited === null) return { status: 'skipped', reason: 'error' }
      if (edited) return { status: 'skipped', reason: 'uncommitted changes' }
    }

    writeAtomically(absPath, next)
    return {
      status: existed ? 'healed' : 'created',
      path: RULE_MAP_RELATIVE_PATH,
      changes: diffRuleMapCounts(content, next),
    }
  } catch (e: unknown) {
    logForDebugging(`[ruleMapAutoSync] sync failed in ${root}: ${String(e)}`)
    return { status: 'skipped', reason: 'error' }
  }
}

/**
 * The one line a write announces:
 * `Navigation map · <path> · updated · src/tools/ 682→751`.
 *
 * A first map names the switch that turns this off, since it is the moment a
 * git-tracked file appears in somebody's repo unasked; an update names what
 * moved, which is what a reviewer of the next diff needs.
 */
export function describeRuleMapNotice(write: RuleMapWriteOutcome): string {
  const hint = write.status === 'created' ? ' (/map off to turn this off)' : ''
  return `Navigation map · ${write.path} · ${describeRuleMapWrite(write)}${hint}`
}

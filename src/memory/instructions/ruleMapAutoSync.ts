/**
 * Creates a project's navigation map on first run, and keeps its derivable
 * claims true on later ones.
 *
 * Default ON, in every project. Killswitch: `CLAUDIN_DISABLE_RULE_MAP_SYNC=1`
 * turns off both the create and the heal; nothing else here is load-bearing, so
 * a session with it set behaves exactly as it did before this module existed.
 *
 * This writes a **git-tracked file into the user's repo**, which is why the
 * gates below matter more than the feature does. It runs once per session,
 * before the first prompt is assembled (`src/platform/setup.ts`), because
 * `getMemoryFiles` memoizes for the process lifetime — a rewrite after that
 * point would leave the running session reading bytes that are no longer on
 * disk. It writes only when the content actually changes, so the common case is
 * one `git ls-files` and no I/O at all.
 *
 * The pure half — what the file should contain — is `rulesMapSync.ts`.
 */
import { execFile } from 'child_process'
import { dirname, join } from 'path'
import { promisify } from 'util'
import { logForDebugging } from 'src/shared/debug.js'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getFsImplementation } from 'src/shared/fs/fsOperations.js'
import { writeFileSyncAndFlush } from 'src/shared/fs/file.js'
import { listTrackedFiles } from 'src/memory/instructions/rulesLint.js'
import { syncRuleMap } from 'src/memory/instructions/rulesMapSync.js'

const execFileAsync = promisify(execFile)

/** Where the map lives, in every project. */
export const RULE_MAP_RELATIVE_PATH = join(
  '.claudin',
  'rules',
  'search-strategy.md',
)

export const RULE_MAP_KILLSWITCH = 'CLAUDIN_DISABLE_RULE_MAP_SYNC'

const GIT_TIMEOUT_MS = 10_000

export type RuleMapSyncOutcome =
  | { status: 'created'; path: string }
  | { status: 'healed'; path: string }
  | { status: 'skipped'; reason: string }

async function git(root: string, args: string[]): Promise<string | null> {
  try {
    const { stdout } = await execFileAsync('git', args, {
      cwd: root,
      encoding: 'utf8',
      timeout: GIT_TIMEOUT_MS,
    })
    return stdout.trim()
  } catch (e: unknown) {
    logForDebugging(`[ruleMapAutoSync] git ${args[0]} failed: ${String(e)}`)
    return null
  }
}

/**
 * True inside a linked worktree.
 *
 * Worktrees are shared scratch space here, and a sub-agent's worktree path can
 * canonicalize back to the main checkout (`.claudin/rules/agent-safety.md` §2),
 * so a write from one is a write into somebody else's tree. `--git-dir` is the
 * project-agnostic way to ask: a linked worktree's git dir sits under
 * `…/.git/worktrees/<name>`.
 */
async function isLinkedWorktree(root: string): Promise<boolean> {
  const gitDir = await git(root, ['rev-parse', '--git-dir'])
  return gitDir !== null && gitDir.includes('/worktrees/')
}

/**
 * True when the map has edits in flight that are the user's to finish.
 *
 * Untracked (`??`) does not count: the very first sync leaves the file
 * untracked, and treating that as "someone is editing" would freeze every map
 * we create at its birth numbers until somebody committed it. A tracked file
 * with modifications is a different thing, and is left alone.
 */
async function hasUncommittedEdits(
  root: string,
  relPath: string,
): Promise<boolean> {
  const status = await git(root, ['status', '--porcelain', '--', relPath])
  if (status === null) return true
  if (status.length === 0) return false
  return !status.split('\n').every(line => line.startsWith('??'))
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
    if (await isLinkedWorktree(root)) {
      return { status: 'skipped', reason: 'worktree' }
    }

    const trackedFiles = await listTrackedFiles(root)
    if (!trackedFiles || trackedFiles.length === 0) {
      return { status: 'skipped', reason: 'not a git repo' }
    }

    const absPath = join(root, RULE_MAP_RELATIVE_PATH)
    const fs = getFsImplementation()
    const existed = fs.existsSync(absPath)

    // A map the user is in the middle of editing is theirs. Healing it now
    // would mix generated numbers into an uncommitted diff they are about to
    // read, which is the fastest way to get an auto-updating file reverted.
    if (existed && (await hasUncommittedEdits(root, RULE_MAP_RELATIVE_PATH))) {
      return { status: 'skipped', reason: 'uncommitted changes' }
    }

    const content = existed
      ? await fs.readFile(absPath, { encoding: 'utf8' })
      : ''
    const next = syncRuleMap({ content, trackedFiles })
    if (next === null || next === content) {
      return { status: 'skipped', reason: 'already current' }
    }

    writeAtomically(absPath, next)
    return {
      status: existed ? 'healed' : 'created',
      path: RULE_MAP_RELATIVE_PATH,
    }
  } catch (e: unknown) {
    logForDebugging(`[ruleMapAutoSync] sync failed in ${root}: ${String(e)}`)
    return { status: 'skipped', reason: 'error' }
  }
}

/** The one line a write announces. Null when nothing was written. */
export function describeRuleMapSync(
  outcome: RuleMapSyncOutcome,
): string | null {
  if (outcome.status === 'skipped') return null
  const verb = outcome.status === 'created' ? 'created' : 'updated'
  return `Navigation map ${verb}: ${outcome.path} (${RULE_MAP_KILLSWITCH}=1 to turn this off)`
}

/**
 * The process group a shell command leads, after the shell itself is gone.
 *
 * Shell.ts spawns every shell detached, so the shell's pid is its group's id
 * and whatever it starts stays in that group unless it asks for a session of
 * its own — `sleep 300 &`, `(server &)`, a script that backgrounds a server
 * and returns. Once the shell exits those processes run on with nothing
 * tracking them. In 10-25..30 the model stopped such servers by hand: eleven
 * separate `kill <pid>` requests in one session, `pkill -f "[f]errous…"`,
 * `pgrep`, `ss -lntu | grep <port>` (team memory
 * `census-2026-10-30-cache-tools-context`).
 *
 * POSIX only: Windows has no process groups to probe.
 */
import { spawnSync } from 'child_process'
import { isEnvTruthy } from 'src/shared/envUtils.js'
import { getErrnoCode } from 'src/shared/errors.js'
import { logError } from 'src/shared/log.js'

/** One line of the process table. */
export type ProcessRow = { pid: number; pgid: number; command: string }

/** A group that outlived its shell, and who was in it when it was found. */
export type ProcessGroup = {
  pgid: number
  members: { pid: number; command: string }[]
}

/** The two things this module does to the system, injectable for tests. */
export type ProcessGroupDeps = {
  signal: (pid: number, signal: NodeJS.Signals | 0) => void
  list: () => ProcessRow[]
}

const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(.*)$/
/** How long a group may ignore SIGTERM before it gets SIGKILL. */
const STOP_GRACE_MS = 5_000

function listProcesses(): ProcessRow[] {
  // `-ww`: never cut the command line to a terminal's width.
  const ps = spawnSync('ps', ['-A', '-ww', '-o', 'pid=,pgid=,args='], { encoding: 'utf8', timeout: 2_000 })
  if (ps.status !== 0 || typeof ps.stdout !== 'string') return []
  const rows: ProcessRow[] = []
  for (const line of ps.stdout.split('\n')) {
    const match = PS_LINE_RE.exec(line)
    if (match) rows.push({ pid: Number(match[1]), pgid: Number(match[2]), command: match[3]!.trim() })
  }
  return rows
}

const SYSTEM: ProcessGroupDeps = {
  signal: (pid, signal) => {
    process.kill(pid, signal)
  },
  list: listProcesses,
}

/**
 * `CLAUDIN_ADOPT_LEFTOVERS=1`: a shell command that exits leaving processes in
 * its group reports them, and the Bash tool adopts them as a task that
 * TaskStop stops and the session's end stops (`LocalShellTask/leftovers.ts`).
 * Off until the A/B decides; read per call so a test can set it.
 */
export function isAdoptLeftoversEnabled(): boolean {
  return isEnvTruthy(process.env.CLAUDIN_ADOPT_LEFTOVERS)
}

/**
 * Signal the group `pid` leads. A shell spawned attached, as hooks are, leads
 * none, and a group that is already gone is no error either.
 */
export function signalProcessGroup(pid: number, signal: NodeJS.Signals): void {
  if (process.platform === 'win32') return
  try {
    process.kill(-pid, signal)
  } catch (e) {
    if (getErrnoCode(e) !== 'ESRCH') logError(e)
  }
}

/**
 * The live members of group `pgid`, or null when it has none. The probe is a
 * signal 0 to the group, so the process table is only read for a group that
 * is still there — which a command that cleans up after itself never leaves.
 */
export function findProcessGroup(pgid: number, deps: ProcessGroupDeps = SYSTEM): ProcessGroup | null {
  if (process.platform === 'win32') return null
  try {
    deps.signal(-pgid, 0)
  } catch {
    return null
  }
  const members = deps
    .list()
    .filter(row => row.pgid === pgid)
    .map(row => ({ pid: row.pid, command: row.command }))
  return members.length > 0 ? { pgid, members } : null
}

/**
 * Stop a group found earlier: SIGTERM, and SIGKILL if it is still there after
 * the grace. Nothing is sent once none of the members recorded at finding time
 * is left in it, since by then the group id may belong to someone else.
 * Returns whether a signal went out. `graceMs` is for tests.
 */
export function stopProcessGroup(
  group: ProcessGroup,
  deps: ProcessGroupDeps = SYSTEM,
  graceMs = STOP_GRACE_MS,
): boolean {
  const recorded = new Set(group.members.map(m => m.pid))
  const stillOurs = () => deps.list().some(row => row.pgid === group.pgid && recorded.has(row.pid))
  if (!stillOurs()) return false
  try {
    deps.signal(-group.pgid, 'SIGTERM')
  } catch (e) {
    if (getErrnoCode(e) !== 'ESRCH') logError(e)
    return false
  }
  const escalate = setTimeout(() => {
    if (!stillOurs()) return
    try {
      deps.signal(-group.pgid, 'SIGKILL')
    } catch (e) {
      if (getErrnoCode(e) !== 'ESRCH') logError(e)
    }
  }, graceMs)
  escalate.unref()
  return true
}

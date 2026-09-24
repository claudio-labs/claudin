import { execFileNoThrow } from 'src/shared/proc/execFileNoThrow.js'

/**
 * Is a silent build still working?
 *
 * The idle watchdog used to read silence as a hang, and silence is not one:
 * rustc linking a fat-LTO release, a single codegen unit or a big javac pass
 * print nothing for minutes while a core runs flat out. Three of twenty
 * ferrous-dns builds were stopped that way at 180 s, each carrying an explicit
 * 15–20 minute `timeout`, and each retry succeeded. A hang looks different:
 * nothing prints AND nothing in the command's process tree uses CPU — a lock,
 * the network, a prompt. This module tells the two apart by sampling the tree.
 *
 * Pure core, thin shell: `parsePsTable`, `descendantsOf` and `hasActivity` take
 * text and snapshots; `sampleProcessTree` is the only function that runs
 * anything. Where `ps` is missing or refuses — Windows — it answers null, and
 * the watchdog falls back to silence alone, its behaviour before this existed.
 * CPU spent in a daemon OUTSIDE the tree (the Gradle daemon, a dotnet build
 * server) is invisible here; an explicit `timeout` covers those builds.
 */

export type ProcessRow = { pid: number; ppid: number; cpuSeconds: number }

/** CPU seconds per live pid of one command's process tree. */
export type TreeSnapshot = ReadonlyMap<number, number>

/**
 * CPU a sample window has to add before it counts as work: about 7% of one core
 * over the ~15 s the watchdog waits between samples. Below it sit the pollers
 * and watchers that keep a wedged build ticking without doing anything.
 */
export const MIN_CPU_GAIN_SECONDS = 1

const PS_LINE_RE = /^\s*(\d+)\s+(\d+)\s+(\S+)\s*$/
/** procps prints `01:02:03` or `1-02:03:04`; BSD `ps` prints `1:02.03`. */
const CPU_TIME_RE = /^(?:(\d+)-)?(?:(\d+):)?(\d+):(\d+(?:\.\d+)?)$/
const PS_ARGS = ['-A', '-o', 'pid=,ppid=,time=']
const PS_TIMEOUT_MS = 5_000

export function parseCpuTime(text: string): number | null {
  const m = CPU_TIME_RE.exec(text)
  if (!m) return null
  const [, days, hours, minutes, seconds] = m
  return (
    (Number(days ?? 0) * 24 + Number(hours ?? 0)) * 3600 + Number(minutes) * 60 + Number(seconds)
  )
}

/** Rows of `ps -A -o pid=,ppid=,time=`; a line that does not parse is skipped. */
export function parsePsTable(text: string): ProcessRow[] {
  const rows: ProcessRow[] = []
  for (const line of text.split('\n')) {
    const m = PS_LINE_RE.exec(line)
    if (!m) continue
    const cpuSeconds = parseCpuTime(m[3]!)
    if (cpuSeconds === null) continue
    rows.push({ pid: Number(m[1]), ppid: Number(m[2]), cpuSeconds })
  }
  return rows
}

/** The root and every process below it, each with its CPU seconds. Empty when the root is gone. */
export function descendantsOf(rows: readonly ProcessRow[], root: number): Map<number, number> {
  const children = new Map<number, ProcessRow[]>()
  for (const row of rows) {
    const siblings = children.get(row.ppid)
    if (siblings) siblings.push(row)
    else children.set(row.ppid, [row])
  }
  const tree = new Map<number, number>()
  const rootRow = rows.find(row => row.pid === root)
  if (!rootRow) return tree
  const pending = [rootRow]
  while (pending.length > 0) {
    const row = pending.pop()!
    if (tree.has(row.pid)) continue
    tree.set(row.pid, row.cpuSeconds)
    pending.push(...(children.get(row.pid) ?? []))
  }
  return tree
}

/**
 * Did the tree work between two samples? Either its members together gained at
 * least `MIN_CPU_GAIN_SECONDS`, or a process appeared that was not there before
 * — a build fanning out short compiler jobs can finish each one between two
 * samples, so no pid ever shows a gain, but the churn does. A member that only
 * EXITED is not work: a wedged build can lose its last worker.
 */
export function hasActivity(previous: TreeSnapshot, next: TreeSnapshot): boolean {
  let gained = 0
  for (const [pid, cpu] of next) {
    const before = previous.get(pid)
    if (before === undefined) return true
    if (cpu > before) gained += cpu - before
  }
  return gained >= MIN_CPU_GAIN_SECONDS
}

/** One sample of the tree under `root`, or null when it cannot be taken. */
export async function sampleProcessTree(root: number): Promise<TreeSnapshot | null> {
  if (process.platform === 'win32') return null
  const { stdout, code } = await execFileNoThrow('ps', PS_ARGS, {
    timeout: PS_TIMEOUT_MS,
    useCwd: false,
  })
  if (code !== 0) return null
  const tree = descendantsOf(parsePsTable(stdout), root)
  return tree.size > 0 ? tree : null
}

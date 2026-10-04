/** How long SIGINT gets before SIGTERM follows. */
export const SIGTERM_AFTER_MS = 100
/** How long SIGTERM gets before SIGKILL follows. */
export const SIGKILL_AFTER_MS = 400
const EXIT_POLL_MS = 10

export type ProcessStopperDeps = {
  /** Sends `signal`; false when the process is already gone. */
  signal: (pid: number, signal: NodeJS.Signals) => boolean
  isAlive: (pid: number) => boolean
  sleep: (ms: number) => Promise<void>
}

/** Signal 0 sends nothing: it only asks whether the process exists. */
function signalProcess(pid: number, signal: NodeJS.Signals | 0): boolean {
  try {
    process.kill(pid, signal)
    return true
  } catch {
    return false
  }
}

const defaultProcessStopperDeps: ProcessStopperDeps = {
  signal: signalProcess,
  isAlive: pid => signalProcess(pid, 0),
  sleep: ms => new Promise(resolve => setTimeout(resolve, ms)),
}

async function exitsWithin(pid: number, ms: number, deps: ProcessStopperDeps): Promise<boolean> {
  const deadline = Date.now() + ms
  while (Date.now() < deadline) {
    if (!deps.isAlive(pid)) return true
    await deps.sleep(Math.min(EXIT_POLL_MS, Math.max(0, deadline - Date.now())))
  }
  return !deps.isAlive(pid)
}

/**
 * SIGINT, then SIGTERM, then SIGKILL, each only while the process lives, so a
 * server that ignores the polite signals is still gone within about 500 ms.
 * Never throws.
 */
export async function stopProcess(
  pid: number,
  deps: ProcessStopperDeps = defaultProcessStopperDeps,
): Promise<void> {
  if (!deps.signal(pid, 'SIGINT')) return
  if (await exitsWithin(pid, SIGTERM_AFTER_MS, deps)) return
  if (!deps.signal(pid, 'SIGTERM')) return
  if (await exitsWithin(pid, SIGKILL_AFTER_MS, deps)) return
  deps.signal(pid, 'SIGKILL')
}

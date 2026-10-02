/** Small helpers shared by the LSP characterization suites. */
import { mkdtempSync, readFileSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'

/** Polls until `check` holds, or fails after `withinMs`. */
export async function eventually(check: () => boolean, withinMs = 3000, what = 'condition'): Promise<void> {
  const deadline = Date.now() + withinMs
  while (!check()) {
    if (Date.now() > deadline) throw new Error(`timed out waiting for ${what}`)
    await new Promise(resolve => setTimeout(resolve, 15))
  }
}

export function processIsAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

export function readPid(file: string): number {
  return Number(readFileSync(file, 'utf8'))
}

/** One temp dir per call; `cleanup()` removes every dir it handed out. */
export function tempDirs(prefix: string): { make: () => string; cleanup: () => void } {
  const made: string[] = []
  return {
    make: () => {
      const dir = mkdtempSync(join(tmpdir(), prefix))
      made.push(dir)
      return dir
    },
    cleanup: () => {
      for (const dir of made.splice(0)) rmSync(dir, { recursive: true, force: true })
    },
  }
}

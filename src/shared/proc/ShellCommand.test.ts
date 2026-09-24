import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { existsSync, mkdtempSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { join } from 'path'
import { TaskOutput } from 'src/agent/tasks/TaskOutput.js'
import { _setKillGraceMsForTesting, wrapSpawn } from 'src/shared/proc/ShellCommand.js'

const dirs: string[] = []
const children: ChildProcess[] = []

afterEach(() => {
  _setKillGraceMsForTesting(null)
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
})

/** A detached bash, spawned the way Shell.ts spawns one, wrapped as a ShellCommand. */
function start(script: string, env: Record<string, string> = {}) {
  const child = spawn('bash', ['-c', script], {
    detached: true,
    stdio: 'ignore',
    env: { ...process.env, ...env },
  })
  children.push(child)
  const controller = new AbortController()
  const command = wrapSpawn(child, controller.signal, 60_000, new TaskOutput(`t${child.pid}`, null))
  return { child, controller, command }
}

function exited(child: ChildProcess, withinMs: number): Promise<boolean> {
  if (child.exitCode !== null || child.signalCode !== null) return Promise.resolve(true)
  return new Promise(resolve => {
    const timer = setTimeout(() => resolve(false), withinMs)
    child.once('exit', () => {
      clearTimeout(timer)
      resolve(true)
    })
  })
}

async function waitFor(check: () => boolean, withinMs: number): Promise<boolean> {
  const deadline = Date.now() + withinMs
  while (Date.now() < deadline) {
    if (check()) return true
    await Bun.sleep(25)
  }
  return check()
}

describe('ShellCommand — stopping a command', () => {
  test('a stopped command runs its SIGTERM cleanup before it goes', async () => {
    const dir = mkdtempSync(join(tmpdir(), 'shellcommand-'))
    dirs.push(dir)
    const marker = join(dir, 'cleaned')
    // `wait` is interruptible, so the trap runs as soon as the TERM lands.
    const { controller, command } = start(
      `trap 'echo cleaned > "$MARKER"; exit 0' TERM; sleep 30 & wait`,
      { MARKER: marker },
    )
    await Bun.sleep(200) // let bash install the trap
    controller.abort()
    const result = await command.result
    expect(result.interrupted).toBe(true)
    expect(await waitFor(() => existsSync(marker), 3_000)).toBe(true)
  })

  test('a command that ignores SIGTERM is killed once the grace runs out', async () => {
    _setKillGraceMsForTesting(300)
    const { child, controller, command } = start(`trap '' TERM; sleep 30`)
    await Bun.sleep(200)
    controller.abort()
    await command.result
    expect(await exited(child, 3_000)).toBe(true)
  })
})

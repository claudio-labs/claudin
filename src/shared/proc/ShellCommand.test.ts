import { afterEach, describe, expect, test } from 'bun:test'
import { spawn, type ChildProcess } from 'child_process'
import { closeSync, existsSync, mkdirSync, mkdtempSync, openSync, rmSync } from 'fs'
import { tmpdir } from 'os'
import { dirname, join } from 'path'
import { TaskOutput } from 'src/agent/tasks/TaskOutput.js'
import {
  _setKillGraceMsForTesting,
  createAbortedCommand,
  createFailedCommand,
  wrapSpawn,
} from 'src/shared/proc/ShellCommand.js'

const dirs: string[] = []
const children: ChildProcess[] = []
/** Task output files a test made the command write; removed after each test. */
const outputFiles: string[] = []
const savedMaxOutput = process.env.BASH_MAX_OUTPUT_LENGTH
let taskSeq = 0

afterEach(() => {
  _setKillGraceMsForTesting(null)
  for (const child of children.splice(0)) {
    if (child.exitCode === null && child.signalCode === null) child.kill('SIGKILL')
  }
  for (const dir of dirs.splice(0)) rmSync(dir, { recursive: true, force: true })
  for (const file of outputFiles.splice(0)) rmSync(file, { force: true })
  if (savedMaxOutput === undefined) delete process.env.BASH_MAX_OUTPUT_LENGTH
  else process.env.BASH_MAX_OUTPUT_LENGTH = savedMaxOutput
})

function taskId(): string {
  return `shellcommand-test-${process.pid}-${++taskSeq}`
}

/** A bash in pipe mode (how hooks run): stdout/stderr stream into TaskOutput. */
function startPiped(
  script: string,
  opts: { timeout?: number; autoBackground?: boolean } = {},
) {
  const child = spawn('bash', ['-c', script], { stdio: ['ignore', 'pipe', 'pipe'] })
  children.push(child)
  const controller = new AbortController()
  const taskOutput = new TaskOutput(taskId(), null)
  outputFiles.push(taskOutput.path)
  const command = wrapSpawn(
    child,
    controller.signal,
    opts.timeout ?? 60_000,
    taskOutput,
    opts.autoBackground ?? false,
  )
  return { child, controller, command, taskOutput }
}

/** A bash in file mode (how BashTool runs): both fds go to the task output file. */
function startToFile(script: string, opts: { autoBackground?: boolean } = {}) {
  const taskOutput = new TaskOutput(taskId(), null, true)
  mkdirSync(dirname(taskOutput.path), { recursive: true })
  outputFiles.push(taskOutput.path)
  const fd = openSync(taskOutput.path, 'w')
  const child = spawn('bash', ['-c', script], { stdio: ['ignore', fd, fd] })
  closeSync(fd)
  children.push(child)
  const controller = new AbortController()
  const command = wrapSpawn(
    child,
    controller.signal,
    60_000,
    taskOutput,
    opts.autoBackground ?? false,
  )
  return { child, controller, command, taskOutput }
}

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

describe('ShellCommand — exit codes and output', () => {
  test('a command that exits on its own completes with its exit code and its output', async () => {
    const { command } = startPiped('echo out; echo err >&2; exit 3')
    expect(command.status).toBe('running')
    expect(typeof command.pid).toBe('number')
    const result = await command.result
    expect(result).toMatchObject({ code: 3, stdout: 'out\n', stderr: 'err\n', interrupted: false })
    expect(result.backgroundTaskId).toBeUndefined()
    expect(command.status).toBe('completed')
  })

  test('a shell killed by SIGTERM from outside exits 144', async () => {
    const { command } = startPiped('kill -TERM $$')
    const result = await command.result
    expect(result.code).toBe(144)
    expect(result.stderr).toBe('')
  })

  test('a shell killed by any other signal from outside exits 1', async () => {
    const { command } = startPiped('kill -KILL $$')
    const result = await command.result
    expect(result.code).toBe(1)
    expect(result.interrupted).toBe(false)
  })

  test('a process that fails to spawn resolves with exit code 1', async () => {
    const child = spawn('/nonexistent-shellcommand-binary', [], { stdio: 'ignore' })
    children.push(child)
    const command = wrapSpawn(child, new AbortController().signal, 60_000, new TaskOutput(taskId(), null))
    const result = await command.result
    expect(result.code).toBe(1)
    expect(result.stdout).toBe('')
  })

  test('file mode reads stdout from the output file and deletes it when it fit inline', async () => {
    const { command, taskOutput } = startToFile('echo from-file; echo to-stderr >&2')
    const result = await command.result
    expect(result.code).toBe(0)
    expect(result.stdout).toBe('from-file\nto-stderr\n')
    expect(result.outputFilePath).toBeUndefined()
    expect(await waitFor(() => !existsSync(taskOutput.path), 3_000)).toBe(true)
  })

  test('file mode output too large to inline points the caller at the file', async () => {
    process.env.BASH_MAX_OUTPUT_LENGTH = '10'
    const { command, taskOutput } = startToFile('printf "0123456789abcdefghij"')
    const result = await command.result
    expect(result.stdout).toBe('0123456789')
    expect(result.outputFilePath).toBe(taskOutput.path)
    expect(result.outputFileSize).toBe(20)
    expect(result.outputTaskId).toBe(taskOutput.taskId)
    expect(existsSync(taskOutput.path)).toBe(true)
  })
})

describe('ShellCommand — kill, abort and timeout', () => {
  test('kill() resolves as interrupted (137) and marks the command killed', async () => {
    const { child, command } = startPiped('sleep 30')
    command.kill()
    const result = await command.result
    expect(result.code).toBe(137)
    expect(result.interrupted).toBe(true)
    expect(result.stderr).not.toContain('timed out')
    expect(command.status).toBe('killed')
    expect(await exited(child, 3_000)).toBe(true)
  })

  test('an abort mid-run kills the command', async () => {
    const { controller, command } = startPiped('sleep 30')
    await Bun.sleep(50)
    controller.abort()
    const result = await command.result
    expect(result.code).toBe(137)
    expect(command.status).toBe('killed')
  })

  test('an abort that landed before the command was wrapped still kills it', async () => {
    const child = spawn('bash', ['-c', 'sleep 30'], { detached: true, stdio: 'ignore' })
    children.push(child)
    const controller = new AbortController()
    controller.abort()
    const command = wrapSpawn(child, controller.signal, 60_000, new TaskOutput(taskId(), null))
    const result = await Promise.race([command.result, Bun.sleep(3_000).then(() => null)])
    expect(result?.interrupted).toBe(true)
    expect(await exited(child, 3_000)).toBe(true)
  })

  test("an abort with reason 'interrupt' leaves the command running", async () => {
    const { controller, command } = startPiped('sleep 0.3; echo done')
    await Bun.sleep(50)
    controller.abort('interrupt')
    await Bun.sleep(50)
    expect(command.status).toBe('running')
    const result = await command.result
    expect(result).toMatchObject({ code: 0, stdout: 'done\n', interrupted: false })
    expect(command.status).toBe('completed')
  })

  test('a command past its timeout is stopped and says it timed out', async () => {
    const { child, command } = startPiped('echo partial >&2; sleep 30', { timeout: 300 })
    const result = await command.result
    expect(result.code).toBe(143)
    expect(result.interrupted).toBe(false)
    expect(result.stderr).toStartWith('Command timed out after ')
    expect(result.stderr).toEndWith(' partial\n')
    expect(command.status).toBe('killed')
    expect(await exited(child, 3_000)).toBe(true)
  })

  test('a timeout with nothing on stderr is reported on its own', async () => {
    const { command } = startPiped('sleep 30', { timeout: 150 })
    const result = await command.result
    expect(result.stderr).toMatch(/^Command timed out after \S+$/)
  })

  test('auto-background without a timeout callback still stops the command', async () => {
    const { command } = startPiped('sleep 30', { timeout: 150, autoBackground: true })
    const result = await command.result
    expect(result.code).toBe(143)
    expect(command.status).toBe('killed')
  })

  test('kill() followed at once by cleanup() still resolves the result', async () => {
    const { command } = startPiped('sleep 30')
    command.kill()
    command.cleanup()
    const result = await command.result
    expect(result.code).toBe(137)
    expect(command.pid).toBeUndefined()
  })
})

describe('ShellCommand — backgrounding', () => {
  test('without auto-background there is no onTimeout hook', () => {
    const { command } = startPiped('exit 0')
    expect(command.onTimeout).toBeUndefined()
  })

  test('the timeout hands the callback a background function instead of killing', async () => {
    const { command, taskOutput } = startPiped('echo early; sleep 0.6; echo late', {
      timeout: 150,
      autoBackground: true,
    })
    let backgrounded: boolean | undefined
    command.onTimeout?.(backgroundFn => {
      backgrounded = backgroundFn('bg-auto')
    })
    expect(await waitFor(() => backgrounded !== undefined, 3_000)).toBe(true)
    expect(backgrounded).toBe(true)
    expect(command.status).toBe('backgrounded')
    const result = await command.result
    expect(result.code).toBe(0)
    expect(result.backgroundTaskId).toBe('bg-auto')
    expect(command.status).toBe('completed')
    // Pipe mode spilled to disk on backgrounding, so stdout is the pointer to it.
    expect(result.stdout).toContain(`Full output saved to: ${taskOutput.path}`)
    expect(result.stderr).toBe('')
    await taskOutput.flush()
  })

  test('background() succeeds only while running', async () => {
    const { command, taskOutput } = startPiped('sleep 0.3')
    expect(command.background('bg-1')).toBe(true)
    expect(command.background('bg-2')).toBe(false)
    const result = await command.result
    expect(result.backgroundTaskId).toBe('bg-1')
    expect(command.background('bg-3')).toBe(false)
    await taskOutput.flush()
  })

  test('a backgrounded command is no longer stopped by its timeout', async () => {
    const { command, taskOutput } = startPiped('sleep 0.5; echo survived', { timeout: 150 })
    command.background('bg-timeout')
    const result = await command.result
    expect(result.code).toBe(0)
    expect(result.stderr).not.toContain('timed out')
    await taskOutput.flush()
  })

  test('a backgrounded command is no longer stopped by an abort', async () => {
    const { controller, command, taskOutput } = startPiped('sleep 0.3')
    command.background('bg-abort')
    controller.abort()
    await Bun.sleep(50)
    expect(command.status).toBe('backgrounded')
    const result = await command.result
    expect(result.code).toBe(0)
    await taskOutput.flush()
  })

  test('a backgrounded file-mode command keeps its output file', async () => {
    const { command, taskOutput } = startToFile('sleep 0.2; echo bg')
    expect(command.background('bg-file')).toBe(true)
    const result = await command.result
    expect(result.backgroundTaskId).toBe('bg-file')
    expect(result.stdout).toBe('bg\n')
    expect(result.outputFilePath).toBeUndefined()
    await Bun.sleep(50)
    expect(existsSync(taskOutput.path)).toBe(true)
  })
})

describe('ShellCommand — cleanup', () => {
  test('cleanup() after completion drops the buffers and the pid, and is idempotent', async () => {
    const { command, taskOutput } = startPiped('echo hi')
    await command.result
    command.cleanup()
    expect(command.pid).toBeUndefined()
    expect(await taskOutput.getStdout()).toBe('')
    expect(() => command.cleanup()).not.toThrow()
  })
})

describe('createAbortedCommand / createFailedCommand', () => {
  test('an aborted command is killed, interrupted, and cannot be backgrounded', async () => {
    const command = createAbortedCommand()
    expect(command.status).toBe('killed')
    expect(command.background('x')).toBe(false)
    expect(() => {
      command.kill()
      command.cleanup()
    }).not.toThrow()
    expect(await command.result).toEqual({
      code: 145,
      stdout: '',
      stderr: 'Command aborted before execution',
      interrupted: true,
      backgroundTaskId: undefined,
    })
  })

  test('an aborted command carries the given task id, stderr and code', async () => {
    const command = createAbortedCommand('bg-9', { stderr: 'stopped', code: 130 })
    expect(await command.result).toMatchObject({
      code: 130,
      stderr: 'stopped',
      interrupted: true,
      backgroundTaskId: 'bg-9',
    })
  })

  test('a failed command completes with code 1 and the pre-spawn error', async () => {
    const command = createFailedCommand('cwd was deleted')
    expect(command.status).toBe('completed')
    expect(command.background('x')).toBe(false)
    expect(() => {
      command.kill()
      command.cleanup()
    }).not.toThrow()
    expect(await command.result).toEqual({
      code: 1,
      stdout: '',
      stderr: 'cwd was deleted',
      interrupted: false,
      preSpawnError: 'cwd was deleted',
    })
  })
})

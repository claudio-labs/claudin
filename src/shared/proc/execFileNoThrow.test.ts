import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function importFreshExecFileNoThrowModule(): Promise<
  typeof import('./execFileNoThrow.ts')
> {
  return import(`./execFileNoThrow.ts?ts=${Date.now()}-${Math.random()}`)
}

test('execFileNoThrowWithCwd rejects shell-like executable names', async () => {
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const result = await execFileNoThrowWithCwd('claudin && whoami', [])

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe executable')
})

test('execFileNoThrowWithCwd rejects cwd values with control characters', async () => {
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const result = await execFileNoThrowWithCwd(process.execPath, ['--version'], {
    cwd: 'C:\\repo\nmalicious',
  })

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe working directory')
})

test('execFileNoThrowWithCwd rejects arguments with control characters', async () => {
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const result = await execFileNoThrowWithCwd(process.execPath, [
    '--version\nmalicious',
  ])

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe argument')
})

test('execFileNoThrowWithCwd rejects environment entries with control characters', async () => {
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()
  const result = await execFileNoThrowWithCwd(process.execPath, ['--version'], {
    env: {
      ...process.env,
      BAD_ENV: 'line1\nline2',
    },
  })

  expect(result.code).toBe(1)
  expect(result.error).toContain('Unsafe environment')
})

// One fresh instance for the behavior tests below: several suites
// mock.module this file, and a single instance keeps the coverage report
// adding up (a fresh import per test splits it across instances).
const exec = await importFreshExecFileNoThrowModule()

// `bun -e` scripts, so every case runs a real child process on any platform.
function script(source: string): [string, string[]] {
  return [process.execPath, ['-e', source]]
}

// Starts a grandchild that inherits the pipes and lives 3 s, and prints its
// pid so the test can kill it instead of leaving it to outlive the suite.
// unref() lets the child exit before it, the way xclip's parent does.
const SPAWN_PIPE_HOLDER =
  'const holder = require("node:child_process").spawn(process.execPath, ["-e", "setTimeout(() => {}, 3000)"], { stdio: ["ignore", "inherit", "inherit"] }); holder.unref(); console.log(holder.pid);'

function isAlive(pid: number): boolean {
  try {
    process.kill(pid, 0)
    return true
  } catch {
    return false
  }
}

function killPrintedPid(stdout: string): void {
  const pid = Number.parseInt(stdout, 10)
  if (Number.isInteger(pid) && isAlive(pid)) process.kill(pid)
}

describe('execFileNoThrowWithCwd running a process', () => {
  test('resolves stdout and code 0 on success', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      ...script('process.stdout.write("hi")'),
    )
    expect(result).toEqual({ stdout: 'hi', stderr: '', code: 0 })
  })

  test('keeps the output and names the exit code on failure', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      ...script('process.stdout.write("out"); process.stderr.write("bad"); process.exit(3)'),
    )
    expect(result).toEqual({ stdout: 'out', stderr: 'bad', code: 3, error: '3' })
  })

  test('drops the output on failure when preserveOutputOnError is false', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      ...script('process.stdout.write("out"); process.exit(2)'),
      { preserveOutputOnError: false },
    )
    expect(result).toEqual({ stdout: '', stderr: '', code: 2 })
  })

  test('names the signal when the process is killed by one', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      ...script('process.kill(process.pid, "SIGTERM")'),
    )
    expect(result.code).toBe(1)
    expect(result.error).toBe('SIGTERM')
  })

  test('writes input to stdin', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      ...script(
        'let d = ""; process.stdin.on("data", c => d += c).on("end", () => process.stdout.write(d.toUpperCase()))',
      ),
      { input: 'abc' },
    )
    expect(result.stdout).toBe('ABC')
  })

  test('stops at maxBuffer and keeps what it read', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      ...script('process.stdout.write("x".repeat(5000))'),
      { maxBuffer: 100 },
    )
    expect(result.code).toBe(1)
    expect(result.error).toBe('maxBuffer exceeded')
  })

  test('resolves a spawn failure instead of throwing', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      join(tmpdir(), 'claudin-no-such-binary', 'bin'),
      [],
    )
    expect(result.code).toBe(1)
    expect(result.error).toContain('ENOENT')
  })

  test('kills the process at its timeout', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      ...script('console.log(process.pid); setTimeout(() => {}, 10_000)'),
      { timeout: 200 },
    )
    expect(result.code).toBe(1)
    expect(result.error).toBe('Command timed out after 200ms')
    const pid = Number.parseInt(result.stdout, 10)
    for (let i = 0; i < 20 && isAlive(pid); i++) await Bun.sleep(50)
    expect(isAlive(pid)).toBe(false)
  })

  // Ported from openclaude, which resolves at the timeout itself: 'close'
  // waits for every holder of the pipes, so a grandchild that inherited
  // stdout kept the promise open for as long as it lived.
  test('resolves at its timeout even while a grandchild holds the pipes', async () => {
    const started = Date.now()
    const result = await exec.execFileNoThrowWithCwd(
      ...script(`${SPAWN_PIPE_HOLDER} setTimeout(() => {}, 10_000)`),
      { timeout: 200 },
    )
    try {
      expect(result.error).toBe('Command timed out after 200ms')
      expect(Date.now() - started).toBeLessThan(1500)
    } finally {
      killPrintedPid(result.stdout)
    }
  })

  // Found by the 2026-11-25 review round. xclip, xsel and wl-copy exit 0 at
  // once and leave a daemon holding the pipes; reporting their timeout as a
  // failure turned the clipboard probe off (osc.ts) and sent a screenshot copy
  // on to xsel with an empty stdin (screenshotClipboard.ts).
  test('reports the exit code of a child that exited while a grandchild holds the pipes', async () => {
    const result = await exec.execFileNoThrowWithCwd(
      ...script(SPAWN_PIPE_HOLDER),
      { timeout: 300 },
    )
    try {
      expect(result.code).toBe(0)
      expect(result.error).toBeUndefined()
      expect(result.stdout).toMatch(/^\d+\n$/)
    } finally {
      killPrintedPid(result.stdout)
    }
  })

  test('resolves an aborted process', async () => {
    const controller = new AbortController()
    const pending = exec.execFileNoThrowWithCwd(
      ...script('setTimeout(() => {}, 10_000)'),
      { abortSignal: controller.signal },
    )
    controller.abort()
    const result = await pending
    expect(result.code).toBe(1)
    expect(result.error).toContain('abort')
  })
})

describe('execFileNoThrow', () => {
  test('runs with its defaults and with useCwd off', async () => {
    expect(
      await exec.execFileNoThrow(...script('process.stdout.write("ok")')),
    ).toEqual({ stdout: 'ok', stderr: '', code: 0 })
    expect(
      await exec.execFileNoThrow(...script('process.stdout.write("ok")'), {
        useCwd: false,
      }),
    ).toEqual({ stdout: 'ok', stderr: '', code: 0 })
  })
})

test('execFileNoThrowWithCwd preserves Windows .cmd compatibility', async () => {
  if (process.platform !== 'win32') {
    return
  }
  const { execFileNoThrowWithCwd } = await importFreshExecFileNoThrowModule()

  const dir = mkdtempSync(join(tmpdir(), 'claudin-execfile-'))
  const file = join(dir, 'hello.cmd')
  writeFileSync(file, '@echo off\r\necho hello\r\n')

  const result = await execFileNoThrowWithCwd(file, [])

  expect(result.code).toBe(0)
  expect(result.stdout).toContain('hello')
})

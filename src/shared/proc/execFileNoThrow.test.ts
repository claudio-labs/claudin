import { describe, expect, test } from 'bun:test'
import { mkdtempSync, writeFileSync } from 'node:fs'
import { tmpdir } from 'node:os'
import { join } from 'node:path'

async function importFreshExecFileNoThrowModule() {
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
      ...script('setTimeout(() => {}, 10_000)'),
      { timeout: 200 },
    )
    expect(result.code).toBe(1)
    expect(result.error).toBe('Command timed out after 200ms')
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

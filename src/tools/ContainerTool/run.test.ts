import { describe, expect, test } from 'bun:test'
import {
  backgroundShellCommand,
  buildFailureText,
  formatLogs,
  formatRows,
  shapeOutput,
  summarizeBuild,
} from 'src/tools/ContainerTool/run.js'
import {
  argvToShellCommand,
  createProgressWatcher,
  runStreamingDocker,
  stripCarriageRewrites,
  type ExecImpl,
} from 'src/tools/ContainerTool/buildProgress.js'
import { parseBuildKit } from 'src/containers/build/parseBuildKit.js'
import { extractLogErrors } from 'src/containers/diagnostics/extractLogErrors.js'
import type { ContainerInfo } from 'src/containers/types.js'
import type { ContainerRow } from 'src/tools/ContainerTool/types.js'
import type { ExecResult, ShellCommand } from 'src/shared/proc/ShellCommand.js'
import type { ExecOptions } from 'src/shared/proc/Shell.js'
import { AbortError } from 'src/shared/errors.js'

function container(over: Partial<ContainerInfo> = {}): ContainerInfo {
  return {
    id: 'c0ffee',
    name: 'legendarr-legendarr-1',
    image: 'legendarr',
    state: 'running',
    status: 'Up 2 hours',
    health: 'none',
    exitCode: null,
    ports: [{ hostPort: 8000, containerPort: 8000, protocol: 'tcp' }],
    project: 'legendarr',
    service: 'legendarr',
    workingDir: '/home/dev/projects/legendarr',
    createdAt: null,
    ...over,
  }
}

describe('formatRows', () => {
  test('says so plainly when the project has no containers', () => {
    expect(formatRows([])).toBe('No containers for this project.')
  })

  test('lists name, status and published ports', () => {
    const rows: ContainerRow[] = [{ container: container(), diagnosis: null }]
    expect(formatRows(rows)).toBe('legendarr-legendarr-1  Up 2 hours  :8000')
  })

  test('a diagnosis rides along with the row that produced it', () => {
    const rows: ContainerRow[] = [
      {
        container: container({ state: 'exited', exitCode: 137 }),
        diagnosis: {
          kind: 'exit-signal',
          summary: 'legendarr-legendarr-1 was killed by SIGKILL',
          evidence: 'Exited (137)',
        },
      },
    ]
    expect(formatRows(rows)).toContain('! legendarr-legendarr-1 was killed by SIGKILL')
  })
})

describe('formatLogs', () => {
  test('a driver that cannot be read is reported, not rendered as empty', () => {
    // Reporting this as "no errors" would be a lie: we never saw the logs.
    const logs = extractLogErrors(
      'Error response from daemon: configured logging driver does not support reading',
    )
    expect(logs.kind).toBe('driver-unreadable')
    expect(formatLogs(logs, '')).toContain('logging driver')
  })

  test('distinguishes died-before-writing from never-wrote', () => {
    const died = extractLogErrors('', { containerState: 'exited' })
    expect(formatLogs(died, '')).toContain('died before writing')

    const quiet = extractLogErrors('', { containerState: 'running' })
    expect(formatLogs(quiet, '')).toBe('No logs written yet.')
  })

  test('keeps a Python traceback whole', () => {
    const raw = [
      'Traceback (most recent call last):',
      '  File "/app/main.py", line 12, in <module>',
      '    main()',
      '  File "/app/main.py", line 8, in main',
      '    raise ValueError("boom")',
      'ValueError: boom',
    ].join('\n')
    const out = formatLogs(extractLogErrors(raw), raw)
    // Every frame, including the terminating exception line — a half trace
    // reads as a different bug than the one that happened.
    expect(out).toContain('Traceback (most recent call last):')
    expect(out).toContain('line 8, in main')
    expect(out).toContain('ValueError: boom')
  })

  test('reports how many error blocks were elided', () => {
    const raw = Array.from({ length: 12 }, (_, i) => `ERROR thing ${i}`).join('\n')
    const logs = extractLogErrors(raw, { maxBlocks: 3 })
    expect(formatLogs(logs, raw)).toContain('9 more error blocks elided')
  })
})

describe('summarizeBuild', () => {
  test('a fully cached build is a no-op, not a clean build', () => {
    // A cached run compiled nothing; calling it a successful build would
    // describe a compilation that never happened.
    const summary = parseBuildKit(
      [
        '#1 [internal] load build definition from Dockerfile',
        '#1 DONE 0.0s',
        '#5 [2/3] RUN pip install -r requirements.txt',
        '#5 CACHED',
        '#6 [3/3] COPY . /app',
        '#6 CACHED',
      ].join('\n'),
    )
    expect(summary.allCached).toBe(true)
    expect(summarizeBuild(summary)).toContain('Up to date, nothing rebuilt')
  })

  test('a real build reports the cached/rebuilt split', () => {
    const summary = parseBuildKit(
      [
        '#5 [2/3] RUN pip install -r requirements.txt',
        '#5 DONE 12.4s',
        '#6 [3/3] COPY . /app',
        '#6 CACHED',
      ].join('\n'),
    )
    expect(summarizeBuild(summary)).toContain('rebuilt')
    expect(summarizeBuild(summary)).toContain('cached')
    expect(summarizeBuild(summary)).not.toContain('Up to date')
  })
})

describe('buildFailureText', () => {
  // The anti-tail property, which is the whole reason this path exists:
  // BuildKit interleaves steps, so the LAST lines of the log routinely belong
  // to a step other than the one that failed.
  const INTERLEAVED = [
    '#6 [2/4] RUN apt-get install -y build-essential',
    '#8 [3/4] RUN pip install -r requirements.txt',
    '#8 1.204 Collecting flask',
    '#8 2.881 ERROR: Could not find a version that satisfies flask==99.0',
    '#8 ERROR: process "/bin/sh -c pip install -r requirements.txt" did not complete successfully: exit code: 1',
    '#6 9.113 Setting up libavcodec59 ...',
    '#6 9.552 Setting up libstdc++-12-dev ...',
    '#6 CANCELED',
  ].join('\n')

  test('returns the failing step output, not the tail of the log', () => {
    // Prove the trap is real before asserting we avoid it.
    expect(INTERLEAVED.split('\n').slice(-3).join('\n')).toContain(
      'Setting up libavcodec59',
    )

    const text = buildFailureText(parseBuildKit(INTERLEAVED))
    expect(text).not.toBeNull()
    expect(text).toContain('Could not find a version that satisfies flask')
    expect(text).not.toContain('Setting up libavcodec59')
    expect(text).not.toContain('Setting up libstdc++-12-dev')
  })

  test('names the step, its command and the exit code', () => {
    const text = buildFailureText(parseBuildKit(INTERLEAVED)) ?? ''
    expect(text).toContain('#8')
    expect(text).toContain('pip install -r requirements.txt')
    expect(text).toContain('exit code 1')
  })

  test('a successful build has no failure text', () => {
    expect(buildFailureText(parseBuildKit('#1 DONE 0.0s'))).toBeNull()
  })
})

describe('shapeOutput', () => {
  test('leaves a body alone when no filter matches the command', () => {
    const raw = 'some output\n'
    expect(shapeOutput('docker wibble', raw).body).toBe(raw)
  })

  test('empty output is returned untouched', () => {
    expect(shapeOutput('docker ps', '').body).toBe('')
  })

  test('reuses the existing docker-ps filter rather than a new one', () => {
    const raw = [
      'CONTAINER ID   IMAGE       COMMAND                  CREATED       STATUS       PORTS                    NAMES',
      '0123456789ab   legendarr   "/init"                  2 hours ago   Up 2 hours   0.0.0.0:8000->8000/tcp, [::]:8000->8000/tcp   legendarr-legendarr-1',
      '0123456789cd   sonarr      "/init"                  2 hours ago   Up 2 hours   0.0.0.0:8989->8989/tcp, [::]:8989->8989/tcp   legendarr-sonarr-1',
    ].join('\n')
    const shaped = shapeOutput('docker ps', raw)
    // Only assert the contract: when it fires, it is the registry's own spec.
    if (shaped.filtered) {
      expect(shaped.filtered.name).toBe('docker-ps')
      expect(shaped.body.length).toBeLessThanOrEqual(raw.length * 0.7)
    } else {
      expect(shaped.body).toBe(raw)
    }
  })

  test('declines a summary that would not be meaningfully smaller', () => {
    // The ≤70% rule: a marker that discloses nothing is worse than no marker.
    const raw = 'CONTAINER ID   IMAGE\n'
    const shaped = shapeOutput('docker ps', raw)
    expect(shaped.filtered === undefined || shaped.body.length <= raw.length * 0.7).toBe(
      true,
    )
  })
})

// ---------------------------------------------------------------------------
// streaming: the live label and the idle watchdog
// ---------------------------------------------------------------------------

describe('stripCarriageRewrites', () => {
  test('keeps only what a terminal would have shown on a redrawn line', () => {
    expect(stripCarriageRewrites('a\rb\rc\nplain')).toBe('c\nplain')
  })

  test('text with no carriage returns is returned untouched', () => {
    const text = 'one\ntwo'
    expect(stripCarriageRewrites(text)).toBe(text)
  })
})

describe('argvToShellCommand', () => {
  test('quotes every element, so a path with spaces survives the shell', () => {
    const cmd = argvToShellCommand(['compose', '-f', 'my compose.yml', 'build'])
    expect(cmd).toBe(`'docker' 'compose' '-f' 'my compose.yml' 'build'`)
  })

  test('an embedded quote cannot break out — verified against a real shell', () => {
    // A substring assertion cannot tell safe escaping from unsafe: the POSIX
    // form `'\''` legitimately contains the very characters an injection
    // would. So round-trip each argument through bash and require it to come
    // back byte-identical — if the quoting leaked, printf would not.
    for (const nasty of [
      "a'; rm -rf /; echo '",
      '$(whoami)',
      '`id`',
      'plain value',
      'with "double" quotes',
    ]) {
      const quoted = argvToShellCommand([nasty]).replace(/^'docker' /, '')
      const out = Bun.spawnSync(['bash', '-c', `printf '%s' ${quoted}`])
      expect(out.stdout.toString()).toBe(nasty)
    }
  })
})

describe('backgroundShellCommand', () => {
  test('cds into the given cwd, so a backgrounded build cannot escape it', () => {
    // `exec` has NO cwd option — it runs in the session's persistent shell.
    expect(
      backgroundShellCommand(
        ['compose', '-f', 'my compose.yml', 'build'],
        '/home/dev/worktrees/agent-1',
      ),
    ).toBe(
      `cd '/home/dev/worktrees/agent-1' && 'docker' 'compose' '-f' 'my compose.yml' 'build'`,
    )
  })

  test('the cwd is quoted too — a repo path with a space is not two words', () => {
    expect(backgroundShellCommand(['ps'], '/home/dev/my repo')).toStartWith(
      `cd '/home/dev/my repo' &&`,
    )
  })
})

describe('createProgressWatcher', () => {
  /** A clock the test moves by hand, so a 3-minute threshold costs no time. */
  function clock(start = 0) {
    let t = start
    return { now: () => t, advance: (ms: number) => (t += ms) }
  }

  test('fires the watchdog once the output has been frozen past the limit', () => {
    const c = clock()
    const idle: number[] = []
    const w = createProgressWatcher({
      idleTimeoutMs: 1_000,
      now: c.now,
      onIdle: ms => idle.push(ms),
    })

    w.tick({ lastLines: '#5 [2/3] RUN pip install', totalBytes: 100 })
    c.advance(900)
    w.tick({ lastLines: '#5 [2/3] RUN pip install', totalBytes: 100 })
    expect(idle).toEqual([])

    c.advance(200)
    w.tick({ lastLines: '#5 [2/3] RUN pip install', totalBytes: 100 })
    expect(idle).toEqual([1_100])
    expect(w.idleSilentMs()).toBe(1_100)
  })

  test('growing output resets the silence — a busy build is never stopped', () => {
    const c = clock()
    const idle: number[] = []
    const w = createProgressWatcher({
      idleTimeoutMs: 1_000,
      now: c.now,
      onIdle: ms => idle.push(ms),
    })
    for (let i = 1; i <= 10; i++) {
      c.advance(900)
      // Bytes grow every tick: that is what "not silent" means. Measuring the
      // TEXT instead would stop a build that repeats one line.
      w.tick({ lastLines: '#5 working', totalBytes: i * 10 })
    }
    expect(idle).toEqual([])
  })

  test('fires only once, however long the silence lasts', () => {
    const c = clock()
    const idle: number[] = []
    const w = createProgressWatcher({
      idleTimeoutMs: 1_000,
      now: c.now,
      onIdle: ms => idle.push(ms),
    })
    w.tick({ lastLines: 'x', totalBytes: 1 })
    for (let i = 0; i < 5; i++) {
      c.advance(2_000)
      w.tick({ lastLines: 'x', totalBytes: 1 })
    }
    expect(idle).toHaveLength(1)
  })

  test('labels the current BuildKit step', () => {
    const c = clock()
    const labels: string[] = []
    const w = createProgressWatcher({
      idleTimeoutMs: 60_000,
      now: c.now,
      onIdle: () => {},
      onLabel: l => labels.push(l),
    })
    w.tick({
      lastLines: ['#8 [4/9] RUN pip install -r requirements.txt', '#8 1.2 Collecting flask'].join('\n'),
      totalBytes: 100,
    })
    expect(labels).toEqual(['[4/9] RUN pip install -r requirements.txt'])
  })

  test('says how long it has been quiet once the silence is worth mentioning', () => {
    const c = clock()
    const labels: string[] = []
    const w = createProgressWatcher({
      idleTimeoutMs: 60_000,
      now: c.now,
      onIdle: () => {},
      onLabel: l => labels.push(l),
    })
    w.tick({ lastLines: '#8 [4/9] RUN apt-get install -y build-essential', totalBytes: 100 })
    c.advance(12_000)
    w.tick({ lastLines: '#8 [4/9] RUN apt-get install -y build-essential', totalBytes: 100 })
    // An observation, not a diagnosis — apt-get is legitimately quiet.
    expect(labels[1]).toBe('silent for 12s')
  })

  test('currentSilentMs tracks the gap between ticks', () => {
    const c = clock()
    const w = createProgressWatcher({
      idleTimeoutMs: 60_000,
      now: c.now,
      onIdle: () => {},
    })
    w.tick({ lastLines: 'x', totalBytes: 5 })
    c.advance(3_000)
    expect(w.currentSilentMs()).toBe(3_000)
  })
})

describe('runStreamingDocker', () => {
  /**
   * A fake `exec` that hands the test the progress callback and the abort
   * signal, so the streaming path can be driven with no shell and no docker.
   */
  function harness(exitCode = 0) {
    let onProgress: ExecOptions['onProgress']
    let signal: AbortSignal | undefined
    let command = ''
    let resolveResult: (r: ExecResult) => void = () => {}
    const result = new Promise<ExecResult>(resolve => {
      resolveResult = resolve
    })
    const execImpl: ExecImpl = async (cmd, abortSignal, _shell, options) => {
      command = cmd
      signal = abortSignal
      onProgress = options?.onProgress
      // The real shell dies when the signal fires; that is what turns the
      // watchdog's abort into a finished run.
      abortSignal.addEventListener('abort', () => {
        resolveResult({ stdout: '', stderr: '', code: 143, interrupted: false })
      })
      return {
        result,
        background: () => false,
        kill: () => {},
        status: 'running',
        cleanup: () => {},
      } as unknown as ShellCommand
    }
    return {
      execImpl,
      tick: (lastLines: string, totalBytes: number) =>
        onProgress?.(lastLines, lastLines, 0, totalBytes, false),
      finish: () =>
        resolveResult({ stdout: '', stderr: '', code: exitCode, interrupted: false }),
      aborted: () => signal?.aborted ?? false,
      command: () => command,
    }
  }

  /** Let the pending `execImpl` promise settle before driving ticks. */
  const settle = () => new Promise(r => setTimeout(r, 0))

  test('a busy run finishes with no stall reported', async () => {
    const h = harness(0)
    const run = runStreamingDocker({
      argv: ['compose', 'build'],
      cwd: '/repo',
      timeoutMs: 600_000,
      idleTimeoutMs: 1_000,
      execImpl: h.execImpl,
      readOutput: async () => '#5 DONE 1.0s',
    })
    await settle()
    h.tick('#5 [1/2] FROM alpine', 10)
    h.finish()
    const out = await run
    expect(out.exitCode).toBe(0)
    expect(out.stall).toBeUndefined()
    expect(out.text).toBe('#5 DONE 1.0s')
  })

  test('a gap longer than the idle limit stops the run, and silentMs is the gap', async () => {
    let t = 0
    const h = harness()
    const run = runStreamingDocker({
      argv: ['compose', 'build'],
      cwd: '/repo',
      timeoutMs: 600_000,
      idleTimeoutMs: 1_000,
      execImpl: h.execImpl,
      readOutput: async () => '#8 [4/9] RUN apt-get install -y build-essential',
      now: () => t,
    })
    await settle()
    h.tick('#8 [4/9] RUN apt-get install -y build-essential', 100)
    expect(h.aborted()).toBe(false)

    t = 4_000
    h.tick('#8 [4/9] RUN apt-get install -y build-essential', 100)

    const out = await run
    // The run was actually STOPPED, not merely annotated.
    expect(h.aborted()).toBe(true)
    expect(out.stall?.reason).toBe('idle')
    expect(out.stall?.silentMs).toBe(4_000)
    expect(out.stall?.lastLine).toBe('#8 [4/9] RUN apt-get install -y build-essential')
  })

  test('hitting the wall ceiling is reported as a ceiling stall with a measured silence', async () => {
    let t = 0
    const h = harness(143)
    const run = runStreamingDocker({
      argv: ['compose', 'build'],
      cwd: '/repo',
      timeoutMs: 600_000,
      // High enough that the idle watchdog cannot fire — this is the ceiling.
      idleTimeoutMs: 900_000,
      execImpl: h.execImpl,
      readOutput: async () => 'last thing it said',
      now: () => t,
    })
    await settle()
    h.tick('working', 10)
    t = 2_500
    h.finish()
    const out = await run
    expect(out.stall?.reason).toBe('ceiling')
    // Measured, not assumed zero: a run can hit the ceiling while quiet.
    expect(out.stall?.silentMs).toBe(2_500)
  })

  test('runs in the given cwd, so a worktree sub-agent cannot build the main checkout', async () => {
    const h = harness(0)
    const run = runStreamingDocker({
      argv: ['compose', '-f', 'docker-compose.dev.yml', 'build', 'legendarr'],
      cwd: '/home/dev/worktrees/agent-1',
      timeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      execImpl: h.execImpl,
      readOutput: async () => '',
    })
    await settle()
    h.finish()
    await run
    expect(h.command()).toContain(`cd '/home/dev/worktrees/agent-1' &&`)
    expect(h.command()).toContain(`'docker' 'compose' '-f' 'docker-compose.dev.yml'`)
  })

  test('a shell that cannot start is a runError, not a crash', async () => {
    const out = await runStreamingDocker({
      argv: ['compose', 'build'],
      cwd: '/repo',
      timeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      execImpl: async () => {
        throw new Error('no suitable shell found')
      },
      readOutput: async () => '',
    })
    expect(out.runError).toContain('no suitable shell')
    expect(out.exitCode).toBe(1)
  })

  test('a user cancellation is rethrown, never rendered as a failed build', async () => {
    // An ESC reaches the same controller the watchdog uses. Swallowing it here
    // turned a cancellation into a diagnosed failure.
    const abort = new AbortController()
    abort.abort()
    const run = runStreamingDocker({
      argv: ['compose', 'build'],
      cwd: '/repo',
      abortSignal: abort.signal,
      timeoutMs: 1_000,
      idleTimeoutMs: 1_000,
      execImpl: async () => {
        throw new AbortError()
      },
      readOutput: async () => '',
    })
    await expect(run).rejects.toThrow()
  })

  test('a watchdog abort that REJECTS still reports the stall, not a runError', async () => {
    // The resolve-with-143 path has its own test above. This is the other one:
    // when the shell rejects on abort, the stall report has to survive the
    // catch or the "stopped after Ns silent" arm is unreachable.
    let t = 0
    let progress: ExecOptions['onProgress']
    const run = runStreamingDocker({
      argv: ['compose', 'build'],
      cwd: '/repo',
      timeoutMs: 600_000,
      idleTimeoutMs: 1_000,
      now: () => t,
      execImpl: async (_cmd, signal, _shell, options) => {
        progress = options?.onProgress
        return {
          result: new Promise<ExecResult>((_resolve, reject) => {
            signal.addEventListener('abort', () => reject(new AbortError()))
          }),
          background: () => false,
          kill: () => {},
          status: 'running',
          cleanup: () => {},
        } as unknown as ShellCommand
      },
      readOutput: async () => '',
    })
    await settle()
    progress?.('working', 'working', 0, 10, false)
    t = 4_000
    progress?.('working', 'working', 0, 10, false)

    const out = await run
    expect(out.stall?.reason).toBe('idle')
    expect(out.stall?.silentMs).toBe(4_000)
    expect(out.runError).toBeUndefined()
  })
})

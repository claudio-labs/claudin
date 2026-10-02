/**
 * Characterization of background shell tasks: how a running command becomes a
 * task row, how foreground commands get backgrounded (Ctrl+B, the
 * auto-background timer), the completion notice the model reads, and the
 * watchdog that speaks up when a background command sits on an interactive
 * prompt.
 *
 * Commands are real `/bin/sh` processes; the row is read from the app-state
 * store the caller owns, and notices from the pending-notification queue.
 */
import { afterEach, describe, expect, jest, test } from 'bun:test'
import { spawn } from 'node:child_process'
import { existsSync, readFileSync, statSync } from 'node:fs'
import { stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { generateTaskId } from 'src/agent/Task.js'
import { getCommandQueueSnapshot } from 'src/agent/messageQueueManager.js'
import { getTaskOutputPath } from 'src/agent/tasks/diskOutput.js'
import { registerAgentForeground, killAsyncAgent } from 'src/agent/tasks/LocalAgentTask/LocalAgentTask.js'
import {
  BACKGROUND_BASH_SUMMARY_PREFIX,
  backgroundAll,
  backgroundExistingForegroundTask,
  hasForegroundTasks,
  LocalShellTask,
  looksLikePrompt,
  markTaskNotified,
  registerForeground,
  spawnShellTask,
  unregisterForeground,
} from 'src/agent/tasks/LocalShellTask/LocalShellTask.js'
import { TaskOutput } from 'src/agent/tasks/TaskOutput.js'
import { wrapSpawn, type ShellCommand } from 'src/shared/proc/ShellCommand.js'
import { killTask } from 'src/agent/tasks/LocalShellTask/killShellTasks.js'
import {
  createTaskStore,
  isStubbedDescriptor,
  isolateTaskEnv,
  queuedTexts,
  type TaskStore,
  until,
} from 'src/agent/tasks/__testutils__/taskHarness.js'

const configDir = isolateTaskEnv('local-shell-char')

type ShellRow = {
  status: string
  isBackgrounded: boolean
  notified: boolean
  command: string
  shellCommand: ShellCommand | null
  result?: { code: number; interrupted: boolean }
  endTime?: number
  unregisterCleanup?: () => void
  kind?: string
  agentId?: string
  toolUseId?: string
}

const running: ShellCommand[] = []
afterEach(async () => {
  jest.useRealTimers()
  for (const cmd of running.splice(0)) {
    if (cmd.status === 'running' || cmd.status === 'backgrounded') cmd.kill()
  }
})

/** A real shell process in pipe mode, the way hooks and tests run commands. */
function startShell(script: string): ShellCommand {
  const output = new TaskOutput(generateTaskId('local_bash'), null)
  const child = spawn('/bin/sh', ['-c', script], {
    cwd: tmpdir(),
    env: { PATH: process.env.PATH ?? '/usr/bin:/bin', HOME: configDir() },
    stdio: ['ignore', 'pipe', 'pipe'],
  })
  const cmd = wrapSpawn(child, new AbortController().signal, 120_000, output)
  running.push(cmd)
  return cmd
}

/** A gate the shell waits on, so a test decides when the command exits. */
function gatedShell(code: number): { cmd: ShellCommand; release: () => Promise<void> } {
  const gate = `${configDir()}/gate-${Math.random().toString(36).slice(2)}`
  const cmd = startShell(`while [ ! -e '${gate}' ]; do sleep 0.02; done; echo released; exit ${code}`)
  return {
    cmd,
    release: async () => {
      await Bun.write(gate, '')
    },
  }
}

const row = (store: TaskStore, id: string) => store.task<ShellRow>(id)

function settledRow(store: TaskStore, id: string): Promise<void> {
  return until(() => {
    const status = row(store, id)?.status
    return status !== undefined && status !== 'running'
  }, `task ${id} to settle`)
}

async function settledNotices(count: number): Promise<string[]> {
  await until(() => queuedTexts().length >= count, `${count} notice(s)`)
  return queuedTexts()
}

describe('looksLikePrompt', () => {
  test('only the last non-blank line is judged', () => {
    const cases: Array<[string, boolean]> = [
      ['Proceed? (y/n)', true],
      ['Proceed? (Y/N) ', true],
      ['Install the package [Y/n]', true],
      ['Type (yes/no) to continue', true],
      ['Do you want to overwrite it?', true],
      ['Would you like to continue? ', true],
      ['Shall I go on?', true],
      ['Are you sure?', true],
      ['Ready to deploy?', true],
      ['Press Enter to continue', true],
      ['press any key', true],
      ['Continue?', true],
      ['File exists. Overwrite?', true],
      ['Overwrite existing file? (y/n)\n\n  \n', true],
      ['Are you sure?\ncompiling 3 of 10', false],
      ['Proceed (y/n)? y\ninstalling 4 packages', false],
      ['Do you know the way', false],
      ['Downloaded 45%', false],
      ['', false],
      ['git log -S needle', false],
    ]
    for (const [tail, expected] of cases) expect(looksLikePrompt(tail), JSON.stringify(tail)).toBe(expected)
  })
})

describe('the task descriptor', () => {
  test('the summary prefix the transcript collapse keys on', () => {
    expect(BACKGROUND_BASH_SUMMARY_PREFIX).toBe('Background command ')
  })

  test.skipIf(isStubbedDescriptor(LocalShellTask))('names its type and kills a running row through the store', async () => {
    expect(LocalShellTask.type).toBe('local_bash')
    expect(LocalShellTask.name).toBe('LocalShellTask')

    const store = createTaskStore()
    const { cmd } = gatedShell(0)
    const handle = await spawnShellTask({ command: 'wait', description: 'waiter', shellCommand: cmd }, { setAppState: store.set } as never)
    await LocalShellTask.kill(handle.taskId, store.set)
    expect(row(store, handle.taskId).status).toBe('killed')
    expect(row(store, handle.taskId).shellCommand).toBeNull()
    handle.cleanup?.()
  })
})

describe('spawning a background command', () => {
  test('the row starts running and backgrounded under the output id', async () => {
    const store = createTaskStore()
    const { cmd, release } = gatedShell(0)
    const handle = await spawnShellTask(
      { command: 'make all', description: 'build it', shellCommand: cmd, toolUseId: 'toolu_s', agentId: 'agent-7' as never, kind: 'bash' },
      { setAppState: store.set } as never,
    )
    expect(handle.taskId).toBe(cmd.taskOutput.taskId)
    const r = row(store, handle.taskId)
    expect({ status: r.status, isBackgrounded: r.isBackgrounded, command: r.command, toolUseId: r.toolUseId, agentId: r.agentId, kind: r.kind, notified: r.notified }).toEqual({
      status: 'running',
      isBackgrounded: true,
      command: 'make all',
      toolUseId: 'toolu_s',
      agentId: 'agent-7',
      kind: 'bash',
      notified: false,
    })
    expect(r.shellCommand).toBe(cmd)
    expect(cmd.status).toBe('backgrounded')
    await release()
    await settledRow(store, handle.taskId)
    handle.cleanup?.()
  })

  const endings: Array<{ code: number; status: string; summary: string }> = [
    { code: 0, status: 'completed', summary: 'Background command "build it" completed (exit code 0)' },
    { code: 3, status: 'failed', summary: 'Background command "build it" failed with exit code 3' },
  ]
  for (const { code, status, summary } of endings) {
    test(`exit ${code} settles the row as ${status} and queues one notice`, async () => {
      const store = createTaskStore()
      const { cmd, release } = gatedShell(code)
      const handle = await spawnShellTask(
        { command: 'make', description: 'build it', shellCommand: cmd, toolUseId: 'toolu_e', agentId: 'agent-e' as never },
        { setAppState: store.set } as never,
      )
      await release()
      await settledRow(store, handle.taskId)
      const r = row(store, handle.taskId)
      expect(r.status).toBe(status)
      expect(r.result).toEqual({ code, interrupted: false })
      expect(r.shellCommand).toBeNull()
      expect(r.unregisterCleanup).toBeUndefined()
      expect(typeof r.endTime).toBe('number')

      const [text] = await settledNotices(1)
      expect(text).toBe(
        [
          '<task-notification>',
          `<task-id>${handle.taskId}</task-id>`,
          '<tool-use-id>toolu_e</tool-use-id>',
          `<output-file>${getTaskOutputPath(handle.taskId)}</output-file>`,
          `<status>${status}</status>`,
          `<summary>${summary}</summary>`,
          '</task-notification>',
        ].join('\n'),
      )
      const [entry] = getCommandQueueSnapshot()
      expect([entry!.mode, entry!.priority, entry!.agentId] as unknown[]).toEqual(['task-notification', 'later', 'agent-e'])
      // What the command printed after it was backgrounded is on disk.
      await until(() => existsSync(getTaskOutputPath(handle.taskId)), 'the output file')
      expect(readFileSync(getTaskOutputPath(handle.taskId), 'utf8')).toContain('released')
      handle.cleanup?.()
    })
  }

  test('the description is XML-escaped in the summary, and no tool-use line without an id', async () => {
    const store = createTaskStore()
    const cmd = startShell('exit 0')
    const handle = await spawnShellTask({ command: 'x', description: 'a<b> & c', shellCommand: cmd }, { setAppState: store.set } as never)
    const [text] = await settledNotices(1)
    expect(text).toContain('<summary>Background command "a&lt;b&gt; &amp; c" completed (exit code 0)</summary>')
    expect(text).not.toContain('<tool-use-id>')
    handle.cleanup?.()
  })

  test('a killed command settles as killed with no notice', async () => {
    const store = createTaskStore()
    const { cmd } = gatedShell(0)
    const handle = await spawnShellTask({ command: 'x', description: 'doomed', shellCommand: cmd }, { setAppState: store.set } as never)
    killTask(handle.taskId, store.set)
    await cmd.result
    await Bun.sleep(50)
    expect(row(store, handle.taskId).status).toBe('killed')
    expect(row(store, handle.taskId).notified).toBe(true)
    expect(queuedTexts()).toEqual([])
    handle.cleanup?.()
  })

  test('a row marked notified before the exit gets no notice', async () => {
    const store = createTaskStore()
    const { cmd, release } = gatedShell(0)
    const handle = await spawnShellTask({ command: 'x', description: 'raced', shellCommand: cmd }, { setAppState: store.set } as never)
    markTaskNotified(handle.taskId, store.set)
    const marked = store.get()
    markTaskNotified(handle.taskId, store.set)
    expect(store.get()).toBe(marked)
    await release()
    await settledRow(store, handle.taskId)
    await Bun.sleep(50)
    expect(row(store, handle.taskId).status).toBe('completed')
    expect(queuedTexts()).toEqual([])
    handle.cleanup?.()
  })
})

describe('foreground commands', () => {
  test('registering keeps the row in the foreground and out of the background list', () => {
    const store = createTaskStore()
    const { cmd } = gatedShell(0)
    const id = registerForeground({ command: 'npm test', description: 'tests', shellCommand: cmd, agentId: 'agent-f' as never }, store.set, 'toolu_f')
    expect(id).toBe(cmd.taskOutput.taskId)
    const r = row(store, id)
    expect([r.status, r.isBackgrounded, r.command, r.toolUseId, r.agentId]).toEqual(['running', false, 'npm test', 'toolu_f', 'agent-f'])
    expect(hasForegroundTasks(store.get())).toBe(true)
    unregisterForeground(id, store.set)
    expect(store.get().tasks[id]).toBeUndefined()
    expect(hasForegroundTasks(store.get())).toBe(false)
  })

  test('unregistering runs the row cleanup and leaves backgrounded rows alone', async () => {
    const store = createTaskStore()
    const { cmd, release } = gatedShell(0)
    const id = registerForeground({ command: 'x', description: 'x', shellCommand: cmd }, store.set)
    let cleaned = 0
    store.set(prev => ({ ...prev, tasks: { ...prev.tasks, [id]: { ...prev.tasks[id]!, unregisterCleanup: () => cleaned++ } } }) as never)
    backgroundAll(store.get, store.set)
    const before = store.get()
    unregisterForeground(id, store.set)
    unregisterForeground('missing', store.set)
    expect(store.get()).toBe(before)
    await release()
    await settledRow(store, id)
    // The completion handler of a backgrounded row runs the cleanup once.
    expect(cleaned).toBe(1)
  })

  test('hasForegroundTasks counts foreground shells with a live command and foreground agents other than the main session', () => {
    const cases: Array<[string, Record<string, unknown>, boolean]> = [
      ['no tasks', {}, false],
      ['foreground shell', { b: { type: 'local_bash', status: 'running', isBackgrounded: false, shellCommand: {} } }, true],
      ['foreground shell, command gone', { b: { type: 'local_bash', status: 'running', isBackgrounded: false, shellCommand: null } }, false],
      ['backgrounded shell', { b: { type: 'local_bash', status: 'running', isBackgrounded: true, shellCommand: {} } }, false],
      ['foreground agent', { a: { type: 'local_agent', status: 'running', isBackgrounded: false, agentType: 'Explore' } }, true],
      ['backgrounded agent', { a: { type: 'local_agent', status: 'running', isBackgrounded: true, agentType: 'Explore' } }, false],
      ['main session', { a: { type: 'local_agent', status: 'running', isBackgrounded: false, agentType: 'main-session' } }, false],
      ['other type', { d: { type: 'dream', status: 'running', isBackgrounded: false } }, false],
    ]
    for (const [name, tasks, expected] of cases) {
      expect(hasForegroundTasks(createTaskStore(tasks).get()), name).toBe(expected)
    }
  })

  test('backgroundAll backgrounds every foreground shell and agent, then the shell reports on exit', async () => {
    const store = createTaskStore()
    const { cmd, release } = gatedShell(4)
    const id = registerForeground({ command: 'x', description: 'slow one', shellCommand: cmd, agentId: 'agent-b' as never }, store.set, 'toolu_b')
    const agent = registerAgentForeground({
      agentId: 'a-bgall',
      description: 'agent',
      prompt: 'p',
      selectedAgent: { agentType: 'Explore' } as never,
      setAppState: store.set,
    })
    try {
      backgroundAll(store.get, store.set)
      expect(row(store, id).isBackgrounded).toBe(true)
      expect(store.task<{ isBackgrounded: boolean }>('a-bgall').isBackgrounded).toBe(true)
      await agent.backgroundSignal
      expect(hasForegroundTasks(store.get())).toBe(false)

      await release()
      await settledRow(store, id)
      expect(row(store, id).status).toBe('failed')
      expect(row(store, id).result).toEqual({ code: 4, interrupted: false })
      const [text] = await settledNotices(1)
      expect(text).toContain('<tool-use-id>toolu_b</tool-use-id>')
      expect(text).toContain('<status>failed</status>')
      expect(text).toContain('<summary>Background command "slow one" failed with exit code 4</summary>')
      expect(String(getCommandQueueSnapshot()[0]!.agentId)).toBe('agent-b')
    } finally {
      killAsyncAgent('a-bgall', store.set)
    }
  })

  test('a row killed after backgrounding settles as killed and stays silent', async () => {
    const store = createTaskStore()
    const { cmd } = gatedShell(0)
    const id = registerForeground({ command: 'x', description: 'killed later', shellCommand: cmd }, store.set)
    backgroundAll(store.get, store.set)
    killTask(id, store.set)
    await cmd.result
    await Bun.sleep(50)
    expect(row(store, id).status).toBe('killed')
    expect(queuedTexts()).toEqual([])
  })

  test('backgroundAll skips a command that can no longer be backgrounded', async () => {
    const store = createTaskStore()
    const cmd = startShell('exit 0')
    await cmd.result
    const id = registerForeground({ command: 'x', description: 'already over', shellCommand: cmd }, store.set)
    backgroundAll(store.get, store.set)
    expect(row(store, id).isBackgrounded).toBe(false)
    unregisterForeground(id, store.set)
  })

  test('backgrounding an existing foreground row in place reports with its own description', async () => {
    const store = createTaskStore()
    const { cmd, release } = gatedShell(0)
    const id = registerForeground({ command: 'x', description: 'registered name', shellCommand: cmd, agentId: 'agent-x' as never }, store.set)
    expect(backgroundExistingForegroundTask(id, cmd, 'timer name', store.set, 'toolu_x')).toBe(true)
    expect(row(store, id).isBackgrounded).toBe(true)
    expect(Object.keys(store.get().tasks)).toEqual([id])
    await release()
    await settledRow(store, id)
    expect(row(store, id).status).toBe('completed')
    const [text] = await settledNotices(1)
    expect(text).toContain('<tool-use-id>toolu_x</tool-use-id>')
    expect(text).toContain('<summary>Background command "timer name" completed (exit code 0)</summary>')
    expect(String(getCommandQueueSnapshot()[0]!.agentId)).toBe('agent-x')
  })

  test('in-place backgrounding refuses a command that already finished', async () => {
    const store = createTaskStore()
    const cmd = startShell('exit 0')
    await cmd.result
    const id = registerForeground({ command: 'x', description: 'x', shellCommand: cmd }, store.set)
    expect(backgroundExistingForegroundTask(id, cmd, 'x', store.set)).toBe(false)
    expect(row(store, id).isBackgrounded).toBe(false)
    unregisterForeground(id, store.set)
  })

  test('in-place backgrounding of a row killed meanwhile ends silent', async () => {
    const store = createTaskStore()
    const { cmd } = gatedShell(0)
    const id = registerForeground({ command: 'x', description: 'x', shellCommand: cmd }, store.set)
    expect(backgroundExistingForegroundTask(id, cmd, 'x', store.set)).toBe(true)
    killTask(id, store.set)
    await cmd.result
    await Bun.sleep(50)
    expect(row(store, id).status).toBe('killed')
    expect(queuedTexts()).toEqual([])
  })
})

describe('the interactive-prompt watchdog', () => {
  /** Lets the real filesystem calls the watchdog made finish. */
  async function drainIo(path: string): Promise<void> {
    for (let i = 0; i < 6; i++) {
      await stat(path).catch(() => undefined)
      await new Promise(resolve => setImmediate(resolve))
    }
  }

  async function backgroundWithFakeClock(script: string, extra: Record<string, unknown> = {}) {
    const cmd = startShell(script)
    await until(() => cmd.taskOutput.totalBytes > 0, 'the first output')
    jest.useFakeTimers()
    const store = createTaskStore()
    const handle = await spawnShellTask(
      { command: 'installer', description: 'run installer', shellCommand: cmd, toolUseId: 'toolu_w', agentId: 'agent-w' as never, ...extra },
      { setAppState: store.set } as never,
    )
    const path = getTaskOutputPath(handle.taskId)
    for (let i = 0; i < 200 && !(existsSync(path) && statSync(path).size > 0); i++) await drainIo(path)
    const advance = async (seconds: number) => {
      for (let s = 0; s < seconds; s += 5) {
        jest.advanceTimersByTime(5_000)
        await drainIo(path)
      }
    }
    return { store, handle, path, cmd, advance }
  }

  test('a command silent on a prompt for 45 s is reported once, with its last output', async () => {
    const { handle, path, advance } = await backgroundWithFakeClock(`printf 'Overwrite existing file? (y/n) '; sleep 30`)
    await advance(40)
    expect(queuedTexts()).toEqual([])
    await advance(20)
    expect(queuedTexts()).toEqual([
      [
        '<task-notification>',
        `<task-id>${handle.taskId}</task-id>`,
        '<tool-use-id>toolu_w</tool-use-id>',
        `<output-file>${path}</output-file>`,
        '<summary>Background command "run installer" appears to be waiting for interactive input</summary>',
        '</task-notification>',
        'Last output:',
        'Overwrite existing file? (y/n)',
        '',
        'The command is likely blocked on an interactive prompt. Kill this task and re-run with piped input (e.g., `echo y | command`) or a non-interactive flag if one exists.',
      ].join('\n'),
    ])
    const [entry] = getCommandQueueSnapshot()
    expect([entry!.mode, entry!.priority, entry!.agentId] as unknown[]).toEqual(['task-notification', 'next', 'agent-w'])
    await advance(120)
    expect(queuedTexts()).toHaveLength(1)
  })

  test('a command that is only slow is never reported', async () => {
    const { advance } = await backgroundWithFakeClock(`printf 'compiling module 3 of 90\\n'; sleep 30`)
    await advance(150)
    expect(queuedTexts()).toEqual([])
  })

  test('a monitor command is not watched', async () => {
    const { advance } = await backgroundWithFakeClock(`printf 'Continue? (y/n) '; sleep 30`, { kind: 'monitor' })
    await advance(90)
    expect(queuedTexts()).toEqual([])
  })

  test('the watchdog stops once the command exits', async () => {
    const { store, handle, cmd, advance } = await backgroundWithFakeClock(`printf 'Continue? (y/n) '; sleep 30`)
    await advance(10)
    jest.useRealTimers()
    killTask(handle.taskId, store.set)
    await cmd.result
    await Bun.sleep(50)
    jest.useFakeTimers()
    await advance(90)
    expect(queuedTexts()).toEqual([])
  })
})

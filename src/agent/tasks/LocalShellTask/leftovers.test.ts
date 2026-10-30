import { afterEach, describe, expect, test } from 'bun:test'
import { spawn } from 'child_process'

import type { SetAppState } from 'src/agent/Task.js'

import { killTask } from 'src/agent/tasks/LocalShellTask/killShellTasks.js'
import { adoptLeftovers, describeLeftovers } from 'src/agent/tasks/LocalShellTask/leftovers.js'
import {
  findProcessGroup as findLeftovers,
  isAdoptLeftoversEnabled,
  type ProcessGroup as LeftoverGroup,
  type ProcessGroupDeps as LeftoverDeps,
  stopProcessGroup as killLeftovers,
} from 'src/shared/proc/processGroup.js'

type Row = { pid: number; pgid: number; command: string }

/** Deps over a fake process table; `signals` records every signal sent. */
function fakeDeps(rows: Row[]) {
  const signals: [number, NodeJS.Signals | 0][] = []
  let listed = 0
  const deps: LeftoverDeps = {
    signal: (pid, sig) => {
      signals.push([pid, sig])
      const group = pid < 0 ? -pid : null
      const exists = group === null ? rows.some(r => r.pid === pid) : rows.some(r => r.pgid === group)
      if (!exists) throw Object.assign(new Error('ESRCH'), { code: 'ESRCH' })
    },
    list: () => {
      listed++
      return rows
    },
  }
  return { deps, signals, listed: () => listed, rows }
}

function store() {
  const state = { current: { tasks: {} as Record<string, Record<string, unknown>> } }
  const setAppState: SetAppState = f => {
    state.current = f(state.current as never) as unknown as typeof state.current
  }
  return { state, setAppState }
}

const saved = process.env.CLAUDIN_ADOPT_LEFTOVERS
const strays: number[] = []
afterEach(() => {
  if (saved === undefined) delete process.env.CLAUDIN_ADOPT_LEFTOVERS
  else process.env.CLAUDIN_ADOPT_LEFTOVERS = saved
  for (const pid of strays.splice(0)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // already gone
    }
  }
})

describe('findLeftovers', () => {
  test('an empty group is nothing, and the process table is not even read', () => {
    const fake = fakeDeps([{ pid: 9, pgid: 9, command: 'other' }])
    expect(findLeftovers(500, fake.deps)).toBeNull()
    expect(fake.signals).toEqual([[-500, 0]])
    expect(fake.listed()).toBe(0)
  })

  test("a live group lists its members, and only its own", () => {
    const fake = fakeDeps([
      { pid: 501, pgid: 500, command: './ferrous-dns --config live.toml' },
      { pid: 502, pgid: 500, command: 'tail -f server.log' },
      { pid: 777, pgid: 777, command: 'unrelated' },
    ])
    expect(findLeftovers(500, fake.deps)).toEqual({
      pgid: 500,
      members: [
        { pid: 501, command: './ferrous-dns --config live.toml' },
        { pid: 502, command: 'tail -f server.log' },
      ],
    })
  })

  test('a group that empties between the probe and the listing is nothing', () => {
    const fake = fakeDeps([{ pid: 501, pgid: 500, command: 'x' }])
    const deps: LeftoverDeps = { signal: fake.deps.signal, list: () => [] }
    expect(findLeftovers(500, deps)).toBeNull()
  })
})

describe('killLeftovers', () => {
  const group: LeftoverGroup = { pgid: 500, members: [{ pid: 501, command: 'server' }] }

  test('signals the whole group while a recorded member is still in it', () => {
    const fake = fakeDeps([{ pid: 501, pgid: 500, command: 'server' }])
    expect(killLeftovers(group, fake.deps)).toBe(true)
    expect(fake.signals).toContainEqual([-500, 'SIGTERM'])
  })

  test('sends nothing once none of the recorded members is left: the group id may be reused', () => {
    const fake = fakeDeps([{ pid: 900, pgid: 500, command: 'someone else' }])
    expect(killLeftovers(group, fake.deps)).toBe(false)
    expect(fake.signals.filter(([, sig]) => sig !== 0)).toEqual([])
  })

  test('a group that ignores SIGTERM gets SIGKILL after the grace', async () => {
    const fake = fakeDeps([{ pid: 501, pgid: 500, command: 'server' }])
    expect(killLeftovers(group, fake.deps, 10)).toBe(true)
    await new Promise(r => setTimeout(r, 60))
    expect(fake.signals).toContainEqual([-500, 'SIGKILL'])
  })

  test('no SIGKILL for a group whose recorded members left during the grace', async () => {
    const fake = fakeDeps([{ pid: 501, pgid: 500, command: 'server' }])
    expect(killLeftovers(group, fake.deps, 10)).toBe(true)
    fake.rows.splice(0)
    await new Promise(r => setTimeout(r, 60))
    expect(fake.signals.map(([, sig]) => sig)).not.toContain('SIGKILL')
  })
})

describe('describeLeftovers', () => {
  test('names the processes, the task and how to stop it', () => {
    const one = describeLeftovers({ pgid: 5, members: [{ pid: 6, command: 'sleep 300' }] }, 'bk1')
    expect(one).toContain('pid 6 `sleep 300`')
    expect(one).toContain('task bk1')
    expect(one).toContain('TaskStop')

    const many = describeLeftovers(
      {
        pgid: 5,
        members: [
          { pid: 6, command: 'a' },
          { pid: 7, command: 'b' },
          { pid: 8, command: 'c' },
        ],
      },
      'bk2',
    )
    expect(many).toContain('pid 6 `a`, pid 7 `b` and 1 more')
  })

  test('a very long command line is cut', () => {
    const text = describeLeftovers({ pgid: 5, members: [{ pid: 6, command: `run ${'x'.repeat(500)}` }] }, 'bk3')
    expect(text.length).toBeLessThan(300)
  })
})

describe('isAdoptLeftoversEnabled', () => {
  test('off unless the switch is set', () => {
    delete process.env.CLAUDIN_ADOPT_LEFTOVERS
    expect(isAdoptLeftoversEnabled()).toBe(false)
    process.env.CLAUDIN_ADOPT_LEFTOVERS = '1'
    expect(isAdoptLeftoversEnabled()).toBe(true)
  })
})

describe('adoptLeftovers', () => {
  test('registers a running shell task that TaskStop stops by killing the group', () => {
    const fake = fakeDeps([{ pid: 501, pgid: 500, command: 'server' }])
    const s = store()
    const taskId = adoptLeftovers(
      { pgid: 500, members: [{ pid: 501, command: 'server' }] },
      { command: 'sh start.sh', description: 'start the server' },
      s.setAppState,
      { deps: fake.deps, pollMs: 60_000 },
    )
    const task = s.state.current.tasks[taskId]!
    expect(task.type).toBe('local_bash')
    expect(task.status).toBe('running')
    expect(task.isBackgrounded).toBe(true)
    expect(task.command).toBe('sh start.sh')

    killTask(taskId, s.setAppState)
    expect(fake.signals).toContainEqual([-500, 'SIGTERM'])
    expect(s.state.current.tasks[taskId]!.status).toBe('killed')
  })

  test('marks the task completed, quietly, once the group is gone on its own', async () => {
    const fake = fakeDeps([{ pid: 501, pgid: 500, command: 'server' }])
    const s = store()
    const taskId = adoptLeftovers(
      { pgid: 500, members: [{ pid: 501, command: 'server' }] },
      { command: 'sh start.sh', description: 'start the server' },
      s.setAppState,
      { deps: fake.deps, pollMs: 20 },
    )
    fake.rows.splice(0)
    const deadline = Date.now() + 2_000
    while (s.state.current.tasks[taskId]!.status === 'running' && Date.now() < deadline) await Bun.sleep(10)
    expect(s.state.current.tasks[taskId]!.status).toBe('completed')
    expect(s.state.current.tasks[taskId]!.notified).toBe(true)
  })
})

describe('with real processes', () => {
  test('a shell that exits leaving a sleep behind: found, then killed', async () => {
    const child = spawn('bash', ['-c', 'sleep 300 & echo $!; exit 0'], {
      detached: true,
      stdio: ['ignore', 'pipe', 'ignore'],
    })
    let out = ''
    child.stdout!.on('data', chunk => (out += String(chunk)))
    await new Promise(resolve => child.once('exit', resolve))
    const sleepPid = Number(out.trim())
    strays.push(sleepPid)

    const group = findLeftovers(child.pid!)
    expect(group?.members.map(m => m.pid)).toEqual([sleepPid])
    expect(group?.members[0]?.command).toContain('sleep 300')

    expect(killLeftovers(group!)).toBe(true)
    const deadline = Date.now() + 3_000
    while (findLeftovers(child.pid!) !== null && Date.now() < deadline) await Bun.sleep(25)
    expect(findLeftovers(child.pid!)).toBeNull()
  })
})

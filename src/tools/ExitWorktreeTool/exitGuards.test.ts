import { describe, expect, test } from 'bun:test'
import type { TaskState } from 'src/agent/tasks/types.js'
import type { LiveSession } from 'src/sessions/concurrentSessions.js'
import {
  describeRemoval,
  sessionInWorktreeRefusal,
  sessionsInWorktree,
  tasksInWorktreeRefusal,
  tasksStartedSince,
} from 'src/tools/ExitWorktreeTool/exitGuards.js'

const PATH = '/repo/.claudin/worktrees/feat'

function session(pid: number, cwd: string): LiveSession {
  return { pid, sessionId: `s-${pid}`, cwd }
}

function task(over: Partial<TaskState> & { type: TaskState['type'] }): TaskState {
  return {
    id: 't1',
    status: 'running',
    description: 'npm run dev',
    startTime: 2_000,
    outputFile: '/tmp/t1.out',
    outputOffset: 0,
    notified: false,
    ...over,
  } as TaskState
}

describe('sessionsInWorktree', () => {
  test('a session at the worktree or below it counts; a sibling with the same prefix does not', () => {
    const all = [
      session(1, PATH),
      session(2, `${PATH}/src`),
      session(3, `${PATH}-other`),
      session(4, '/repo'),
    ]
    expect(sessionsInWorktree(all, PATH).map(s => s.pid)).toEqual([1, 2])
  })
})

describe('tasksStartedSince', () => {
  test('running background work started after entering counts', () => {
    const tasks = {
      after: task({ id: 'after', type: 'local_bash', startTime: 2_000 }),
      before: task({ id: 'before', type: 'local_bash', startTime: 500 }),
      done: task({ id: 'done', type: 'local_agent', status: 'completed' }),
      foreground: task({ id: 'foreground', type: 'local_bash', isBackgrounded: false } as never),
      server: task({ id: 'server', type: 'mcp_server' }),
      container: task({ id: 'container', type: 'container' }),
      agent: task({ id: 'agent', type: 'local_agent', startTime: 1_000 }),
    }
    expect(tasksStartedSince(tasks, 1_000).map(t => t.id)).toEqual(['after', 'agent'])
  })
})

describe('refusal texts', () => {
  test('another session: names it, holds even with discard_changes, offers keep', () => {
    expect(sessionInWorktreeRefusal([session(42, PATH)], PATH)).toBe(
      `Another Claudin session (pid 42) is running in this worktree, though possibly idle, so this tool will not remove ${PATH}, even with discard_changes. If the user ends that session, call this tool again. Otherwise use action: "keep".`,
    )
    expect(sessionInWorktreeRefusal([session(42, PATH), session(43, PATH)], PATH)).toStartWith(
      '2 other Claudin sessions (pid 42, pid 43) are running in this worktree',
    )
    expect(sessionInWorktreeRefusal([session(42, PATH), session(43, PATH)], PATH)).toContain(
      'If the user ends those sessions',
    )
  })

  test('tasks: wait, or ask before stopping, and discard_changes removes the worktree under them', () => {
    expect(tasksInWorktreeRefusal([task({ type: 'local_bash' })])).toBe(
      'A background task started in this worktree may still be running there ("npm run dev"). Wait for it, or ask the user before stopping it, then call this tool again — or use action: "keep". discard_changes: true removes the worktree under it.',
    )
    expect(
      tasksInWorktreeRefusal([task({ type: 'local_bash' }), task({ type: 'local_agent', description: 'review' })]),
    ).toStartWith('2 background tasks started in this worktree may still be running there ("npm run dev", "review"). Wait for them')
  })
})

describe('describeRemoval', () => {
  test('worktree and branch removed', () => {
    expect(
      describeRemoval({ worktreePath: PATH, worktreeBranch: 'worktree-feat', cleanup: { removed: true, branch: 'deleted' } }),
    ).toBe(`Exited and removed worktree at ${PATH} and deleted its branch worktree-feat.`)
  })

  test('git refused the branch delete: the branch is named as kept, with git\'s reason', () => {
    expect(
      describeRemoval({
        worktreePath: PATH,
        worktreeBranch: 'main',
        cleanup: { removed: true, branch: 'refused', branchError: "error: Cannot delete branch 'main'" },
      }),
    ).toBe(
      `Exited and removed worktree at ${PATH}. Git refused to delete branch main, so it is still there: error: Cannot delete branch 'main'`,
    )
    expect(
      describeRemoval({ worktreePath: PATH, worktreeBranch: 'main', cleanup: { removed: true, branch: 'refused' } }),
    ).toEndWith('so it is still there.')
  })

  test('a hook removed its own worktree: the branch is the hook\'s business', () => {
    expect(describeRemoval({ worktreePath: PATH, hookBased: true, cleanup: { removed: true, branch: 'none' } })).toBe(
      `Exited and removed worktree at ${PATH}. A hook made it, so any branch it has was left to the hook.`,
    )
  })

  test('a WorktreeRemove hook that failed: still on disk, with the hook\'s output', () => {
    expect(
      describeRemoval({ worktreePath: PATH, hookBased: true, cleanup: { removed: false, removeError: 'remove refused', branch: 'none' } }),
    ).toBe(`Exited the worktree, but ${PATH} is still on disk: its WorktreeRemove hook failed (remove refused).`)
  })

  test('a git worktree with no branch recorded says only what was removed', () => {
    expect(describeRemoval({ worktreePath: PATH, cleanup: { removed: true, branch: 'none' } })).toBe(
      `Exited and removed worktree at ${PATH}.`,
    )
  })

  test('nothing removed: a hook-made worktree with no WorktreeRemove hook', () => {
    expect(describeRemoval({ worktreePath: PATH, hookBased: true, cleanup: { removed: false, branch: 'none' } })).toBe(
      `Exited the worktree, but ${PATH} is still on disk: a hook made this worktree, and no WorktreeRemove hook is configured to remove it.`,
    )
  })

  test('nothing removed: git could not remove it, with or without a reason', () => {
    expect(
      describeRemoval({ worktreePath: PATH, cleanup: { removed: false, removeError: 'fatal: locked', branch: 'none' } }),
    ).toBe(`Exited the worktree, but ${PATH} is still on disk: git could not remove it (fatal: locked).`)
    expect(describeRemoval({ worktreePath: PATH, cleanup: { removed: false, branch: 'none' } })).toBe(
      `Exited the worktree, but ${PATH} is still on disk: git could not remove it.`,
    )
  })
})
